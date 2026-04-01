use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer, Mint};

declare_id!("CzpMFPxKuL2qSXiZUGmYEdY6LSbD1zdmK25ZNpjukR9K"); // placeholder, will update after build

#[program]
pub mod programs_amm {
    use super::*;

    // Initialize a new liquidity pool
    pub fn initialize_pool(ctx: Context<InitializePool>, seed: u8) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.token_a_mint = ctx.accounts.token_a_mint.key();
        pool.token_b_mint = ctx.accounts.token_b_mint.key();
        pool.token_a_vault = ctx.accounts.token_a_vault.key();
        pool.token_b_vault = ctx.accounts.token_b_vault.key();
        pool.authority = ctx.accounts.authority.key();
        pool.seed = seed;
        pool.bump = ctx.bumps.pool;
        Ok(())
    }

    // Add liquidity to the pool
    pub fn add_liquidity(ctx: Context<AddLiquidity>, amount_a: u64, amount_b: u64) -> Result<()> {
        // Transfer token A from user to vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_a.to_account_info(),
                    to: ctx.accounts.token_a_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount_a,
        )?;

        // Transfer token B from user to vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_b.to_account_info(),
                    to: ctx.accounts.token_b_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount_b,
        )?;

        Ok(())
    }

    // Swap token A for token B (or vice versa)
    pub fn swap(ctx: Context<Swap>, amount_in: u64, minimum_amount_out: u64, a_to_b: bool) -> Result<()> {
        let vault_a_amount = ctx.accounts.token_a_vault.amount;
        let vault_b_amount = ctx.accounts.token_b_vault.amount;

        // Constant product formula: x * y = k
        let (amount_out, from_vault, to_vault, user_from, user_to) = if a_to_b {
            let amount_out = calculate_output(amount_in, vault_a_amount, vault_b_amount);
            (
                amount_out,
                ctx.accounts.token_b_vault.to_account_info(),
                ctx.accounts.token_a_vault.to_account_info(),
                ctx.accounts.user_token_a.to_account_info(),
                ctx.accounts.user_token_b.to_account_info(),
            )
        } else {
            let amount_out = calculate_output(amount_in, vault_b_amount, vault_a_amount);
            (
                amount_out,
                ctx.accounts.token_a_vault.to_account_info(),
                ctx.accounts.token_b_vault.to_account_info(),
                ctx.accounts.user_token_b.to_account_info(),
                ctx.accounts.user_token_a.to_account_info(),
            )
        };

        require!(amount_out >= minimum_amount_out, AmmError::SlippageExceeded);
        require!(amount_out > 0, AmmError::ZeroOutput);

        // Transfer tokens from user to vault (user pays in)
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: user_from,
                    to: to_vault,
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount_in,
        )?;

        // Transfer tokens from vault to user (user receives out)
        let pool = &ctx.accounts.pool;
        let seeds = &[
            b"pool".as_ref(),
            pool.authority.as_ref(),
            &[pool.seed],
            &[pool.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: from_vault,
                    to: user_to,
                    authority: ctx.accounts.pool.to_account_info(),
                },
                signer_seeds,
            ),
            amount_out,
        )?;

        Ok(())
    }
}

// Constant product AMM formula: amount_out = (amount_in * reserve_out) / (reserve_in + amount_in)
// With 0.3% fee
fn calculate_output(amount_in: u64, reserve_in: u64, reserve_out: u64) -> u64 {
    let amount_in_with_fee = (amount_in as u128) * 997; // 0.3% fee
    let numerator = amount_in_with_fee * (reserve_out as u128);
    let denominator = (reserve_in as u128) * 1000 + amount_in_with_fee;
    (numerator / denominator) as u64
}

// Pool account — stores pool state
#[account]
pub struct Pool {
    pub token_a_mint: Pubkey,
    pub token_b_mint: Pubkey,
    pub token_a_vault: Pubkey,
    pub token_b_vault: Pubkey,
    pub authority: Pubkey,
    pub seed: u8,
    pub bump: u8,
}

// Error codes
#[error_code]
pub enum AmmError {
    #[msg("Output amount is below minimum (slippage exceeded)")]
    SlippageExceeded,
    #[msg("Output amount is zero")]
    ZeroOutput,
}

// Account validations for initialize_pool
#[derive(Accounts)]
#[instruction(seed: u8)]
pub struct InitializePool<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + 32 + 32 + 32 + 32 + 32 + 1 + 1,
        seeds = [b"pool", authority.key().as_ref(), &[seed]],
        bump
    )]
    pub pool: Account<'info, Pool>,

    pub token_a_mint: Account<'info, Mint>,
    pub token_b_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        token::mint = token_a_mint,
        token::authority = pool,
    )]
    pub token_a_vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = authority,
        token::mint = token_b_mint,
        token::authority = pool,
    )]
    pub token_b_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

// Account validations for add_liquidity
#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    #[account(
        mut,
        seeds = [b"pool", pool.authority.as_ref(), &[pool.seed]],
        bump = pool.bump
    )]
    pub pool: Account<'info, Pool>,

    #[account(mut, constraint = token_a_vault.key() == pool.token_a_vault)]
    pub token_a_vault: Account<'info, TokenAccount>,

    #[account(mut, constraint = token_b_vault.key() == pool.token_b_vault)]
    pub token_b_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_token_a: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_token_b: Account<'info, TokenAccount>,

    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

// Account validations for swap
#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(
        seeds = [b"pool", pool.authority.as_ref(), &[pool.seed]],
        bump = pool.bump
    )]
    pub pool: Account<'info, Pool>,

    #[account(mut, constraint = token_a_vault.key() == pool.token_a_vault)]
    pub token_a_vault: Account<'info, TokenAccount>,

    #[account(mut, constraint = token_b_vault.key() == pool.token_b_vault)]
    pub token_b_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_token_a: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_token_b: Account<'info, TokenAccount>,

    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}