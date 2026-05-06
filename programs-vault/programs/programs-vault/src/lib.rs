use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_spl::token::{self, Token, TokenAccount, Transfer, Mint};
use anchor_spl::associated_token::AssociatedToken;

declare_id!("Gw6USbf98yEjLLFa9aTeNpQjAvRjuZ2576AVvu3B1g6H");

// AMM program ID (programs-amm). Must match the deployed AMM.
const AMM_PROGRAM_ID: Pubkey = pubkey!("CzpMFPxKuL2qSXiZUGmYEdY6LSbD1zdmK25ZNpjukR9K");

// Flash-loan program (programs-protection).
const FLASH_PROGRAM_ID: Pubkey = pubkey!("57qgGcR2anVG58VLymRe1vyui2eUjtefFPmsYFUN3acH");

// Anchor sighashes for flash_borrow / flash_repay (sha256("global:NAME")[0..8])
const FLASH_BORROW_DISC: [u8; 8] = [166, 221, 220, 25, 61, 73, 127, 240];
const FLASH_REPAY_DISC: [u8; 8]  = [182, 143, 19, 23, 39, 221, 184, 78];

// Anchor sighash for "global:swap" — discriminator the AMM expects on its swap ix.
// Computed offline: sha256("global:swap")[0..8]
const AMM_SWAP_DISCRIMINATOR: [u8; 8] = [248, 198, 158, 145, 225, 117, 135, 200];

#[program]
pub mod programs_vault {
    use super::*;

    /// Create a per-user vault. User calls this once via Phantom.
    pub fn create_vault(ctx: Context<CreateVault>, bot: Pubkey) -> Result<()> {
        let vault = &mut ctx.accounts.user_vault;
        vault.owner = ctx.accounts.user.key();
        vault.bot = bot;
        vault.bump = ctx.bumps.user_vault;
        vault.created_at = Clock::get()?.unix_timestamp;
        vault.total_deposits = 0;
        vault.total_withdrawals = 0;
        vault.total_trades = 0;
        vault.is_active = true;
        msg!("Vault created for user {} with bot {}", vault.owner, vault.bot);
        Ok(())
    }

