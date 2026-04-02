use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions as ix_sysvar;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use sha2::{Sha256, Digest};

declare_id!("57qgGcR2anVG58VLymRe1vyui2eUjtefFPmsYFUN3acH");

/// Compute the 8-byte Anchor sighash for a given instruction name.
fn anchor_sighash(name: &str) -> [u8; 8] {
    let full = format!("global:{}", name);
    let hash = Sha256::digest(full.as_bytes());
    let mut out = [0u8; 8];
    out.copy_from_slice(&hash[..8]);
    out
}

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

    /// Borrow tokens from the flash vault.
    ///
    /// Atomicity is enforced via instruction introspection: this instruction
    /// scans the remaining instructions in the current transaction and requires
    /// that a matching `flash_repay` instruction exists later in the same tx.
    /// If the borrower omits repayment, the borrow itself reverts.
    pub fn flash_borrow(
        ctx: Context<FlashBorrow>,
        borrow_amount: u64,
    ) -> Result<()> {
        // ── Atomicity: verify a flash_repay instruction follows in this tx ──
        let ixs = ctx.accounts.instructions.to_account_info();
        let current_index = ix_sysvar::load_current_index_checked(&ixs)? as usize;
        let repay_disc = anchor_sighash("flash_repay");

        let mut found_repay = false;
        let mut check_index = current_index + 1;
        loop {
            match ix_sysvar::load_instruction_at_checked(check_index, &ixs) {
                Ok(ix) => {
                    if ix.program_id == crate::ID
                        && ix.data.len() >= 8
                        && ix.data[..8] == repay_disc
                    {
                        found_repay = true;
                        break;
                    }
                    check_index += 1;
                }
                Err(_) => break,
            }
        }
        require!(found_repay, FlashError::MissingRepayInstruction);

        // ── Transfer tokens from vault to borrower ──
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

    /// Repay a flash loan. Must appear in the same transaction as `flash_borrow`.
    pub fn flash_repay(
        ctx: Context<FlashRepay>,
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

        let config = &mut ctx.accounts.flash_config;
        config.total_loans = config.total_loans.saturating_add(1);

        msg!("Flash loan repaid: {} tokens (borrowed: {})", repay_amount, original_borrow);
        Ok(())
    }

    pub fn update_vault(
        ctx: Context<UpdateVault>,
    ) -> Result<()> {
        ctx.accounts.flash_config.vault = ctx.accounts.new_vault.key();
        msg!("Flash vault updated to {}", ctx.accounts.new_vault.key());
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
    #[msg("Transaction must include a flash_repay instruction after flash_borrow")]
    MissingRepayInstruction,
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
pub struct FlashBorrow<'info> {
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

    /// CHECK: Instructions sysvar for atomicity enforcement
    #[account(address = ix_sysvar::ID)]
    pub instructions: AccountInfo<'info>,
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
pub struct FlashRepay<'info> {
    #[account(
        mut,
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