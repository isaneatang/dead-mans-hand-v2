import { BrowserProvider, Eip1193Provider } from "ethers";

declare global {
  interface Window {
    ethereum?: {
      request(args: { method: string; params?: unknown[] }): Promise<unknown>;
    };
  }
}

const TESTNET_HEX = "0x3c8";

export async function connectTestnetWallet() {
  if (!window.ethereum) throw new Error("No injected wallet was found.");
  await window.ethereum.request({ method: "eth_requestAccounts" });
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: TESTNET_HEX }],
    });
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code !== 4902 && code !== -32603) throw error;
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: TESTNET_HEX,
          chainName: "BOT Chain Testnet",
          nativeCurrency: { name: "BOT", symbol: "BOT", decimals: 18 },
          rpcUrls: ["https://rpc.bohr.life"],
          blockExplorerUrls: ["https://scan.bohr.life"],
        },
      ],
    });
  }
  const provider = new BrowserProvider(window.ethereum as Eip1193Provider);
  const signer = await provider.getSigner();
  const network = await provider.getNetwork();
  if (network.chainId !== 968n) throw new Error("Wallet is not on BOT Chain Testnet (968).");
  return { provider, signer, address: await signer.getAddress() };
}
