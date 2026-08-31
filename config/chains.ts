export type ChainConfig = {
  name: string;
  rpcUrl: string;
  explorerUrl: string;
  faucetUrl: string | null;
  dmhAddress: `0x${string}` | null;
};

export const chains: Record<number, ChainConfig> = {
  968: {
    name: "BOT Chain Testnet",
    rpcUrl: "https://rpc.bohr.life",
    explorerUrl: "https://scan.bohr.life",
    faucetUrl: "https://faucet.botchain.ai/basic",
    dmhAddress: "0x57DeF08fdafA9Ae9428bCCE440c624CC83B1f6F8",
  },
  677: {
    name: "BOT Chain Mainnet",
    rpcUrl: "https://rpc.botchain.ai",
    explorerUrl: "https://scan.botchain.ai",
    faucetUrl: null,
    dmhAddress: null,
  },
};
