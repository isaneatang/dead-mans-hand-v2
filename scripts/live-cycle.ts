import { ethers } from "hardhat";

const DMH_ADDRESS = "0x2560Ad3B98bbF47d6c1A5A36ebC557F8e3d64f00";
const TOKEN_ADDRESS = "0xB0C6A739fF2458d27e8C9B9A719CE1859FE0B47F";
const NFT_ADDRESS = "0x7F7044782e51221C88dCD131ff685D109D7Cb3Cd";
const DESTINATION = "0x3B81167efca849a04524172b1A678A424F2e7C84";

async function confirmed(transaction: Promise<{ wait(): Promise<unknown>; hash: string }>) {
  const response = await transaction;
  await response.wait();
  return response.hash;
}

async function main() {
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 968n) throw new Error("Live cycle is testnet-only");

  const [owner] = await ethers.getSigners();
  const signerA = ethers.Wallet.createRandom();
  const signerB = ethers.Wallet.createRandom();
  const dmh = await ethers.getContractAt("DeadMansHandV2", DMH_ADDRESS, owner);
  const token = await ethers.getContractAt("MockERC20", TOKEN_ADDRESS, owner);
  const nft = await ethers.getContractAt("MockERC721Enumerable", NFT_ADDRESS, owner);
  const salt = ethers.hexlify(ethers.randomBytes(32));
  const amount = ethers.parseUnits("1000", 18);

  const evidence: Record<string, string> = {};
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
  const vault = await dmh.getVault(vaultId);
  const deadline = Number(vault.lastPing + vault.inactivityPeriod);
  while (Math.floor(Date.now() / 1000) < deadline + 2) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }

  const freshVault = await dmh.getVault(vaultId);
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
  const authorization = { vaultId, destination: DESTINATION, nonce: freshVault.nonce };
  const sigA = await signerA.signTypedData(domain, types, authorization);
  const sigB = await signerB.signTypedData(domain, types, authorization);
  const fee = await dmh.currentClaimFee(vaultId, owner.address);
  evidence.claim = await confirmed(
    dmh.attemptClaim(vaultId, DESTINATION, sigA, sigB, { value: fee }),
  );

  const result = {
    chainId: network.chainId.toString(),
    vaultId: vaultId.toString(),
    owner: owner.address,
    destination: DESTINATION,
    tokenReceived: ethers.formatUnits(await token.balanceOf(DESTINATION), 18),
    nftOwner: await nft.ownerOf(await nft.nextTokenId()),
    vaultNonce: (await dmh.getVault(vaultId)).nonce.toString(),
    evidence,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
