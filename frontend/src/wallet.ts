import {
  BrowserProvider,
  type Eip1193Provider,
  type JsonRpcSigner,
} from "ethers";
import { chains } from "../../config/chains";

export const TESTNET_CHAIN_ID = 968;
const TESTNET_HEX = "0x3c8";
const config = chains[TESTNET_CHAIN_ID];

type Listener = (...args: unknown[]) => void;

type InjectedProvider = Eip1193Provider & {
  providers?: InjectedProvider[];
  isMetaMask?: boolean;
  isRabby?: boolean;
  isCoinbaseWallet?: boolean;
  isTrust?: boolean;
  isTrustWallet?: boolean;
  isOkxWallet?: boolean;
  isBraveWallet?: boolean;
  isFrame?: boolean;
  on?: (event: string, handler: Listener) => void;
  removeListener?: (event: string, handler: Listener) => void;
};

/** EIP-6963 wallet metadata. `rdns` is the stable, spoof-resistant identifier. */
export type WalletInfo = {
  uuid: string;
  name: string;
  /** Data URI supplied by the wallet, or "" for legacy providers. */
  icon: string;
  rdns: string;
};

type ProviderDetail = { info: WalletInfo; provider: InjectedProvider };

declare global {
  interface Window {
    ethereum?: InjectedProvider;
  }
  interface WindowEventMap {
    "eip6963:announceProvider": CustomEvent<ProviderDetail>;
  }
}

export type WalletState = {
  provider: BrowserProvider;
  signer: JsonRpcSigner;
  address: string;
  chainId: number;
};

export class WalletError extends Error {}

/* --------------------------- wallet discovery ---------------------------- */
/*
 * Two discovery mechanisms exist and both are required.
 *
 * 1. EIP-6963 (`eip6963:announceProvider`). This is how current browser
 *    extensions publish themselves. Several of them no longer write
 *    `window.ethereum` at all, and when two extensions are installed only one
 *    can own that single slot, so `window.ethereum` alone silently misses or
 *    misidentifies extension wallets.
 * 2. Legacy `window.ethereum`. Mobile wallet in-app browsers inject straight
 *    into the page and mostly do not announce over EIP-6963.
 *
 * Announced providers always take precedence; a legacy entry is only surfaced
 * when that exact provider object was not announced.
 */

const LEGACY_RDNS = "legacy.injected";
const SELECTED_KEY = "dmh.wallet.rdns";

const announced = new Map<string, ProviderDetail>();
const watchers = new Set<() => void>();
let discovering = false;
let selected: ProviderDetail | undefined;

function notify(): void {
  for (const watcher of [...watchers]) watcher();
}

