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
  on?: (event: string, handler: Listener) => void;
  removeListener?: (event: string, handler: Listener) => void;
};

declare global {
  interface Window {
    ethereum?: InjectedProvider;
  }
}

export type WalletState = {
  provider: BrowserProvider;
  signer: JsonRpcSigner;
  address: string;
  chainId: number;
};

export class WalletError extends Error {}

function pickProvider(): InjectedProvider | undefined {
  const injected = window.ethereum;
  if (!injected) return undefined;
  // Several wallets can inject at once. Prefer MetaMask, else the first entry.
  if (Array.isArray(injected.providers) && injected.providers.length > 0) {
    return injected.providers.find((p) => p.isMetaMask) ?? injected.providers[0];
  }
  return injected;
}

/**
 * Wallet in-app browsers sometimes inject the provider after first paint.
 * Waits briefly instead of failing immediately.
 */
async function waitForProvider(timeoutMs: number): Promise<InjectedProvider | undefined> {
  const immediate = pickProvider();
  if (immediate) return immediate;

  return new Promise((resolve) => {
    const started = Date.now();
    const finish = (value?: InjectedProvider) => {
      window.removeEventListener("ethereum#initialized", onInit);
      clearInterval(poll);
      resolve(value);
    };
    const onInit = () => finish(pickProvider());
    const poll = setInterval(() => {
      const found = pickProvider();
      if (found) return finish(found);
      if (Date.now() - started >= timeoutMs) finish(undefined);
    }, 150);
    window.addEventListener("ethereum#initialized", onInit, { once: true });
  });
}

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

export async function connectWallet(): Promise<WalletState> {
  const injected = await waitForProvider(2500);
  if (!injected) {
    throw new WalletError(
      "No wallet was detected. Open this page inside MetaMask, OKX, or another wallet browser, or install a wallet extension.",
    );
  }

  try {
    await injected.request({ method: "eth_requestAccounts" });
  } catch (error) {
    const { code } = error as { code?: number };
    if (code === 4001) throw new WalletError("The wallet connection was cancelled.");
    if (code === -32002) {
      throw new WalletError("A wallet request is already open. Finish it in your wallet, then retry.");
    }
    throw new WalletError("The wallet refused the connection request.");
  }

  const chainId = await ensureTestnet(injected);
  const state = await buildState(injected);
  return { ...state, chainId };
}

/** Reconnects silently when the wallet already granted access. Never prompts. */
export async function eagerWallet(): Promise<WalletState | undefined> {
  const injected = await waitForProvider(1200);
  if (!injected) return undefined;
  try {
    const accounts = (await injected.request({ method: "eth_accounts" })) as string[];
    if (!accounts?.length) return undefined;
    return await buildState(injected);
  } catch {
    return undefined;
  }
}

export async function switchNetwork(): Promise<number> {
  const injected = pickProvider();
  if (!injected) throw new WalletError("No wallet was detected.");
  return ensureTestnet(injected);
}

export function watchWallet(onChange: () => void): () => void {
  const injected = pickProvider();
  if (!injected?.on || !injected.removeListener) return () => {};
  const handler: Listener = () => onChange();
  injected.on("accountsChanged", handler);
  injected.on("chainChanged", handler);
  return () => {
    injected.removeListener?.("accountsChanged", handler);
    injected.removeListener?.("chainChanged", handler);
  };
}