    /// Deposit tokens into the user's vault.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);
        require!(ctx.accounts.user_vault.is_active, VaultError::VaultInactive);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token.to_account_info(),
                    to: ctx.accounts.vault_token.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        let vault = &mut ctx.accounts.user_vault;
        vault.total_deposits = vault.total_deposits.saturating_add(amount);
        msg!("Deposited {} tokens", amount);
        Ok(())
    }

    /// Withdraw tokens from the vault. Only the vault owner can call.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);
        let vault = &ctx.accounts.user_vault;
        require!(ctx.accounts.vault_token.amount >= amount, VaultError::InsufficientFunds);

        let owner_key = vault.owner;
        let seeds = &[b"user_vault".as_ref(), owner_key.as_ref(), &[vault.bump]];
        let signer_seeds = &[&seeds[..]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_token.to_account_info(),
                    to: ctx.accounts.user_token.to_account_info(),
                    authority: ctx.accounts.user_vault.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;

        let vault_mut = &mut ctx.accounts.user_vault;
        vault_mut.total_withdrawals = vault_mut.total_withdrawals.saturating_add(amount);
        msg!("Withdrew {} tokens", amount);
        Ok(())
    }

    /// Single-hop swap initiated by the authorized bot.
    /// The vault PDA is the swap authority — tokens move from vault_token_in
    /// (vault's ATA for input mint) → AMM → vault_token_out (vault's ATA for
    /// output mint). Tokens never touch the bot's wallet.
    pub fn bot_swap(
        ctx: Context<BotSwap>,
        amount_in: u64,
        minimum_amount_out: u64,
        a_to_b: bool,
    ) -> Result<()> {
        require!(amount_in > 0, VaultError::ZeroAmount);
        require!(ctx.accounts.user_vault.is_active, VaultError::VaultInactive);

        let token_program_ai = ctx.accounts.token_program.to_account_info();
        let amm_program_ai = ctx.accounts.amm_program.clone();
        let pool_ai = ctx.accounts.pool.clone();
        let pool_a_ai = ctx.accounts.token_a_vault.clone();
        let pool_b_ai = ctx.accounts.token_b_vault.clone();
        let vti = ctx.accounts.vault_token_a.to_account_info();
        let vto = ctx.accounts.vault_token_b.to_account_info();
        let uv_ai = ctx.accounts.user_vault.to_account_info();

        cpi_amm_swap(
            &amm_program_ai,
            &token_program_ai,
            &pool_ai,
            &pool_a_ai,
            &pool_b_ai,
            &vti,
            &vto,
            &uv_ai,
            &ctx.accounts.user_vault,
            amount_in,
            minimum_amount_out,
            a_to_b,
        )?;

        let vault_mut = &mut ctx.accounts.user_vault;
        vault_mut.total_trades = vault_mut.total_trades.saturating_add(1);
        msg!("Bot swap: amount_in={} a_to_b={}", amount_in, a_to_b);
        Ok(())
    }

    /// Triangular arb using vault capital as principal.
    ///
    /// Three swaps execute under the vault PDA's authority:
    ///   pool1: tokenA → tokenB
    ///   pool2: tokenB → tokenC
    ///   pool3: tokenC → tokenA
    ///
    /// All intermediate balances live in the vault's per-mint ATAs. The bot
    /// never holds any of the tokens; profit (if any) lands in vault_token_a
    /// because the round-trip ends in tokenA.
    ///
    /// `directions` = [a_to_b_pool1, a_to_b_pool2, a_to_b_pool3] — true means
    /// "swap from token_a_vault into token_b_vault" for that pool.
    pub fn bot_arb(
        ctx: Context<BotArb>,
        amount_in: u64,
        directions: [bool; 3],
    ) -> Result<()> {
        require!(amount_in > 0, VaultError::ZeroAmount);
        require!(ctx.accounts.user_vault.is_active, VaultError::VaultInactive);

        let bal_a_before = ctx.accounts.vault_token_a.amount;

        let token_program_ai = ctx.accounts.token_program.to_account_info();
        let amm_program_ai = ctx.accounts.amm_program.clone();
        let uv_ai = ctx.accounts.user_vault.to_account_info();
        let vt_a = ctx.accounts.vault_token_a.to_account_info();
        let vt_b = ctx.accounts.vault_token_b.to_account_info();
        let vt_c = ctx.accounts.vault_token_c.to_account_info();

        // Hop 1
        cpi_amm_swap(
            &amm_program_ai, &token_program_ai,
            &ctx.accounts.pool1, &ctx.accounts.pool1_vault_a, &ctx.accounts.pool1_vault_b,
            &vt_a, &vt_b, &uv_ai,
            &ctx.accounts.user_vault,
            amount_in, 1, directions[0],
        )?;
        ctx.accounts.vault_token_b.reload()?;
        let amount_b = ctx.accounts.vault_token_b.amount;

        // Hop 2
        cpi_amm_swap(
            &amm_program_ai, &token_program_ai,
            &ctx.accounts.pool2, &ctx.accounts.pool2_vault_a, &ctx.accounts.pool2_vault_b,
            &vt_b, &vt_c, &uv_ai,
            &ctx.accounts.user_vault,
            amount_b, 1, directions[1],
        )?;
        ctx.accounts.vault_token_c.reload()?;
        let amount_c = ctx.accounts.vault_token_c.amount;

        // Hop 3
        cpi_amm_swap(
            &amm_program_ai, &token_program_ai,
            &ctx.accounts.pool3, &ctx.accounts.pool3_vault_a, &ctx.accounts.pool3_vault_b,
            &vt_c, &vt_a, &uv_ai,
            &ctx.accounts.user_vault,
            amount_c, 1, directions[2],
        )?;

        ctx.accounts.vault_token_a.reload()?;
        let bal_a_after = ctx.accounts.vault_token_a.amount;
        require!(bal_a_after >= bal_a_before, VaultError::ArbNotProfitable);

        let profit = bal_a_after - bal_a_before;
        let vault_mut = &mut ctx.accounts.user_vault;
        vault_mut.total_trades = vault_mut.total_trades.saturating_add(1);
        msg!("Bot arb completed — profit: {} tokenA", profit);
        Ok(())
    }

    /// Triangular arb FUNDED BY A FLASH LOAN, all under vault PDA authority.
    /// Nested CPIs: flash_borrow (vault PDA = borrower) → swap×3 → flash_repay.
    /// Tokens never touch the bot wallet — vault PDA is the sole custodian
    /// throughout the entire transaction. Atomicity is guaranteed by Solana's
    /// nested-CPI rollback semantics (any failure reverts everything).
    pub fn bot_arb_via_flash(
        ctx: Context<BotArbViaFlash>,
        borrow_amount: u64,
        directions: [bool; 3],
    ) -> Result<()> {
        require!(borrow_amount > 0, VaultError::ZeroAmount);
        require!(ctx.accounts.user_vault.is_active, VaultError::VaultInactive);
        require_keys_eq!(*ctx.accounts.flash_program.key, FLASH_PROGRAM_ID, VaultError::WrongFlashProgram);

        let bal_a_before = ctx.accounts.vault_token_a.amount;

        let token_program_ai = ctx.accounts.token_program.to_account_info();
        let amm_program_ai = ctx.accounts.amm_program.clone();
        let flash_program_ai = ctx.accounts.flash_program.clone();
        let uv_ai = ctx.accounts.user_vault.to_account_info();
        let vt_a = ctx.accounts.vault_token_a.to_account_info();
        let vt_b = ctx.accounts.vault_token_b.to_account_info();
        let vt_c = ctx.accounts.vault_token_c.to_account_info();
        let owner_key = ctx.accounts.user_vault.owner;
        let bump = ctx.accounts.user_vault.bump;

        // === BORROW ===
        // CPI to programs_protection.flash_borrow with vault PDA as borrower.
        // The flash program checks that the borrower's program owner matches
        // VAULT_PROGRAM_ID and skips the top-level repay-introspection check.
        let mut borrow_data = Vec::with_capacity(16);
        borrow_data.extend_from_slice(&FLASH_BORROW_DISC);
        borrow_data.extend_from_slice(&borrow_amount.to_le_bytes());

        let borrow_accounts = vec![
            AccountMeta::new_readonly(*ctx.accounts.flash_config.key, false),
            AccountMeta::new(*ctx.accounts.flash_vault.key, false),
            AccountMeta::new(*vt_a.key, false),               // borrower_token = vault_token_a
            AccountMeta::new(*uv_ai.key, true),               // borrower = vault PDA, signed
            AccountMeta::new_readonly(*token_program_ai.key, false),
            AccountMeta::new_readonly(*ctx.accounts.instructions_sysvar.key, false),
        ];
        let borrow_ix = Instruction {
            program_id: *flash_program_ai.key,
            accounts: borrow_accounts,
            data: borrow_data,
        };

        let seeds = &[b"user_vault".as_ref(), owner_key.as_ref(), &[bump]];
        let signer_seeds = &[&seeds[..]];

        invoke_signed(
            &borrow_ix,
            &[
                ctx.accounts.flash_config.clone(),
                ctx.accounts.flash_vault.clone(),
                vt_a.clone(),
                uv_ai.clone(),
                token_program_ai.clone(),
                ctx.accounts.instructions_sysvar.clone(),
            ],
            signer_seeds,
        )?;

        // === SWAP × 3 ===
        ctx.accounts.vault_token_a.reload()?;
        let amount_after_borrow = ctx.accounts.vault_token_a.amount;
        let amount_in_hop1 = amount_after_borrow.saturating_sub(bal_a_before);

        cpi_amm_swap(
            &amm_program_ai, &token_program_ai,
            &ctx.accounts.pool1, &ctx.accounts.pool1_vault_a, &ctx.accounts.pool1_vault_b,
            &vt_a, &vt_b, &uv_ai,
            &ctx.accounts.user_vault,
            amount_in_hop1, 1, directions[0],
        )?;
        ctx.accounts.vault_token_b.reload()?;
        let amount_b = ctx.accounts.vault_token_b.amount;

        cpi_amm_swap(
            &amm_program_ai, &token_program_ai,
            &ctx.accounts.pool2, &ctx.accounts.pool2_vault_a, &ctx.accounts.pool2_vault_b,
            &vt_b, &vt_c, &uv_ai,
            &ctx.accounts.user_vault,
            amount_b, 1, directions[1],
        )?;
        ctx.accounts.vault_token_c.reload()?;
        let amount_c = ctx.accounts.vault_token_c.amount;

        cpi_amm_swap(
            &amm_program_ai, &token_program_ai,
            &ctx.accounts.pool3, &ctx.accounts.pool3_vault_a, &ctx.accounts.pool3_vault_b,
            &vt_c, &vt_a, &uv_ai,
            &ctx.accounts.user_vault,
            amount_c, 1, directions[2],
        )?;

        // === REPAY ===
        let mut repay_data = Vec::with_capacity(24);
        repay_data.extend_from_slice(&FLASH_REPAY_DISC);
        repay_data.extend_from_slice(&borrow_amount.to_le_bytes()); // repay_amount
        repay_data.extend_from_slice(&borrow_amount.to_le_bytes()); // original_borrow

        let repay_accounts = vec![
            AccountMeta::new(*ctx.accounts.flash_config.key, false),
            AccountMeta::new(*ctx.accounts.flash_vault.key, false),
            AccountMeta::new(*vt_a.key, false),
            AccountMeta::new(*uv_ai.key, true),
            AccountMeta::new_readonly(*token_program_ai.key, false),
        ];
        let repay_ix = Instruction {
            program_id: *flash_program_ai.key,
            accounts: repay_accounts,
            data: repay_data,
        };

        invoke_signed(
            &repay_ix,
            &[
                ctx.accounts.flash_config.clone(),
                ctx.accounts.flash_vault.clone(),
                vt_a.clone(),
                uv_ai.clone(),
                token_program_ai.clone(),
            ],
            signer_seeds,
        )?;

        // Profitability check: end balance ≥ start balance
        ctx.accounts.vault_token_a.reload()?;
        let bal_a_after = ctx.accounts.vault_token_a.amount;
        require!(bal_a_after >= bal_a_before, VaultError::ArbNotProfitable);

        let profit = bal_a_after - bal_a_before;
        let vault_mut = &mut ctx.accounts.user_vault;
        vault_mut.total_trades = vault_mut.total_trades.saturating_add(1);
        msg!("bot_arb_via_flash: borrowed {} repaid {} profit {}", borrow_amount, borrow_amount, profit);
        Ok(())
    }

    /// Change the authorized bot pubkey. Only vault owner can call.
    pub fn authorize_bot(ctx: Context<AuthorizeBot>, new_bot: Pubkey) -> Result<()> {
        let vault = &mut ctx.accounts.user_vault;
        vault.bot = new_bot;
        msg!("Bot updated to {}", new_bot);
        Ok(())
    }

    /// Pause/unpause the vault. Only vault owner can call.
    pub fn set_active(ctx: Context<SetActive>, active: bool) -> Result<()> {
        ctx.accounts.user_vault.is_active = active;
        msg!("Vault active = {}", active);
        Ok(())
    }
}

