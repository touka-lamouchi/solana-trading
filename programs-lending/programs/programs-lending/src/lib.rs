use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Token, TokenAccount, Transfer, Mint};

declare_id!("AR6ubTCiWKJYbDaLXiXDWnXogaJCE3dqxpcqQEvUVp8f");

#[program]
pub mod programs_lending {
    use super::*;

    /// Register a new loan position. The borrower deposits collateral into a
    /// PDA-owned vault. Debt is recorded on-chain but no tokens are minted —
    /// this is a devnet simulation of a lending protocol.
    ///
    /// PDA seeds: ["loan_position", borrower, id]
    pub fn register_position(
        ctx: Context<RegisterPosition>,
        id: [u8; 8],
        collateral_amount: u64,
        debt_amount: u64,
        threshold_bps: u64,
    ) -> Result<()> {
        require!(collateral_amount > 0, LendingError::ZeroCollateral);
        require!(debt_amount > 0, LendingError::ZeroCollateral);

        // Transfer collateral from borrower into the position's vault ATA.
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.borrower_collateral.to_account_info(),
                    to: ctx.accounts.collateral_vault.to_account_info(),
                    authority: ctx.accounts.borrower.to_account_info(),
                },
            ),
            collateral_amount,
        )?;

        let pos = &mut ctx.accounts.position;
        pos.borrower = ctx.accounts.borrower.key();
        pos.collateral_mint = ctx.accounts.collateral_mint.key();
        pos.debt_mint = ctx.accounts.debt_mint.key();
        pos.collateral_vault = ctx.accounts.collateral_vault.key();
        pos.collateral_amount = collateral_amount;
        pos.debt_amount = debt_amount;
        pos.threshold_bps = threshold_bps;
        pos.is_liquidated = false;
        pos.bump = ctx.bumps.position;
        pos.id = id;

        msg!(
            "Position registered: borrower={} collateral={} debt={} threshold_bps={}",
            pos.borrower,
            collateral_amount,
            debt_amount,
            threshold_bps,
        );
        Ok(())
    }

    /// Liquidate an undercollateralized position. The caller (bot) passes the
    /// current collateral price in basis-point units relative to the debt token:
    ///
    ///   collateral_price_bps = price_of_1_collateral_in_debt_units × 10_000
    ///   e.g. 1 fSOL = 150 fUSDC  →  collateral_price_bps = 1_500_000
    ///
    /// Health check (integer arithmetic, no overflow up to u64 range):
    ///   health_bps = (collateral_amount × collateral_price_bps) / (debt_amount × 10_000)
    ///   liquidation allowed iff health_bps < threshold_bps
    ///
    /// On success all collateral is transferred from the position vault to the
    /// liquidator's token account and the position is marked liquidated.
    pub fn liquidate(ctx: Context<Liquidate>, collateral_price_bps: u64) -> Result<()> {
        let pos = &ctx.accounts.position;

        require!(!pos.is_liquidated, LendingError::AlreadyLiquidated);
        require!(pos.collateral_amount > 0, LendingError::ZeroCollateral);

        // On-chain health check using integer arithmetic.
        // health_bps = (collateral_amount * collateral_price_bps) / (debt_amount * 10_000)
        // We rearrange to avoid division: check cross-multiply instead.
        //   undercollateralized iff:
        //   collateral_amount * collateral_price_bps < threshold_bps * debt_amount * 10_000
        let lhs = (pos.collateral_amount as u128)
            .checked_mul(collateral_price_bps as u128)
            .ok_or(LendingError::MathOverflow)?;
        let rhs = (pos.threshold_bps as u128)
            .checked_mul(pos.debt_amount as u128)
            .ok_or(LendingError::MathOverflow)?
            .checked_mul(10_000u128)
            .ok_or(LendingError::MathOverflow)?;

        require!(lhs < rhs, LendingError::NotUndercollateralized);

        // Sign transfer with the position PDA seeds.
        let borrower_key = pos.borrower;
        let id = pos.id;
        let bump = pos.bump;
        let seeds = &[
            b"loan_position".as_ref(),
            borrower_key.as_ref(),
            id.as_ref(),
            &[bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let amount = pos.collateral_amount;

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.collateral_vault.to_account_info(),
                    to: ctx.accounts.liquidator_collateral.to_account_info(),
                    authority: ctx.accounts.position.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;

        let pos = &mut ctx.accounts.position;
        pos.is_liquidated = true;
        pos.collateral_amount = 0;

        msg!(
            "Liquidated: borrower={} amount={} liquidator={}",
            pos.borrower,
            amount,
            ctx.accounts.bot.key(),
        );
        Ok(())
    }
}

// ── Accounts ─────────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(id: [u8; 8])]
pub struct RegisterPosition<'info> {
    #[account(
        init,
        payer = borrower,
        space = LoanPosition::SIZE,
        seeds = [b"loan_position", borrower.key().as_ref(), id.as_ref()],
        bump,
    )]
    pub position: Account<'info, LoanPosition>,

    /// Vault ATA owned by the position PDA — holds the deposited collateral.
    #[account(
        init,
        payer = borrower,
        associated_token::mint = collateral_mint,
        associated_token::authority = position,
    )]
    pub collateral_vault: Account<'info, TokenAccount>,

    /// Borrower's source ATA for the collateral token.
    #[account(
        mut,
        associated_token::mint = collateral_mint,
        associated_token::authority = borrower,
    )]
    pub borrower_collateral: Account<'info, TokenAccount>,

    pub collateral_mint: Account<'info, Mint>,

    /// Debt mint is only recorded; no tokens are transferred on registration.
    pub debt_mint: Account<'info, Mint>,

    #[account(mut)]
    pub borrower: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Liquidate<'info> {
    #[account(
        mut,
        seeds = [b"loan_position", position.borrower.as_ref(), position.id.as_ref()],
        bump = position.bump,
    )]
    pub position: Account<'info, LoanPosition>,

    /// The position's collateral vault — source of the transfer.
    #[account(
        mut,
        associated_token::mint = position.collateral_mint,
        associated_token::authority = position,
    )]
    pub collateral_vault: Account<'info, TokenAccount>,

    /// Liquidator's token account for the collateral mint — receives the tokens.
    #[account(
        mut,
        token::mint = position.collateral_mint,
    )]
    pub liquidator_collateral: Account<'info, TokenAccount>,

    /// The bot wallet — signer, no constraint on-chain (devnet: anyone may liquidate).
    pub bot: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