function subscribe(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

function onAnnounce(event: CustomEvent<ProviderDetail>): void {
  const detail = event.detail;
  const rdns = detail?.info?.rdns;
  if (!detail?.provider || !rdns) return;
  // Wallets re-announce on every request. Only a genuinely new provider is news.
  if (announced.get(rdns)?.provider === detail.provider) return;
  announced.set(rdns, {
    info: {
      uuid: String(detail.info.uuid ?? rdns),
      name: String(detail.info.name ?? rdns),
      icon: typeof detail.info.icon === "string" ? detail.info.icon : "",
      rdns,
    },
    provider: detail.provider,
  });
  notify();
}

/** Asks every EIP-6963 wallet to announce itself. Safe to repeat. */
export function requestProviders(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

function startDiscovery(): void {
  if (discovering || typeof window === "undefined") return;
  discovering = true;
  window.addEventListener("eip6963:announceProvider", onAnnounce);
  // Legacy signal for wallets that inject after first paint.
  window.addEventListener("ethereum#initialized", notify, { once: true });
  requestProviders();
}

function legacyName(provider: InjectedProvider): string {
  // Checked most specific first: almost every wallet also sets isMetaMask.
  if (provider.isRabby) return "Rabby";
  if (provider.isCoinbaseWallet) return "Coinbase Wallet";
  if (provider.isTrust || provider.isTrustWallet) return "Trust Wallet";
  if (provider.isOkxWallet) return "OKX Wallet";
  if (provider.isBraveWallet) return "Brave Wallet";
  if (provider.isFrame) return "Frame";
  if (provider.isMetaMask) return "MetaMask";
  return "Injected wallet";
}

function legacyProviders(): InjectedProvider[] {
  const root = typeof window === "undefined" ? undefined : window.ethereum;
  if (!root) return [];
  // `providers` is the pre-EIP-6963 multi-wallet array. Keep the root last.
  const nested = Array.isArray(root.providers) ? root.providers.filter(Boolean) : [];
  return nested.length > 0 ? [...nested, root] : [root];
}

function allDetails(): ProviderDetail[] {
  const details = [...announced.values()];
  const seen = new Set<InjectedProvider>(details.map((detail) => detail.provider));

  legacyProviders().forEach((provider, index) => {
    if (seen.has(provider)) return;
    seen.add(provider);
    const rdns = index === 0 ? LEGACY_RDNS : `${LEGACY_RDNS}.${index}`;
    details.push({ info: { uuid: rdns, name: legacyName(provider), icon: "", rdns }, provider });
  });

  return details;
}

/** Discovered wallets. Recomputed on every call because extensions load late. */
export function listWallets(): WalletInfo[] {
  startDiscovery();
  return allDetails().map((detail) => detail.info);
}

export function selectedWallet(): WalletInfo | undefined {
  return selected?.info;
}

/** Fires when the discovered wallet list or the selected wallet changes. */
export function onWalletsChanged(watcher: () => void): () => void {
  startDiscovery();
  return subscribe(watcher);
}

function remember(rdns: string): void {
  // Only a public wallet identifier, never a phrase, key or address. Session
  // scoped so nothing about this browser survives the tab.
  try {
    sessionStorage.setItem(SELECTED_KEY, rdns);
  } catch {
    // Storage can be blocked; the choice simply is not remembered.
  }
}

function remembered(): string | undefined {
  try {
    return sessionStorage.getItem(SELECTED_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function select(detail: ProviderDetail): void {
  if (selected?.provider === detail.provider && selected.info.rdns === detail.info.rdns) return;
  selected = detail;
  remember(detail.info.rdns);
  notify();
}

/**
 * Waits briefly for at least one wallet. Extensions and wallet in-app browsers
 * both inject asynchronously, so failing on the first tick reports "no wallet"
 * for wallets that are merely a few hundred milliseconds late.
 */
async function waitForWallets(timeoutMs: number): Promise<ProviderDetail[]> {
  startDiscovery();
  const immediate = allDetails();
  if (immediate.length > 0) return immediate;

  return new Promise((resolve) => {
    const started = Date.now();
    let poll = 0;
    let unsubscribe = () => {};
    const stop = (value: ProviderDetail[]) => {
      window.clearInterval(poll);
      unsubscribe();
      resolve(value);
    };

    unsubscribe = subscribe(() => {
      const found = allDetails();
      if (found.length > 0) stop(found);
    });

    poll = window.setInterval(() => {
      const found = allDetails();
      if (found.length > 0) return stop(found);
      if (Date.now() - started >= timeoutMs) return stop([]);
      requestProviders();
    }, 250);
  });
}

function preferredOrder(details: ProviderDetail[]): ProviderDetail[] {
  const preferred = remembered();
  if (!preferred) return details;
  return [
    ...details.filter((detail) => detail.info.rdns === preferred),
    ...details.filter((detail) => detail.info.rdns !== preferred),
  ];
}

const NO_WALLET_MESSAGE =
  "No wallet was detected. Install a wallet extension and reload, or open this page inside a wallet browser. " +
  "If an extension is installed but never appears, check that the page is served over HTTPS and that the extension is enabled for this site.";

/* ------------------------------- network -------------------------------- */

async function readChainId(injected: InjectedProvider): Promise<number> {
  const hex = (await injected.request({ method: "eth_chainId" })) as string;
  return Number.parseInt(hex, 16);
}

async function addTestnet(injected: InjectedProvider): Promise<void> {
  await injected.request({
    method: "wallet_addEthereumChain",
    params: [
      {
        chainId: TESTNET_HEX,
        chainName: config.name,
        nativeCurrency: { name: "BOT", symbol: "BOT", decimals: 18 },
        rpcUrls: [config.rpcUrl],
        blockExplorerUrls: [config.explorerUrl],
      },
    ],
  });
}

/**
 * Switches to BOT testnet, adding the network when the wallet does not know it.
 * Wallet browsers report unknown networks with several different codes.
 */
export async function ensureTestnet(injected: InjectedProvider): Promise<number> {
  if ((await readChainId(injected)) === TESTNET_CHAIN_ID) return TESTNET_CHAIN_ID;

  try {
    await injected.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: TESTNET_HEX }],
    });
  } catch (error) {
    const { code, message } = error as { code?: number; message?: string };
    const unknownChain =
      code === 4902 ||
      code === -32603 ||
      code === -32601 ||
      /unrecognized|not found|add.*chain|missing/i.test(message ?? "");
    if (!unknownChain) throw error;

    await addTestnet(injected);
    if ((await readChainId(injected)) !== TESTNET_CHAIN_ID) {
      try {
        await injected.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: TESTNET_HEX }],
        });
      } catch {
        // Some wallets switch only after the user confirms manually.
      }
    }
  }

  return readChainId(injected);
}