/// Helper: CPI into the AMM `swap` instruction with the user_vault PDA as the
/// "user" signer. Vault PDA seeds sign the inner transfer that pays in.
#[allow(clippy::too_many_arguments)]
fn cpi_amm_swap<'info>(
    amm_program: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    pool: &AccountInfo<'info>,
    pool_vault_a: &AccountInfo<'info>,
    pool_vault_b: &AccountInfo<'info>,
    vault_token_in: &AccountInfo<'info>,   // becomes user_token_a in AMM swap
    vault_token_out: &AccountInfo<'info>,  // becomes user_token_b
    user_vault_ai: &AccountInfo<'info>,    // the PDA that signs as "user"
    user_vault: &Account<'info, UserVault>,
    amount_in: u64,
    minimum_amount_out: u64,
    a_to_b: bool,
) -> Result<()> {
    require_keys_eq!(*amm_program.key, AMM_PROGRAM_ID, VaultError::WrongAmmProgram);

    // Build the swap instruction data: 8-byte disc + u64 + u64 + bool
    let mut data = Vec::with_capacity(25);
    data.extend_from_slice(&AMM_SWAP_DISCRIMINATOR);
    data.extend_from_slice(&amount_in.to_le_bytes());
    data.extend_from_slice(&minimum_amount_out.to_le_bytes());
    data.push(if a_to_b { 1 } else { 0 });

    // Account order MUST match the AMM's Swap accounts struct exactly:
    // pool, token_a_vault, token_b_vault, user_token_a, user_token_b, user, token_program
    let accounts = vec![
        AccountMeta::new_readonly(*pool.key, false),
        AccountMeta::new(*pool_vault_a.key, false),
        AccountMeta::new(*pool_vault_b.key, false),
        AccountMeta::new(*vault_token_in.key, false),
        AccountMeta::new(*vault_token_out.key, false),
        AccountMeta::new_readonly(*user_vault_ai.key, true), // signer = vault PDA
        AccountMeta::new_readonly(*token_program.key, false),
    ];

    let ix = Instruction {
        program_id: *amm_program.key,
        accounts,
        data,
    };

    let owner_key = user_vault.owner;
    let seeds = &[b"user_vault".as_ref(), owner_key.as_ref(), &[user_vault.bump]];
    let signer_seeds = &[&seeds[..]];

    invoke_signed(
        &ix,
        &[
            pool.clone(),
            pool_vault_a.clone(),
            pool_vault_b.clone(),
            vault_token_in.clone(),
            vault_token_out.clone(),
            user_vault_ai.clone(),
            token_program.clone(),
        ],
        signer_seeds,
    )?;
    Ok(())
}

