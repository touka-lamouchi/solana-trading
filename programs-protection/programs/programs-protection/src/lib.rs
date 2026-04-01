use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("57qgGcR2anVG58VLymRe1vyui2eUjtefFPmsYFUN3acH");

#[program]
pub mod programs_protection {
    use super::*;

    pub fn initialize_flash_vault(
        ctx: Context<InitializeFlashVault>,
    ) -> Result<()> {
        let config = &mut ctx.accounts.flash_config;
        config.authority = ctx.accounts.authority.key();
        config.vault = ctx.accounts.vault.key();
        config.bump = ctx.bumps.flash_config;
        config.total_loans = 0;
        msg!("Flash vault initialized");
        Ok(())
    }

    pub fn execute_flash_loan(
        ctx: Context<FlashLoan>,
        borrow_amount: u64,
    ) -> Result<()> {
        let authority_seeds = &[
            b"flash_vault".as_ref(),
            ctx.accounts.flash_config.authority.as_ref(),
            &[ctx.accounts.flash_config.bump],
        ];
        let signer_seeds = &[&authority_seeds[..]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.borrower_token.to_account_info(),
                    authority: ctx.accounts.flash_config.to_account_info(),
                },
                signer_seeds,
            ),
            borrow_amount,
        )?;

        msg!("Flash loan issued: {} tokens", borrow_amount);
        Ok(())
    }

    pub fn update_vault(
        ctx: Context<UpdateVault>,
    ) -> Result<()> {
        ctx.accounts.flash_config.vault = ctx.accounts.new_vault.key();
        msg!("Flash vault updated to {}", ctx.accounts.new_vault.key());
        Ok(())
    }

    pub fn repay_flash_loan(
        ctx: Context<RepayFlashLoan>,
        repay_amount: u64,
        original_borrow: u64,
    ) -> Result<()> {
        require!(repay_amount >= original_borrow, FlashError::InsufficientRepayment);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.borrower_token.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.borrower.to_account_info(),
                },
            ),
            repay_amount,
        )?;

        msg!("Flash loan repaid: {} tokens (borrowed: {})", repay_amount, original_borrow);
        Ok(())
    }
}

#[account]
pub struct FlashConfig {
    pub authority: Pubkey,
    pub vault: Pubkey,
    pub bump: u8,
    pub total_loans: u64,
}

#[error_code]
pub enum FlashError {
    #[msg("Flash loan repayment is less than borrowed amount")]
    InsufficientRepayment,
}

#[derive(Accounts)]
pub struct InitializeFlashVault<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + 32 + 32 + 1 + 8,
        seeds = [b"flash_vault", authority.key().as_ref()],
        bump
    )]
    pub flash_config: Account<'info, FlashConfig>,

    #[account(
        init,
        payer = authority,
        token::mint = mint,
        token::authority = flash_config,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub mint: Account<'info, anchor_spl::token::Mint>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct FlashLoan<'info> {
    #[account(
        seeds = [b"flash_vault", flash_config.authority.as_ref()],
        bump = flash_config.bump
    )]
    pub flash_config: Account<'info, FlashConfig>,

    #[account(mut, constraint = vault.key() == flash_config.vault)]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub borrower_token: Account<'info, TokenAccount>,

    pub borrower: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct UpdateVault<'info> {
    #[account(
        mut,
        seeds = [b"flash_vault", flash_config.authority.as_ref()],
        bump = flash_config.bump,
        constraint = flash_config.authority == authority.key()
    )]
    pub flash_config: Account<'info, FlashConfig>,

    pub new_vault: Account<'info, TokenAccount>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct RepayFlashLoan<'info> {
    #[account(
        seeds = [b"flash_vault", flash_config.authority.as_ref()],
        bump = flash_config.bump
    )]
    pub flash_config: Account<'info, FlashConfig>,

    #[account(mut, constraint = vault.key() == flash_config.vault)]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub borrower_token: Account<'info, TokenAccount>,

    pub borrower: Signer<'info>,
    pub token_program: Program<'info, Token>,
}