import { ethers } from "hardhat";

const DMH_ADDRESS = "0x57DeF08fdafA9Ae9428bCCE440c624CC83B1f6F8";
const TOKEN_ADDRESS = "0x8F1Bbd85d6099177e2E83aE4706a1350b203D18a";
const NFT_ADDRESS = "0xFa83790cA269A81f7AA63aB583996b15f31fe00b";
const BASE_CLAIM_FEE = ethers.parseEther("0.001");
const signerA = new ethers.Wallet(ethers.id("DMHv2 hardened testnet validation signer A"));
const signerB = new ethers.Wallet(ethers.id("DMHv2 hardened testnet validation signer B"));

async function retry<T>(operation: () => Promise<T>, attempts = 5): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 3_000));
    }
  }
  throw lastError;
}

async function confirmed(transaction: Promise<{ wait(): Promise<unknown>; hash: string }>) {
  const response = await transaction;
  await retry(() => response.wait());
  return response.hash;
}

async function main() {
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 968n) throw new Error("Live cycle is testnet-only");

  const [owner] = await ethers.getSigners();
  const configuredRecipient = process.env.FEE_RECIPIENT;
  if (!configuredRecipient || !ethers.isAddress(configuredRecipient)) {
    throw new Error("FEE_RECIPIENT must be configured for immutable verification");
  }
  const destination = ethers.getAddress(configuredRecipient);
  const dmh = await ethers.getContractAt("DeadMansHandV2", DMH_ADDRESS, owner);
  const token = await ethers.getContractAt("MockERC20", TOKEN_ADDRESS, owner);
  const nft = await ethers.getContractAt("MockERC721Enumerable", NFT_ADDRESS, owner);
  const salt = ethers.hexlify(ethers.randomBytes(32));
  const amount = ethers.parseUnits("1000", 18);

  if ((await dmh.baseClaimFee()) !== BASE_CLAIM_FEE) {
    throw new Error("Deployed base claim fee does not match the release configuration");
  }
  if (ethers.getAddress(await dmh.feeRecipient()) !== destination) {
    throw new Error("Deployed fee recipient does not match FEE_RECIPIENT");
  }

  const evidence: Record<string, string> = {};
  const abandonedVault = await retry(() => dmh.liveVaultOf(owner.address));
  if (abandonedVault !== 0n) {
    evidence.deactivateAbandonedVault = await confirmed(dmh.deactivateVault(abandonedVault));
  }
  evidence.mintToken = await confirmed(token.mint(owner.address, amount));
  evidence.mintNft = await confirmed(nft.mint(owner.address));
  evidence.createVault = await confirmed(
    dmh.createVault(signerA.address, signerB.address, salt, 60),
  );
  const vaultId = await dmh.vaultCount();
  evidence.registerToken = await confirmed(dmh.addToken(vaultId, TOKEN_ADDRESS, 0));
  evidence.registerNft = await confirmed(dmh.addToken(vaultId, NFT_ADDRESS, 1));
  evidence.approveToken = await confirmed(token.approve(DMH_ADDRESS, amount));
  evidence.approveNft = await confirmed(nft.setApprovalForAll(DMH_ADDRESS, true));

  process.stdout.write("Waiting for the one-minute inactivity gate...\n");
  const vault = await retry(() => dmh.getVault(vaultId));
  const deadline = Number(vault.lastPing + vault.inactivityPeriod);
  while (Math.floor(Date.now() / 1000) < deadline + 2) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }

  const freshVault = await retry(() => dmh.getVault(vaultId));
  const domain = {
    name: "DeadMansHandV2",
    version: "2",
    chainId: 968,
    verifyingContract: DMH_ADDRESS,
  };
  const types = {
    ClaimAuthorization: [
      { name: "vaultId", type: "uint256" },
      { name: "destination", type: "address" },
      { name: "nonce", type: "uint256" },
    ],
  };
  const authorization = { vaultId, destination, nonce: freshVault.nonce };
  const sigA = await signerA.signTypedData(domain, types, authorization);
  const sigB = await signerB.signTypedData(domain, types, authorization);
  const fee = await retry(() => dmh.currentClaimFee(vaultId, owner.address));
  evidence.claim = await confirmed(
    dmh.attemptClaim(vaultId, destination, sigA, sigB, { value: fee }),
  );

  const result = {
    chainId: network.chainId.toString(),
    vaultId: vaultId.toString(),
    owner: owner.address,
    destination,
    tokenReceived: ethers.formatUnits(await retry(() => token.balanceOf(destination)), 18),
    nftOwner: await retry(async () => nft.ownerOf(await nft.nextTokenId())),
    vaultNonce: (await retry(() => dmh.getVault(vaultId))).nonce.toString(),
    evidence,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
