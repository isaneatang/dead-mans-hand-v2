import "@nomicfoundation/hardhat-toolbox";
import { HardhatUserConfig } from "hardhat/config";

const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 500 },
    },
  },
  networks: {
    hardhat: {
      hardfork: "cancun",
      blockGasLimit: 30_000_000,
    },
    botTestnet: {
      url: "https://rpc.bohr.life",
      chainId: 968,
      accounts: deployerKey ? [deployerKey] : [],
    },
    botMainnet: {
      url: "https://rpc.botchain.ai",
      chainId: 677,
      accounts: [],
    },
  },
  etherscan: {
    apiKey: {
      botTestnet: "blockscout",
    },
    customChains: [
      {
        network: "botTestnet",
        chainId: 968,
        urls: {
          apiURL: "https://scan.bohr.life/api",
          browserURL: "https://scan.bohr.life",
        },
      },
    ],
  },
};

export default config;
