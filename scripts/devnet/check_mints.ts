import { Connection, PublicKey } from "@solana/web3.js";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");

async function main() {
  const accounts = [
    ["pool1.tokenAVault", "BgmEY9kZjQkt1KnyKkhFo5qzX28bnw5JFLjnt5wC5nuh"],
    ["pool1.tokenBVault", "5LCtNf1yqBJnKGiLDc1c14G5nzEf8aETMGnTR1EmvYWf"],
    ["userTokenA (fUSDC)", "2SwdL43enBetG1Ytq4eUbi3GnciPdB64ZDCfkuvUDPDG"],
    ["userTokenB (fSOL)", "8ynn9KefhJvt4Aeebft2NRSDxAnq4UxDPURaG3Hz6qmF"],
    ["userTokenC (fRAY)", "HCvuE7WcqEHouPMaDfwGxToyJTjxguebtsgVEuTof4vT"],
    ["pool2.tokenAVault", "GtnAoQ9SZPrF6h578jSxTKcMZrw68sAXegNMqvHS2qkN"],
    ["pool2.tokenBVault", "75m6Ah4gonQr4gXCCPqC8ssMRcaVaDsge2eaHQZ6Z5Wb"],
    ["pool3.tokenAVault", "9uzm1rYdpGQaZnMbxnCzdxaabbgBAVbG3wN81etNkcxb"],
    ["pool3.tokenBVault", "CH4KuTZZ9TA7ivYpP3ZXsBZf4sMCGkesQVaru74XM1TV"],
  ];

  for (const [name, addr] of accounts) {
    const info = await connection.getParsedAccountInfo(new PublicKey(addr as string));
    const parsed = (info.value?.data as any)?.parsed?.info;
    console.log(`${name}: mint=${parsed?.mint}  balance=${parsed?.tokenAmount?.uiAmountString}`);
  }
}

main().catch(console.error);