// ── State ─────────────────────────────────────────────────────────────────────

#[account]
pub struct LoanPosition {
    pub borrower: Pubkey,         // 32
    pub collateral_mint: Pubkey,  // 32
    pub debt_mint: Pubkey,        // 32
    pub collateral_vault: Pubkey, // 32
    pub collateral_amount: u64,   // 8
    pub debt_amount: u64,         // 8
    pub threshold_bps: u64,       // 8  e.g. 12000 = health must stay ≥ 1.20
    pub is_liquidated: bool,      // 1
    pub bump: u8,                 // 1
    pub id: [u8; 8],              // 8
}

impl LoanPosition {
    pub const SIZE: usize = 8    // discriminator
        + 32 + 32 + 32 + 32      // pubkeys
        + 8 + 8 + 8              // u64s
        + 1 + 1                  // bools + bump
        + 8;                     // id
}

// ── Errors ────────────────────────────────────────────────────────────────────

#[error_code]
pub enum LendingError {
    #[msg("Position is not undercollateralized")]
    NotUndercollateralized,
    #[msg("Position has already been liquidated")]
    AlreadyLiquidated,
    #[msg("Collateral or debt amount cannot be zero")]
    ZeroCollateral,
    #[msg("Arithmetic overflow in health calculation")]
    MathOverflow,
}