// ── Vault account ──────────────────────────────────────────

#[account]
pub struct UserVault {
    pub owner: Pubkey,
    pub bot: Pubkey,
    pub bump: u8,
    pub created_at: i64,
    pub total_deposits: u64,
    pub total_withdrawals: u64,
    pub total_trades: u64,
    pub is_active: bool,
}

#[error_code]
pub enum VaultError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Insufficient funds in vault")]
    InsufficientFunds,
    #[msg("Vault is paused by the owner")]
    VaultInactive,
    #[msg("Unauthorized — only the vault owner can do this")]
    Unauthorized,
    #[msg("Triangular arb did not produce profit")]
    ArbNotProfitable,
    #[msg("AMM program ID does not match the expected one")]
    WrongAmmProgram,
    #[msg("Flash program ID does not match the expected one")]
    WrongFlashProgram,
}

// ── Accounts: CreateVault ──────────────────────────────────

#[derive(Accounts)]
pub struct CreateVault<'info> {
    #[account(
        init,
        payer = user,
        space = 8 + 106,
        seeds = [b"user_vault", user.key().as_ref()],
        bump
    )]
    pub user_vault: Account<'info, UserVault>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

// ── Accounts: Deposit ──────────────────────────────────────

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(
        mut,
        seeds = [b"user_vault", user.key().as_ref()],
        bump = user_vault.bump,
        has_one = owner @ VaultError::Unauthorized,
    )]
    pub user_vault: Account<'info, UserVault>,

    #[account(mut)]
    pub user_token: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = mint,
        associated_token::authority = user_vault,
    )]
    pub vault_token: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    #[account(mut)]
    pub user: Signer<'info>,

    /// CHECK: owner field on UserVault
    pub owner: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// ── Accounts: Withdraw ─────────────────────────────────────

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        mut,
        seeds = [b"user_vault", user.key().as_ref()],
        bump = user_vault.bump,
        constraint = user_vault.owner == user.key() @ VaultError::Unauthorized,
    )]
    pub user_vault: Account<'info, UserVault>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = user_vault,
    )]
    pub vault_token: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_token: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

