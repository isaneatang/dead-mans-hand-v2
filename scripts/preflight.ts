import { ethers } from "hardhat";

const TESTNET_CHAIN_ID = 968n;
const PROBE_VALUE = 1n;

async function main() {
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== TESTNET_CHAIN_ID) {
    throw new Error(`Preflight is testnet-only; connected chain is ${network.chainId}`);
  }

  const configuredRecipient = process.env.FEE_RECIPIENT;
  if (!configuredRecipient || !ethers.isAddress(configuredRecipient)) {
    throw new Error("FEE_RECIPIENT must be a valid address");
  }
  const feeRecipient = ethers.getAddress(configuredRecipient);
  if (feeRecipient === ethers.ZeroAddress) {
    throw new Error("FEE_RECIPIENT must not be the zero address");
  }
  if ((await ethers.provider.getCode(feeRecipient)) !== "0x") {
    throw new Error("FEE_RECIPIENT must have no deployed code");
  }

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("DEPLOYER_PRIVATE_KEY must configure a signer");

  const deployerAddress = await deployer.getAddress();
  const deployerBalanceBefore = await ethers.provider.getBalance(deployerAddress);
  const recipientBalanceBefore = await ethers.provider.getBalance(feeRecipient);
  const probe = { from: deployerAddress, to: feeRecipient, value: PROBE_VALUE };
  const estimatedGas = BigInt(await ethers.provider.estimateGas(probe));
  const feeData = await ethers.provider.getFeeData();
  const upperGasPrice = feeData.maxFeePerGas ?? feeData.gasPrice;
  if (upperGasPrice === null) throw new Error("RPC did not provide a usable gas price");
  const requiredBalance = PROBE_VALUE + estimatedGas * upperGasPrice;
  if (deployerBalanceBefore < requiredBalance) {
    throw new Error("Deployer balance is insufficient for the 1 wei liveness probe and gas");
  }

  const transaction = await deployer.sendTransaction({
    to: feeRecipient,
    value: PROBE_VALUE,
    gasLimit: estimatedGas,
  });
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error("Native BOT liveness probe failed");

  const recipientBalanceAfter = await ethers.provider.getBalance(feeRecipient);
  const effectiveGasPrice = receipt.gasPrice;
  const gasCost = receipt.gasUsed * effectiveGasPrice;
  const sameAddress = deployerAddress === feeRecipient;
  const recipientBalanceAfterAccounting = sameAddress
    ? recipientBalanceAfter + gasCost
    : recipientBalanceAfter;
  if (recipientBalanceAfterAccounting < recipientBalanceBefore) {
    throw new Error("FEE_RECIPIENT balance decreased during the liveness probe");
  }

  const latestBlock = await ethers.provider.getBlock("latest");
  if (!latestBlock) throw new Error("RPC did not return the latest block");

  process.stdout.write(
    JSON.stringify(
      {
        check: "predeployment-liveness",
        chainId: network.chainId.toString(),
        deployer: deployerAddress,
        deployerBalanceBeforeWei: deployerBalanceBefore.toString(),
        requiredProbeBalanceWei: requiredBalance.toString(),
        feeRecipient,
        feeRecipientHasCode: false,
        feeRecipientIsDeployer: sameAddress,
        recipientBalanceBeforeWei: recipientBalanceBefore.toString(),
        recipientBalanceAfterWei: recipientBalanceAfter.toString(),
        recipientBalanceAfterAccountingWei: recipientBalanceAfterAccounting.toString(),
        probeValueWei: PROBE_VALUE.toString(),
        probeTransactionHash: receipt.hash,
        probeBlockNumber: receipt.blockNumber,
        probeGasUsed: receipt.gasUsed.toString(),
        probeEffectiveGasPriceWei: effectiveGasPrice.toString(),
        probeStatus: "confirmed",
        latestBlockNumber: latestBlock.number,
        latestBlockGasLimit: latestBlock.gasLimit.toString(),
      },
      null,
      2,
    ) + "\n",
  );
}

main().catch((error) => {
  let message = error instanceof Error ? error.message : "Unknown preflight failure";
  // Defensive redaction ensures configuration secrets cannot appear in unexpected provider errors.
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (privateKey) message = message.replaceAll(privateKey, "[REDACTED]");
  process.stderr.write(`${message.replace(/(?:0x)?[0-9a-fA-F]{64}/g, "[REDACTED]")}\n`);
  process.exitCode = 1;
});
