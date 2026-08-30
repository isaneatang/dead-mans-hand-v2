import {
  Contract,
  Interface,
  JsonRpcProvider,
  getAddress,
  id,
  type ContractRunner,
} from "ethers";
import { chains } from "../../config/chains";

export const TESTNET_CHAIN_ID = 968;
const config = chains[TESTNET_CHAIN_ID];

export const DMH_ADDRESS = config.dmhAddress ?? "";
export const dmhDeployed = DMH_ADDRESS !== "";

export const DMH_ABI = [
  "function createVault(address signerA,address signerB,bytes32 vaultSalt,uint64 inactivityPeriod) returns (uint256)",
  "function addToken(uint256 vaultId,address token,uint8 tokenType)",
  "function removeToken(uint256 vaultId,address token)",
  "function ping(uint256 vaultId)",
  "function deactivateVault(uint256 vaultId)",
  "function attemptClaim(uint256 vaultId,address destination,bytes sigA,bytes sigB) payable",
  "function vaultCount() view returns (uint256)",
  "function liveVaultOf(address owner) view returns (uint256)",
  "function vaultsOf(address owner) view returns (uint256[])",
  "function getVault(uint256 vaultId) view returns (tuple(address owner,address signerA,address signerB,bytes32 vaultSalt,uint64 lastPing,uint64 inactivityPeriod,uint256 nonce,uint8 state))",
  "function getVaultTokens(uint256 vaultId) view returns (tuple(address token,uint8 tokenType)[])",
  "function isClaimable(uint256 vaultId) view returns (bool)",
  "function remainingTime(uint256 vaultId) view returns (uint256)",
  "function currentClaimFee(uint256 vaultId,address caller) view returns (uint256)",
  "function callerCooldownUntil(uint256 vaultId,address caller) view returns (uint64)",
  "function baseClaimFee() view returns (uint256)",
  "function MAX_NFT_TRANSFERS_PER_CLAIM() view returns (uint256)",
  "function MIN_INACTIVITY_PERIOD() view returns (uint64)",
  "function MAX_INACTIVITY_PERIOD() view returns (uint64)",
  "event VaultCreated(uint256 indexed vaultId,address indexed owner,address signerA,address signerB,bytes32 vaultSalt,uint64 inactivityPeriod)",
  "event ClaimExecuted(uint256 indexed vaultId,address indexed destination,address indexed caller)",
  "event ClaimFailed(uint256 indexed vaultId,address indexed caller)",
  "event ERC20Swept(uint256 indexed vaultId,address indexed token,address indexed destination,uint256 amount)",
  "event ERC721Swept(uint256 indexed vaultId,address indexed token,address indexed destination,uint256 tokenId)",
  "event TokenSkipped(uint256 indexed vaultId,address indexed token,bytes32 reason)",
  "event SweepLimitReached(uint256 indexed vaultId)",
  "error VaultNotFound()",
  "error NotOwner()",
  "error VaultNotActive()",
  "error VaultIsDeactivated()",
  "error VaultNotYetClaimable()",
  "error CallerInCooldown()",
  "error IncorrectFee()",
  "error InvalidDestination()",
  "error TooManyTokens()",
  "error DuplicateToken()",
  "error TokenNotRegistered()",
  "error InvalidToken()",
  "error InvalidSigners()",
  "error InvalidPeriod()",
  "error InvalidVaultSalt()",
  "error LiveVaultAlreadyExists()",
  "error FeeForwardFailed()",
];

