import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import fs from "fs";
import { getConfig } from "../utils/config";
import { logger } from "../utils/logger";

interface VaultState {
  exists: boolean;
  balance: number;
  isActive: boolean;
  totalDeposits: number;
  totalWithdrawals: number;
  totalTrades: number;
  fetchedAt: number;
}

const CACHE_TTL_MS = 5_000;

// Derives and reads a per-user vault. PDA = ("user_vault", userPubkey).
// No JSON file needed — works for any user (devnet dev wallet, Phantom, or mainnet user)
// because the program ID and seed scheme are identical across clusters.
export class VaultReader {
  private connection: Connection;
  private vaultProgram: any;
  private userPubkey: PublicKey;
  private baseMint: PublicKey;
  private vaultPda: PublicKey;
  private vaultAta: PublicKey | null = null;
  private cached: VaultState | null = null;

  constructor(opts: {
    connection: Connection;
    /** Any keypair can sign reads — the dev wallet is fine even for other users' vaults. */
    signerForReads: Keypair;
    /** The user whose vault we're reading (derives PDA). */
    userPubkey: PublicKey;
    /** Base deposit token mint (fUSDC on devnet, real USDC on mainnet). */
    baseMint: PublicKey;
  }) {
    this.connection = opts.connection;
    this.userPubkey = opts.userPubkey;
    this.baseMint = opts.baseMint;

    const cfg = getConfig();
    const programIdStr = cfg.vault?.program_id;
    if (!programIdStr) {
      throw new Error("VaultReader: vault.program_id missing in settings.yaml");
    }
    const programId = new PublicKey(programIdStr);

    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_vault"), this.userPubkey.toBuffer()],
      programId,
    );
    this.vaultPda = pda;

    const provider = new AnchorProvider(
      opts.connection,
      new Wallet(opts.signerForReads),
      { commitment: "confirmed" },
    );
    const idl = JSON.parse(
      fs.readFileSync("programs-vault/target/idl/programs_vault.json", "utf-8"),
    );
    this.vaultProgram = new Program(idl, provider);

    logger.info({
      user: this.userPubkey.toBase58(),
      vaultPda: this.vaultPda.toBase58(),
      programId: programIdStr,
    }, "VaultReader initialized (per-user)");
  }

  private async getVaultAta(): Promise<PublicKey> {
    if (this.vaultAta) return this.vaultAta;
    const ata = await getAssociatedTokenAddress(this.baseMint, this.vaultPda, true);
    this.vaultAta = ata;
    return ata;
  }

  private async refresh(): Promise<VaultState> {
    const now = Date.now();
    if (this.cached && now - this.cached.fetchedAt < CACHE_TTL_MS) {
      return this.cached;
    }

    // Check if the vault account exists on-chain. If the user never called
    // createVault (e.g. fresh Phantom connection), fetch() throws.
    let vaultAccount: any;
    try {
      vaultAccount = await this.vaultProgram.account.userVault.fetch(this.vaultPda);
    } catch {
      const state: VaultState = {
        exists: false,
        balance: 0,
        isActive: false,
        totalDeposits: 0,
        totalWithdrawals: 0,
        totalTrades: 0,
        fetchedAt: now,
      };
      this.cached = state;
      return state;
    }

    // Vault exists — read token balance (ATA may not exist if no deposits yet).
    const ata = await this.getVaultAta();
    let balance = 0;
    try {
      const tokenBal = await this.connection.getTokenAccountBalance(ata);
      balance = parseFloat(tokenBal.value.uiAmountString ?? "0");
    } catch {
      balance = 0; // ATA not created yet → treat as 0
    }

    const state: VaultState = {
      exists: true,
      balance,
      isActive: vaultAccount.isActive === true,
      totalDeposits: Number(vaultAccount.totalDeposits),
      totalWithdrawals: Number(vaultAccount.totalWithdrawals),
      totalTrades: Number(vaultAccount.totalTrades),
      fetchedAt: now,
    };

    this.cached = state;
    return state;
  }

  async getBalance(): Promise<number> {
    const s = await this.refresh();
    return s.balance;
  }

  async isActive(): Promise<boolean> {
    const s = await this.refresh();
    return s.isActive;
  }

  async exists(): Promise<boolean> {
    const s = await this.refresh();
    return s.exists;
  }

  async getState(): Promise<{
    exists: boolean;
    balance: number;
    isActive: boolean;
    totalTrades: number;
  }> {
    const s = await this.refresh();
    return { exists: s.exists, balance: s.balance, isActive: s.isActive, totalTrades: s.totalTrades };
  }

  getVaultPda(): PublicKey {
    return this.vaultPda;
  }

  /** Returns the vault PDA's base-token ATA (the account where profit lands). */
  async getBaseTokenAta(): Promise<PublicKey> {
    return this.getVaultAta();
  }

  getUserPubkey(): PublicKey {
    return this.userPubkey;
  }

  invalidate(): void {
    this.cached = null;
  }

  getVaultProgram(): any {
    return this.vaultProgram;
  }
}