// ── Accounts: BotSwap (single-hop, vault PDA signs) ────────

#[derive(Accounts)]
pub struct BotSwap<'info> {
    #[account(
        mut,
        seeds = [b"user_vault", user_vault.owner.as_ref()],
        bump = user_vault.bump,
        has_one = bot @ VaultError::Unauthorized,
    )]
    pub user_vault: Account<'info, UserVault>,

    /// CHECK: AMM pool account — validated by AMM program
    #[account(mut)]
    pub pool: AccountInfo<'info>,

    /// CHECK: AMM pool's token A vault — validated by AMM program
    #[account(mut)]
    pub token_a_vault: AccountInfo<'info>,

    /// CHECK: AMM pool's token B vault — validated by AMM program
    #[account(mut)]
    pub token_b_vault: AccountInfo<'info>,

    #[account(
        mut,
        constraint = vault_token_a.owner == user_vault.key() @ VaultError::Unauthorized,
    )]
    pub vault_token_a: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = vault_token_b.owner == user_vault.key() @ VaultError::Unauthorized,
    )]
    pub vault_token_b: Account<'info, TokenAccount>,

    #[account(mut)]
    pub bot: Signer<'info>,

    /// CHECK: must equal AMM_PROGRAM_ID; verified inside cpi_amm_swap
    pub amm_program: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// ── Accounts: BotArb (3-hop triangular arb under vault authority) ──