export const ERC20_ABI = [
  "function approve(address spender,uint256 amount) returns (bool)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

export const ERC721_ABI = [
  "function setApprovalForAll(address operator,bool approved)",
  "function isApprovedForAll(address owner,address operator) view returns (bool)",
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
];

export const ERC721_INTERFACE_ID = "0x80ac58cd";
export const ERC721_ENUMERABLE_INTERFACE_ID = "0x780e9d63";

export const dmhInterface = new Interface(DMH_ABI);
export const readProvider = new JsonRpcProvider(config.rpcUrl, TESTNET_CHAIN_ID, {
  staticNetwork: true,
});

export function dmh(runner?: ContractRunner | null) {
  return new Contract(DMH_ADDRESS, DMH_ABI, runner ?? readProvider);
}

export function erc20(address: string, runner?: ContractRunner | null) {
  return new Contract(address, ERC20_ABI, runner ?? readProvider);
}

export function erc721(address: string, runner?: ContractRunner | null) {
  return new Contract(address, ERC721_ABI, runner ?? readProvider);
}

export function explorerTx(hash: string) {
  return `${config.explorerUrl}/tx/${hash}`;
}

export function explorerAddress(address: string) {
  return `${config.explorerUrl}/address/${address}`;
}

export type DiscoveredAsset = {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  balance: bigint;
  /** 0 = ERC-20, 1 = enumerable ERC-721, -1 = not sweepable by DMH. */
  kind: number;
  blocked?: string;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Reads the wallet's token list from the public Blockscout explorer.
 * Opt-in only: it sends the owner address to a third party, so it is never automatic.
 * Never send phrases, keys or signatures here.
 */
export async function discoverAssets(owner: string): Promise<DiscoveredAsset[]> {
  const response = await fetch(
    `${config.explorerUrl}/api/v2/addresses/${owner}/token-balances`,
    { headers: { accept: "application/json" } },
  );
  if (!response.ok) {
    throw new Error("The explorer did not answer. Add asset addresses manually instead.");
  }

  const rows = (await response.json()) as any[];
  const merged = new Map<string, DiscoveredAsset>();

  for (const row of rows ?? []) {
    const info = row?.token;
    if (!info?.address) continue;
    const address = getAddress(String(info.address));
    const type = String(info.type ?? "").toUpperCase();
    const existing = merged.get(address);
    const balance = BigInt(row.value ?? "0");

    if (existing) {
      existing.balance += balance;
      continue;
    }

    const asset: DiscoveredAsset = {
      address,
      name: String(info.name ?? "Unnamed asset"),
      symbol: String(info.symbol ?? "?"),
      decimals: Number(info.decimals ?? 18) || 0,
      balance,
      kind: type === "ERC-20" ? 0 : type === "ERC-721" ? 1 : -1,
    };

    if (asset.kind === -1) {
      asset.blocked = type === "ERC-1155" ? "ERC-1155 is not supported" : `${type || "Unknown"} is not supported`;
    }
    merged.set(address, asset);
  }

  const assets = [...merged.values()];

  // An ERC-721 collection can only be swept when it is enumerable.
  await Promise.all(
    assets
      .filter((asset) => asset.kind === 1)
      .map(async (asset) => {
        const enumerable = await erc721(asset.address)
          .supportsInterface(ERC721_ENUMERABLE_INTERFACE_ID)
          .catch(() => false);
        if (!enumerable) {
          asset.kind = -1;
          asset.blocked = "Collection is not enumerable";
        }
      }),
  );

  return assets
    .filter((asset) => asset.balance > 0n)
    .sort((a, b) => a.kind - b.kind || a.symbol.localeCompare(b.symbol));
}
/* eslint-enable @typescript-eslint/no-explicit-any */


/** Contract error name to human sentence. Names come from the ABI, never hardcoded selectors. */
const ERROR_TEXT: Record<string, string> = {
  LiveVaultAlreadyExists:
    "This wallet already has a live vault. Deactivate it first, or use a different owner wallet.",
  InvalidSigners:
    "The derived signer addresses were rejected. Derive both phrases again.",
  InvalidVaultSalt: "The public vault salt was invalid. Derive both phrases again.",
  InvalidPeriod:
    "That inactivity period is outside the allowed range of 1 minute to 3650 days.",
  NotOwner: "Only the vault owner wallet can perform that action.",
  VaultNotFound: "No vault exists with that ID.",
  VaultNotActive: "That vault is no longer active, so it cannot be changed.",
  VaultIsDeactivated: "That vault was permanently deactivated.",
  VaultNotYetClaimable: "The inactivity period has not elapsed yet.",
  CallerInCooldown:
    "This wallet is in cooldown after a failed claim. Wait for the cooldown, or submit from another wallet.",
  IncorrectFee: "The claim fee must be exact. Reload the fee and try again.",
  InvalidDestination: "The destination address is not valid.",
  TooManyTokens: "This vault already holds the maximum of 50 registered assets.",
  DuplicateToken: "That asset is already registered to this vault.",
  TokenNotRegistered: "That asset is not registered to this vault.",
  InvalidToken: "That address is not a contract, so it cannot be registered.",
  FeeForwardFailed: "The fee could not be forwarded to the fee recipient.",
};

const SKIP_REASONS: Record<string, string> = {
  [id("BALANCE_READ_FAILED")]: "Balance could not be read",
  [id("ALLOWANCE_READ_FAILED")]: "Allowance could not be read",
  [id("TRANSFER_FAILED")]: "Transfer was rejected by the token",
  [id("NOT_ENUMERABLE")]: "Collection is not enumerable",
  [id("ENUMERATION_FAILED")]: "Token list could not be read",
  [id("NFT_LIMIT_REACHED")]: "Per-claim NFT limit reached",
};

export function skipReason(reason: string): string {
  return SKIP_REASONS[reason.toLowerCase()] ?? "Skipped by the contract";
}

function revertData(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  const walk = (node: unknown): string | undefined => {
    if (!node || typeof node !== "object" || seen.has(node)) return undefined;
    seen.add(node);
    const record = node as Record<string, unknown>;
    if (typeof record.data === "string" && record.data.startsWith("0x")) return record.data;
    for (const key of ["info", "error", "cause", "value"]) {
      const found = walk(record[key]);
      if (found) return found;
    }
    return undefined;
  };
  return walk(error);
}

/** Turns wallet and RPC failures into one calm sentence. Never leaks raw calldata. */
export function friendlyError(error: unknown): string {
  const record = (error ?? {}) as {
    code?: string | number;
    shortMessage?: string;
    message?: string;
    reason?: string;
  };

  const data = revertData(error);
  if (data && data !== "0x") {
    try {
      const parsed = dmhInterface.parseError(data);
      if (parsed && ERROR_TEXT[parsed.name]) return ERROR_TEXT[parsed.name];
      if (parsed) return `The contract rejected this action (${parsed.name}).`;
    } catch {
      // Not a DMH error; fall through to generic handling.
    }
  }

  const text = `${record.shortMessage ?? ""} ${record.message ?? ""} ${record.reason ?? ""}`;
  if (record.code === 4001 || /user rejected|user denied/i.test(text)) {
    return "The wallet request was cancelled.";
  }
  if (record.code === -32002) {
    return "A wallet request is already open. Finish it in your wallet, then retry.";
  }
  if (/insufficient funds/i.test(text)) {
    return "This wallet does not have enough BOT for gas and the claim fee.";
  }
  if (/timeout|timed out|network error|failed to fetch/i.test(text)) {
    return "The network did not respond. Check your connection, then retry.";
  }
  if (/could not coalesce|missing revert data|call_exception/i.test(text)) {
    return "The contract rejected this action. Check the vault state and your wallet, then retry.";
  }
  if (record.shortMessage) return record.shortMessage;
  return "That request could not be completed. Please try again.";
}
