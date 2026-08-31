import { ethers } from "hardhat";

const DMH_ADDRESS = "0x57DeF08fdafA9Ae9428bCCE440c624CC83B1f6F8";
const TOKEN_ADDRESS = "0x8F1Bbd85d6099177e2E83aE4706a1350b203D18a";
const NFT_ADDRESS = "0xFa83790cA269A81f7AA63aB583996b15f31fe00b";
const VALIDATED_VAULT_ID = 2n;

async function confirmed(transaction: Promise<{ wait(): Promise<unknown>; hash: string }>) {
  const response = await transaction;
  await response.wait();
  return response.hash;
}

async function main() {
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 968n) throw new Error("Validation cleanup is testnet-only");

  const [owner] = await ethers.getSigners();
  const dmh = await ethers.getContractAt("DeadMansHandV2", DMH_ADDRESS, owner);
  const token = await ethers.getContractAt("MockERC20", TOKEN_ADDRESS, owner);
  const nft = await ethers.getContractAt("MockERC721Enumerable", NFT_ADDRESS, owner);
  const evidence: Record<string, string> = {};
  const vault = await dmh.getVault(VALIDATED_VAULT_ID);

  if (vault.owner === owner.address && vault.state !== 2n) {
    evidence.deactivateVault = await confirmed(dmh.deactivateVault(VALIDATED_VAULT_ID));
  }
  if ((await token.allowance(owner.address, DMH_ADDRESS)) !== 0n) {
    evidence.revokeToken = await confirmed(token.approve(DMH_ADDRESS, 0));
  }
  if (await nft.isApprovedForAll(owner.address, DMH_ADDRESS)) {
    evidence.revokeNft = await confirmed(nft.setApprovalForAll(DMH_ADDRESS, false));
  }

  process.stdout.write(`${JSON.stringify({ chainId: "968", owner: owner.address, evidence }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
