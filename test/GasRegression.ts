import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { LogDescription, Wallet } from "ethers";

const BASE_FEE = ethers.parseEther("0.001");
const PERIOD = 60;
const LOCAL_BLOCK_GAS_LIMIT = 30_000_000n;
// Keep 20% headroom for client/RPC variance beneath the configured local block ceiling.
const CLAIM_GAS_SAFETY_THRESHOLD = (LOCAL_BLOCK_GAS_LIMIT * 80n) / 100n;

describe("DeadMansHandV2 worst-case gas regression", function () {
  this.timeout(180_000);

  async function fixture() {
    const [owner, relayer, destination, feeRecipient] = await ethers.getSigners();
    const signerA = ethers.Wallet.createRandom();
    const signerB = ethers.Wallet.createRandom();
    const DMH = await ethers.getContractFactory("DeadMansHandV2");
    const dmh = await DMH.deploy(BASE_FEE, feeRecipient.address);
    await dmh.waitForDeployment();
    await dmh.createVault(signerA.address, signerB.address, ethers.id("gas-regression"), PERIOD);
    return { dmh, owner, relayer, destination, signerA, signerB };
  }

  async function signatures(
    dmh: Awaited<ReturnType<typeof ethers.getContractAt>>,
    signerA: Wallet,
    signerB: Wallet,
    destination: string,
  ) {
    const { chainId } = await ethers.provider.getNetwork();
    const domain = {
      name: "DeadMansHandV2",
      version: "2",
      chainId,
      verifyingContract: await dmh.getAddress(),
    };
    const types = {
      ClaimAuthorization: [
        { name: "vaultId", type: "uint256" },
        { name: "destination", type: "address" },
        { name: "nonce", type: "uint256" },
      ],
    };
    const value = { vaultId: 1n, destination, nonce: 0n };
    return {
      sigA: await signerA.signTypedData(domain, types, value),
      sigB: await signerB.signTypedData(domain, types, value),
    };
  }

  async function claimAndMeasure(
    setup: Awaited<ReturnType<typeof fixture>>,
    scenario: string,
    expectedERC20Sweeps: number,
    expectedERC721Sweeps: number,
  ) {
    await time.increase(PERIOD);
    const signed = await signatures(
      setup.dmh as never,
      setup.signerA,
      setup.signerB,
      setup.destination.address,
    );
    const transaction = await setup.dmh
      .connect(setup.relayer)
      .attemptClaim(1, setup.destination.address, signed.sigA, signed.sigB, {
        value: BASE_FEE,
        gasLimit: LOCAL_BLOCK_GAS_LIMIT,
      });
    const receipt = await transaction.wait();
    expect(receipt).to.not.equal(null);
    const gasUsed = receipt!.gasUsed;
    const events: Array<LogDescription | null> = receipt!.logs.map((log: {
      topics: readonly string[];
      data: string;
    }) => {
      try {
        return setup.dmh.interface.parseLog(log);
      } catch {
        return null;
      }
    });
    expect(events.filter((event) => event?.name === "ERC20Swept")).to.have.lengthOf(
      expectedERC20Sweeps,
    );
    expect(events.filter((event) => event?.name === "ERC721Swept")).to.have.lengthOf(
      expectedERC721Sweeps,
    );
    console.log(
      JSON.stringify({
        gasRegression: scenario,
        gasUsed: gasUsed.toString(),
        safetyThreshold: CLAIM_GAS_SAFETY_THRESHOLD.toString(),
        localBlockGasLimit: LOCAL_BLOCK_GAS_LIMIT.toString(),
      }),
    );
    expect(gasUsed).to.be.lessThan(CLAIM_GAS_SAFETY_THRESHOLD);
    return gasUsed;
  }

  it("sweeps a full 50-token registry when every ERC20 call nearly exhausts its stipend", async function () {
    const setup = await fixture();
    const dmhAddress = await setup.dmh.getAddress();
    const HeavyToken = await ethers.getContractFactory("GasHeavyERC20");

    for (let index = 0; index < 50; index += 1) {
      const token = await HeavyToken.deploy();
      await token.waitForDeployment();
      await token.mint(setup.owner.address, 1n);
      await token.connect(setup.owner).approve(dmhAddress, 1n);
      await setup.dmh.connect(setup.owner).addToken(1, await token.getAddress(), 0);
    }

    await claimAndMeasure(setup, "50 gas-heavy ERC20 tokens", 50, 0);
  });

  it("sweeps 30 gas-heavy ERC20s and the maximum 20 ERC721 transfers", async function () {
    const setup = await fixture();
    const dmhAddress = await setup.dmh.getAddress();
    const HeavyToken = await ethers.getContractFactory("GasHeavyERC20");
    const NFT = await ethers.getContractFactory("MockERC721Enumerable");

    for (let index = 0; index < 30; index += 1) {
      const token = await HeavyToken.deploy();
      await token.waitForDeployment();
      await token.mint(setup.owner.address, 1n);
      await token.connect(setup.owner).approve(dmhAddress, 1n);
      await setup.dmh.connect(setup.owner).addToken(1, await token.getAddress(), 0);
    }
    for (let index = 0; index < 20; index += 1) {
      const nft = await NFT.deploy();
      await nft.waitForDeployment();
      await nft.mint(setup.owner.address);
      await nft.connect(setup.owner).setApprovalForAll(dmhAddress, true);
      await setup.dmh.connect(setup.owner).addToken(1, await nft.getAddress(), 1);
    }

    await claimAndMeasure(setup, "30 gas-heavy ERC20 + 20 ERC721 tokens", 30, 20);
  });
});
