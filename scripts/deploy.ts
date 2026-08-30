import { ethers } from "hardhat";

async function main() {
  const feeRecipient = process.env.FEE_RECIPIENT;
  if (!feeRecipient || !ethers.isAddress(feeRecipient)) {
    throw new Error("FEE_RECIPIENT must be a valid address");
  }

  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 968n) {
    throw new Error(`Deployment is testnet-only; connected chain is ${network.chainId}`);
  }

  const [deployer] = await ethers.getSigners();
  const baseClaimFee = ethers.parseEther("0.001");
  const factory = await ethers.getContractFactory("DeadMansHandV2");
  const dmh = await factory.deploy(baseClaimFee, feeRecipient);
  await dmh.waitForDeployment();

  const tokenFactory = await ethers.getContractFactory("MockERC20");
  const testToken = await tokenFactory.deploy();
  await testToken.waitForDeployment();

  const nftFactory = await ethers.getContractFactory("MockERC721Enumerable");
  const testNft = await nftFactory.deploy();
  await testNft.waitForDeployment();

  process.stdout.write(
    JSON.stringify(
      {
        chainId: network.chainId.toString(),
        deployer: deployer.address,
        feeRecipient,
        baseClaimFee: baseClaimFee.toString(),
        dmhAddress: await dmh.getAddress(),
        deploymentTx: dmh.deploymentTransaction()?.hash,
        testTokenAddress: await testToken.getAddress(),
        testTokenDeploymentTx: testToken.deploymentTransaction()?.hash,
        testNftAddress: await testNft.getAddress(),
        testNftDeploymentTx: testNft.deploymentTransaction()?.hash,
      },
      null,
      2,
    ) + "\n",
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
