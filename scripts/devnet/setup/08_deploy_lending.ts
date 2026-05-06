/**
 * 08_deploy_lending.ts
 *
 * Deploys the programs-lending Anchor program to devnet and writes the
 * resulting program ID to config/devnet_lending.json.
 *
 * Run ONCE after `cd programs-lending && anchor build && anchor deploy`.
 * If you re-deploy with `anchor upgrade`, re-run this script so the ID
 * stays in sync with settings.yaml.
 *
 * Usage:
 *   npx ts-node scripts/devnet/setup/08_deploy_lending.ts
 *   npx ts-node scripts/devnet/setup/08_deploy_lending.ts --program-id=<NEW_ID>
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const ROOT = path.resolve(__dirname, "../../..");
const ANCHOR_TOML = path.join(ROOT, "programs-lending", "Anchor.toml");
const IDL_PATH = path.join(ROOT, "programs-lending", "target", "idl", "programs_lending.json");
const OUT_CONFIG = path.join(ROOT, "config", "devnet_lending.json");
const SETTINGS_PATH = path.join(ROOT, "config", "settings.yaml");

// Allow caller to override program ID (e.g. after anchor upgrade)
const argProgramId = process.argv.find(a => a.startsWith("--program-id="))?.split("=")[1];

function getProgramIdFromToml(): string {
  const toml = fs.readFileSync(ANCHOR_TOML, "utf-8");
  const match = toml.match(/programs_lending\s*=\s*"([^"]+)"/);
  if (!match) throw new Error("Could not find programs_lending ID in Anchor.toml");
  return match[1]!;
}

function updateAnchorToml(programId: string): void {
  let toml = fs.readFileSync(ANCHOR_TOML, "utf-8");
  toml = toml.replace(
    /programs_lending\s*=\s*"[^"]+"/,
    `programs_lending = "${programId}"`,
  );
  fs.writeFileSync(ANCHOR_TOML, toml, "utf-8");
  console.log(`Updated Anchor.toml with program ID: ${programId}`);
}

function updateLibRs(programId: string): void {
  const libPath = path.join(ROOT, "programs-lending", "programs", "programs-lending", "src", "lib.rs");
  let src = fs.readFileSync(libPath, "utf-8");
  src = src.replace(/declare_id!\("[^"]+"\)/, `declare_id!("${programId}")`);
  fs.writeFileSync(libPath, src, "utf-8");
  console.log(`Updated lib.rs with declare_id!("${programId}")`);
}

function updateSettingsYaml(programId: string): void {
  let yaml = fs.readFileSync(SETTINGS_PATH, "utf-8");
  if (yaml.includes("lending:")) {
    // Update existing program_id line
    yaml = yaml.replace(/program_id:\s*"[^"]*"(\s*#.*lending.*)?/, `program_id: "${programId}"`);
  } else {
    // Append lending section at end
    yaml += `\nlending:\n  program_id: "${programId}"\n`;
  }
  fs.writeFileSync(SETTINGS_PATH, yaml, "utf-8");
  console.log(`Updated settings.yaml lending.program_id = ${programId}`);
}

async function main() {
  // 1. Determine program ID
  let programId = argProgramId;
  if (!programId) {
    // Try to read from deployed keypair
    const keypairPath = path.join(
      ROOT,
      "programs-lending",
      "target",
      "deploy",
      "programs_lending-keypair.json",
    );
    if (fs.existsSync(keypairPath)) {
      try {
        const out = execSync(
          `solana address -k ${keypairPath}`,
          { encoding: "utf-8" },
        ).trim();
        programId = out;
        console.log(`Detected program ID from keypair: ${programId}`);
      } catch {
        console.warn("Could not read keypair — using Anchor.toml fallback");
        programId = getProgramIdFromToml();
      }
    } else {
      programId = getProgramIdFromToml();
      console.warn(`Keypair not found — using Anchor.toml ID: ${programId}`);
    }
  }

  // 2. Update all references
  updateAnchorToml(programId);
  updateLibRs(programId);
  updateSettingsYaml(programId);

  // 3. Write devnet_lending.json
  let idl: any = null;
  if (fs.existsSync(IDL_PATH)) {
    idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf-8"));
  }

  const config = {
    program_id: programId,
    deployed_at: new Date().toISOString(),
    idl: idl ?? null,
  };

  fs.writeFileSync(OUT_CONFIG, JSON.stringify(config, null, 2), "utf-8");
  console.log(`\nWrote ${OUT_CONFIG}`);
  console.log("\n=== Programs-lending deploy complete ===");
  console.log(`Program ID: ${programId}`);
  console.log(`\nNext steps:`);
  console.log(`  cd programs-lending && anchor build && anchor deploy --provider.cluster devnet`);
  console.log(`  npx ts-node scripts/devnet/setup/08_deploy_lending.ts`);
}

main().catch(e => { console.error(e); process.exit(1); });
