import { Contract, JsonRpcProvider, type BrowserProvider, type ContractRunner, type Signer } from "ethers";
import { chains } from "../../config/chains";

export const TESTNET_CHAIN_ID = 968;
export const DMH_ADDRESS = chains[TESTNET_CHAIN_ID].dmhAddress!;

export const DMH_ABI = [
  "function createVault(address,address,bytes32,uint64) returns (uint256)",
  "function addToken(uint256,address,uint8)",
  "function removeToken(uint256,address)",
  "function ping(uint256)",
  "function deactivateVault(uint256)",
  "function attemptClaim(uint256,address,bytes,bytes) payable",
  "function vaultCount() view returns (uint256)",
  "function liveVaultOf(address) view returns (uint256)",
  "function vaultsOf(address) view returns (uint256[])",
  "function getVault(uint256) view returns (tuple(address owner,address signerA,address signerB,bytes32 vaultSalt,uint64 lastPing,uint64 inactivityPeriod,uint256 nonce,uint8 state))",
  "function getVaultTokens(uint256) view returns (tuple(address token,uint8 tokenType)[])",
  "function isClaimable(uint256) view returns (bool)",
  "function remainingTime(uint256) view returns (uint256)",
  "function currentClaimFee(uint256,address) view returns (uint256)",
  "function baseClaimFee() view returns (uint256)",
  "function callerCooldownUntil(uint256,address) view returns (uint64)",
  "function callerFailedAttempts(uint256,address) view returns (uint32)",
  "function feeRecipient() view returns (address)",
];

export const ERC20_ABI = [
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

export const ERC721_ABI = [
  "function setApprovalForAll(address,bool)",
  "function isApprovedForAll(address,address) view returns (bool)",
  "function supportsInterface(bytes4) view returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

export const provider = new JsonRpcProvider(chains[TESTNET_CHAIN_ID].rpcUrl, TESTNET_CHAIN_ID, { staticNetwork: true });

export function dmh(runner?: ContractRunner | null) {
  return new Contract(DMH_ADDRESS, DMH_ABI, runner ?? provider);
}

export function token(address: string, runner?: ContractRunner | null) {
  return new Contract(address, ERC20_ABI, runner ?? provider);
}

export function nft(address: string, runner?: ContractRunner | null) {
  return new Contract(address, ERC721_ABI, runner ?? provider);
}

export async function ensureTestnet(walletProvider: BrowserProvider) {
  const network = await walletProvider.getNetwork();
  if (network.chainId !== BigInt(TESTNET_CHAIN_ID)) throw new Error("Switch your wallet to BOT Chain Testnet (968).");
}

export async function waitFor(tx: { hash: string; wait(): Promise<unknown> }) {
  await tx.wait();
  return tx.hash;
}

export function explorerTx(hash: string) {
  return `${chains[TESTNET_CHAIN_ID].explorerUrl}/tx/${hash}`;
}

export function explorerAddress(address: string) {
  return `${chains[TESTNET_CHAIN_ID].explorerUrl}/address/${address}`;
}