/* ----------------------------- connection ------------------------------- */

async function buildState(injected: InjectedProvider): Promise<WalletState> {
  const provider = new BrowserProvider(injected, "any");
  const signer = await provider.getSigner();
  return {
    provider,
    signer,
    address: await signer.getAddress(),
    chainId: await readChainId(injected),
  };
}

/** Connects a specific discovered wallet, or the best available one. */
export async function connectWallet(rdns?: string): Promise<WalletState> {
  const details = await waitForWallets(3000);
  if (details.length === 0) throw new WalletError(NO_WALLET_MESSAGE);

  const target = rdns
    ? details.find((detail) => detail.info.rdns === rdns)
    : preferredOrder(details)[0];
  if (!target) throw new WalletError("That wallet is no longer available. Reload and try again.");

  try {
    await target.provider.request({ method: "eth_requestAccounts" });
  } catch (error) {
    const { code, message } = error as { code?: number; message?: string };
    if (code === 4001) throw new WalletError("The wallet connection was cancelled.");
    if (code === -32002 || /already (processing|pending)/i.test(message ?? "")) {
      throw new WalletError("A wallet request is already open. Finish it in your wallet, then retry.");
    }
    if (code === 4900 || code === 4901) {
      throw new WalletError(`${target.info.name} is locked or disconnected. Unlock it, then retry.`);
    }
    throw new WalletError(`${target.info.name} refused the connection request.`);
  }

  select(target);
  const chainId = await ensureTestnet(target.provider);
  const state = await buildState(target.provider);
  return { ...state, chainId };
}

/** Reconnects silently when a wallet already granted access. Never prompts. */
export async function eagerWallet(): Promise<WalletState | undefined> {
  const details = await waitForWallets(1500);
  if (details.length === 0) return undefined;

  for (const detail of preferredOrder(details)) {
    try {
      const accounts = (await detail.provider.request({ method: "eth_accounts" })) as string[];
      if (!accounts?.length) continue;
      select(detail);
      return await buildState(detail.provider);
    } catch {
      // Locked or unreachable wallet; try the next one.
    }
  }
  return undefined;
}

export async function switchNetwork(): Promise<number> {
  const provider = selected?.provider;
  if (!provider) throw new WalletError("No wallet is connected.");
  return ensureTestnet(provider);
}

/**
 * Reacts to account and chain changes on the selected wallet, and rebinds when
 * the selection changes or a wallet is discovered after mount.
 */
export function watchWallet(onChange: () => void): () => void {
  startDiscovery();
  const handler: Listener = () => onChange();
  let bound: InjectedProvider | undefined;

  const unbind = () => {
    bound?.removeListener?.("accountsChanged", handler);
    bound?.removeListener?.("chainChanged", handler);
    bound = undefined;
  };

  const bind = () => {
    const provider = selected?.provider;
    if (provider === bound) return false;
    unbind();
    bound = provider;
    bound?.on?.("accountsChanged", handler);
    bound?.on?.("chainChanged", handler);
    return true;
  };

  bind();
  const unsubscribe = subscribe(() => {
    // Only re-read the wallet when the binding actually moved, otherwise a
    // discovery announcement would loop back into another eager reconnect.
    if (bind()) onChange();
  });

  return () => {
    unsubscribe();
    unbind();
  };
}