#[derive(Accounts)]
pub struct BotArb<'info> {
    #[account(
        mut,
        seeds = [b"user_vault", user_vault.owner.as_ref()],
        bump = user_vault.bump,
        has_one = bot @ VaultError::Unauthorized,
    )]
    pub user_vault: Box<Account<'info, UserVault>>,

    /// CHECK: pool 1 (A↔B). Validated by AMM CPI.
    #[account(mut)]
    pub pool1: AccountInfo<'info>,
    /// CHECK: pool1 token A vault
    #[account(mut)]
    pub pool1_vault_a: AccountInfo<'info>,
    /// CHECK: pool1 token B vault
    #[account(mut)]
    pub pool1_vault_b: AccountInfo<'info>,

    /// CHECK: pool 2 (B↔C)
    #[account(mut)]
    pub pool2: AccountInfo<'info>,
    /// CHECK: pool2 vault for hop 2 input
    #[account(mut)]
    pub pool2_vault_a: AccountInfo<'info>,
    /// CHECK: pool2 vault for hop 2 output
    #[account(mut)]
    pub pool2_vault_b: AccountInfo<'info>,

    /// CHECK: pool 3 (C↔A)
    #[account(mut)]
    pub pool3: AccountInfo<'info>,
    /// CHECK: pool3 vault for hop 3 input
    #[account(mut)]
    pub pool3_vault_a: AccountInfo<'info>,
    /// CHECK: pool3 vault for hop 3 output
    #[account(mut)]
    pub pool3_vault_b: AccountInfo<'info>,

    #[account(
        mut,
        constraint = vault_token_a.owner == user_vault.key() @ VaultError::Unauthorized,
    )]
    pub vault_token_a: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = vault_token_b.owner == user_vault.key() @ VaultError::Unauthorized,
    )]
    pub vault_token_b: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = vault_token_c.owner == user_vault.key() @ VaultError::Unauthorized,
    )]
    pub vault_token_c: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub bot: Signer<'info>,

    /// CHECK: must equal AMM_PROGRAM_ID
    pub amm_program: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// ── Accounts: BotArbViaFlash (3-hop arb funded by flash loan, vault PDA custodian) ──

#[derive(Accounts)]
pub struct BotArbViaFlash<'info> {
    #[account(
        mut,
        seeds = [b"user_vault", user_vault.owner.as_ref()],
        bump = user_vault.bump,
        has_one = bot @ VaultError::Unauthorized,
    )]
    pub user_vault: Box<Account<'info, UserVault>>,

    /// CHECK: flash_config PDA — validated by flash program CPI
    pub flash_config: AccountInfo<'info>,
    /// CHECK: flash vault token account — validated by flash program CPI
    #[account(mut)]
    pub flash_vault: AccountInfo<'info>,

    /// CHECK: pool 1
    #[account(mut)]
    pub pool1: AccountInfo<'info>,
    /// CHECK: pool1 vault A
    #[account(mut)]
    pub pool1_vault_a: AccountInfo<'info>,
    /// CHECK: pool1 vault B
    #[account(mut)]
    pub pool1_vault_b: AccountInfo<'info>,

    /// CHECK: pool 2
    #[account(mut)]
    pub pool2: AccountInfo<'info>,
    /// CHECK: pool2 vault A
    #[account(mut)]
    pub pool2_vault_a: AccountInfo<'info>,
    /// CHECK: pool2 vault B
    #[account(mut)]
    pub pool2_vault_b: AccountInfo<'info>,

    /// CHECK: pool 3
    #[account(mut)]
    pub pool3: AccountInfo<'info>,
    /// CHECK: pool3 vault A
    #[account(mut)]
    pub pool3_vault_a: AccountInfo<'info>,
    /// CHECK: pool3 vault B
    #[account(mut)]
    pub pool3_vault_b: AccountInfo<'info>,

    #[account(
        mut,
        constraint = vault_token_a.owner == user_vault.key() @ VaultError::Unauthorized,
    )]
    pub vault_token_a: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = vault_token_b.owner == user_vault.key() @ VaultError::Unauthorized,
    )]
    pub vault_token_b: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = vault_token_c.owner == user_vault.key() @ VaultError::Unauthorized,
    )]
    pub vault_token_c: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub bot: Signer<'info>,

    /// CHECK: must equal AMM_PROGRAM_ID
    pub amm_program: AccountInfo<'info>,
    /// CHECK: must equal FLASH_PROGRAM_ID
    pub flash_program: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,

    /// CHECK: instructions sysvar — required by flash_borrow's account validation
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,
}

// ── Accounts: AuthorizeBot ─────────────────────────────────

#[derive(Accounts)]
pub struct AuthorizeBot<'info> {
    #[account(
        mut,
        seeds = [b"user_vault", user.key().as_ref()],
        bump = user_vault.bump,
        constraint = user_vault.owner == user.key() @ VaultError::Unauthorized,
    )]
    pub user_vault: Account<'info, UserVault>,

    pub user: Signer<'info>,
}

// ── Accounts: SetActive ────────────────────────────────────

#[derive(Accounts)]
pub struct SetActive<'info> {
    #[account(
        mut,
        seeds = [b"user_vault", user.key().as_ref()],
        bump = user_vault.bump,
        constraint = user_vault.owner == user.key() @ VaultError::Unauthorized,
    )]
    pub user_vault: Account<'info, UserVault>,

    pub user: Signer<'info>,
}
