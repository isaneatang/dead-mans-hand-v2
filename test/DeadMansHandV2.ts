import { expect } from "chai";
import { ethers, network } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const BASE_FEE = ethers.parseEther("0.001");
const PERIOD = 60;
const VAULT_SALT = ethers.keccak256(ethers.toUtf8Bytes("test vault salt"));

describe("DeadMansHandV2", function () {
  async function deployFixture() {
    const [owner, relayer, otherCaller, destination, feeRecipient, attacker] =
      await ethers.getSigners();
    const signerA = ethers.Wallet.createRandom();
    const signerB = ethers.Wallet.createRandom();

    const DMH = await ethers.getContractFactory("DeadMansHandV2");
    const dmh = await DMH.deploy(BASE_FEE, feeRecipient.address);
    await dmh.waitForDeployment();

    await dmh
      .connect(owner)
      .createVault(signerA.address, signerB.address, VAULT_SALT, PERIOD);

    return {
      dmh,
      owner,
      relayer,
      otherCaller,
      destination,
      feeRecipient,
      attacker,
      signerA,
      signerB,
    };
  }

  async function signClaim(
    dmh: Awaited<ReturnType<typeof ethers.getContractAt>>,
    signerA: ethers.Wallet,
    signerB: ethers.Wallet,
    destination: string,
    vaultId = 1n,
    nonce?: bigint,
    chainId?: bigint,
    verifyingContract?: string,
  ) {
    const vault = await dmh.getVault(vaultId);
    const networkInfo = await ethers.provider.getNetwork();
    const domain = {
      name: "DeadMansHandV2",
      version: "2",
      chainId: chainId ?? networkInfo.chainId,
      verifyingContract: verifyingContract ?? (await dmh.getAddress()),
    };
    const types = {
      ClaimAuthorization: [
        { name: "vaultId", type: "uint256" },
        { name: "destination", type: "address" },
        { name: "nonce", type: "uint256" },
      ],
    };
    const value = { vaultId, destination, nonce: nonce ?? vault.nonce };

    return {
      sigA: await signerA.signTypedData(domain, types, value),
      sigB: await signerB.signTypedData(domain, types, value),
    };
  }

  it("creates one live vault per owner with a public derivation salt", async function () {
    const { dmh, owner, signerA, signerB } = await deployFixture();
    const vault = await dmh.getVault(1);

    expect(vault.owner).to.equal(owner.address);
    expect(vault.signerA).to.equal(signerA.address);
    expect(vault.signerB).to.equal(signerB.address);
    expect(vault.vaultSalt).to.equal(VAULT_SALT);
    await expect(
      dmh
        .connect(owner)
        .createVault(signerA.address, signerB.address, ethers.id("another"), PERIOD),
    ).to.be.revertedWithCustomError(dmh, "LiveVaultAlreadyExists");
  });

  it("rejects owner signers, duplicate signers, zero salt, and invalid periods", async function () {
    const [owner, signer] = await ethers.getSigners();
    const DMH = await ethers.getContractFactory("DeadMansHandV2");
    const dmh = await DMH.deploy(BASE_FEE, owner.address);

    await expect(
      dmh.createVault(owner.address, signer.address, VAULT_SALT, PERIOD),
    ).to.be.revertedWithCustomError(dmh, "InvalidSigners");
    await expect(
      dmh.createVault(signer.address, signer.address, VAULT_SALT, PERIOD),
    ).to.be.revertedWithCustomError(dmh, "InvalidSigners");
    await expect(
      dmh.createVault(signer.address, ethers.Wallet.createRandom().address, ethers.ZeroHash, PERIOD),
    ).to.be.revertedWithCustomError(dmh, "InvalidVaultSalt");
    await expect(
      dmh.createVault(signer.address, ethers.Wallet.createRandom().address, VAULT_SALT, 59),
    ).to.be.revertedWithCustomError(dmh, "InvalidPeriod");
  });

  it("restricts heartbeat and registry changes to the active owner", async function () {
    const { dmh, owner, attacker } = await deployFixture();
    const Token = await ethers.getContractFactory("MockERC20");
    const token = await Token.deploy();

    await expect(dmh.connect(attacker).ping(1)).to.be.revertedWithCustomError(dmh, "NotOwner");
    await dmh.connect(owner).addToken(1, await token.getAddress(), 0);
    await expect(
      dmh.connect(owner).addToken(1, await token.getAddress(), 0),
    ).to.be.revertedWithCustomError(dmh, "DuplicateToken");
    await dmh.connect(owner).deactivateVault(1);
    await expect(dmh.connect(owner).ping(1)).to.be.revertedWithCustomError(dmh, "VaultNotActive");
    await expect(
      dmh.connect(owner).addToken(1, await token.getAddress(), 0),
    ).to.be.revertedWithCustomError(dmh, "VaultNotActive");
  });

  it("does not permit a claim before maturity", async function () {
    const { dmh, relayer, destination } = await deployFixture();
    await expect(
      dmh
        .connect(relayer)
        .attemptClaim(1, destination.address, "0x", "0x", { value: BASE_FEE }),
    ).to.be.revertedWithCustomError(dmh, "VaultNotYetClaimable");
  });

  it("consumes invalid attempts uniformly and isolates fee/cooldown by caller", async function () {
    const { dmh, relayer, otherCaller, destination, signerA, signerB } = await deployFixture();
    await time.increase(PERIOD);
    const valid = await signClaim(dmh as never, signerA, signerB, destination.address);

    await expect(
      dmh
        .connect(relayer)
        .attemptClaim(1, destination.address, valid.sigA, "0x1234", { value: BASE_FEE }),
    )
      .to.emit(dmh, "ClaimFailed")
      .withArgs(1, relayer.address);

    expect(await dmh.currentClaimFee(1, relayer.address)).to.equal(BASE_FEE * 2n);
    expect(await dmh.currentClaimFee(1, otherCaller.address)).to.equal(BASE_FEE);
    await expect(
      dmh
        .connect(relayer)
        .attemptClaim(1, destination.address, "0x", "0x", { value: BASE_FEE * 2n }),
    ).to.be.revertedWithCustomError(dmh, "CallerInCooldown");
    await expect(
      dmh
        .connect(otherCaller)
        .attemptClaim(1, destination.address, "0x", "0x", { value: BASE_FEE }),
    ).to.emit(dmh, "ClaimFailed");
  });

  it("sweeps ERC20 and ERC721 assets to the signed destination through any relayer", async function () {
    const { dmh, owner, attacker, destination, signerA, signerB } = await deployFixture();
    const Token = await ethers.getContractFactory("MockERC20");
    const token = await Token.deploy();
    const NFT = await ethers.getContractFactory("MockERC721Enumerable");
    const nft = await NFT.deploy();
    const dmhAddress = await dmh.getAddress();

    await token.mint(owner.address, 1_000n);
    await nft.mint(owner.address);
    await token.connect(owner).approve(dmhAddress, 750n);
    await nft.connect(owner).setApprovalForAll(dmhAddress, true);
    await dmh.connect(owner).addToken(1, await token.getAddress(), 0);
    await dmh.connect(owner).addToken(1, await nft.getAddress(), 1);
    await time.increase(PERIOD);

    const signatures = await signClaim(dmh as never, signerA, signerB, destination.address);
    await expect(
      dmh
        .connect(attacker)
        .attemptClaim(1, destination.address, signatures.sigA, signatures.sigB, {
          value: BASE_FEE,
        }),
    )
      .to.emit(dmh, "ClaimExecuted")
      .withArgs(1, destination.address, attacker.address);

    expect(await token.balanceOf(destination.address)).to.equal(750n);
    expect(await token.balanceOf(owner.address)).to.equal(250n);
    expect(await nft.ownerOf(1)).to.equal(destination.address);
    expect((await dmh.getVault(1)).nonce).to.equal(1n);
  });

  it("rejects replay and signatures for another destination, chain, or contract", async function () {
    const { dmh, relayer, destination, attacker, signerA, signerB } = await deployFixture();
    await time.increase(PERIOD);
    const valid = await signClaim(dmh as never, signerA, signerB, destination.address);

    await dmh
      .connect(relayer)
      .attemptClaim(1, destination.address, valid.sigA, valid.sigB, { value: BASE_FEE });
    await expect(
      dmh
        .connect(attacker)
        .attemptClaim(1, destination.address, valid.sigA, valid.sigB, { value: BASE_FEE }),
    ).to.emit(dmh, "ClaimFailed");

    await time.increase(3600);
    const wrongDestination = await signClaim(
      dmh as never,
      signerA,
      signerB,
      destination.address,
    );
    await expect(
      dmh
        .connect(attacker)
        .attemptClaim(1, attacker.address, wrongDestination.sigA, wrongDestination.sigB, {
          value: BASE_FEE * 2n,
        }),
    ).to.emit(dmh, "ClaimFailed");

    await time.increase(3600);
    const wrongChain = await signClaim(
      dmh as never,
      signerA,
      signerB,
      destination.address,
      1n,
      1n,
      677n,
    );
    await expect(
      dmh
        .connect(attacker)
        .attemptClaim(1, destination.address, wrongChain.sigA, wrongChain.sigB, {
          value: BASE_FEE * 4n,
        }),
    ).to.emit(dmh, "ClaimFailed");

    await time.increase(3600);
    const wrongContract = await signClaim(
      dmh as never,
      signerA,
      signerB,
      destination.address,
      1n,
      1n,
      undefined,
      ethers.Wallet.createRandom().address,
    );
    await expect(
      dmh
        .connect(attacker)
        .attemptClaim(1, destination.address, wrongContract.sigA, wrongContract.sigB, {
          value: BASE_FEE * 8n,
        }),
    ).to.emit(dmh, "ClaimFailed");
  });

  it("skips broken tokens without blocking valid tokens", async function () {
    const { dmh, owner, relayer, destination, signerA, signerB } = await deployFixture();
    const FalseToken = await ethers.getContractFactory("FalseERC20");
    const broken = await FalseToken.deploy();
    const Token = await ethers.getContractFactory("MockERC20");
    const valid = await Token.deploy();
    const dmhAddress = await dmh.getAddress();

    await broken.mint(owner.address, 100n);
    await broken.connect(owner).approve(dmhAddress, 100n);
    await valid.mint(owner.address, 200n);
    await valid.connect(owner).approve(dmhAddress, 200n);
    await dmh.connect(owner).addToken(1, await broken.getAddress(), 0);
    await dmh.connect(owner).addToken(1, await valid.getAddress(), 0);
    await time.increase(PERIOD);
    const signatures = await signClaim(dmh as never, signerA, signerB, destination.address);

    await expect(
      dmh
        .connect(relayer)
        .attemptClaim(1, destination.address, signatures.sigA, signatures.sigB, {
          value: BASE_FEE,
        }),
    ).to.emit(dmh, "TokenSkipped");
    expect(await valid.balanceOf(destination.address)).to.equal(200n);
  });

  it("skips a malicious non-boolean ERC20 return without reverting", async function () {
    const { dmh, owner, relayer, destination, signerA, signerB } = await deployFixture();
    const Malformed = await ethers.getContractFactory("MalformedERC20");
    const malformed = await Malformed.deploy();
    await malformed.mint(owner.address, 100n);
    await malformed.connect(owner).approve(await dmh.getAddress(), 100n);
    await dmh.connect(owner).addToken(1, await malformed.getAddress(), 0);
    await time.increase(PERIOD);
    const signatures = await signClaim(dmh as never, signerA, signerB, destination.address);

    await expect(
      dmh.connect(relayer).attemptClaim(1, destination.address, signatures.sigA, signatures.sigB, {
        value: BASE_FEE,
      }),
    ).to.emit(dmh, "TokenSkipped");
  });

  it("caps NFT transfers globally and supports a fresh-signature follow-up sweep", async function () {
    const { dmh, owner, relayer, destination, signerA, signerB } = await deployFixture();
    const NFT = await ethers.getContractFactory("MockERC721Enumerable");
    const nft = await NFT.deploy();
    const dmhAddress = await dmh.getAddress();

    for (let i = 0; i < 25; i += 1) await nft.mint(owner.address);
    await nft.connect(owner).setApprovalForAll(dmhAddress, true);
    await dmh.connect(owner).addToken(1, await nft.getAddress(), 1);
    await time.increase(PERIOD);

    let signatures = await signClaim(dmh as never, signerA, signerB, destination.address);
    await expect(
      dmh
        .connect(relayer)
        .attemptClaim(1, destination.address, signatures.sigA, signatures.sigB, {
          value: BASE_FEE,
        }),
    ).to.emit(dmh, "SweepLimitReached");
    expect(await nft.balanceOf(owner.address)).to.equal(5n);

    signatures = await signClaim(dmh as never, signerA, signerB, destination.address);
    await dmh
      .connect(relayer)
      .attemptClaim(1, destination.address, signatures.sigA, signatures.sigB, {
        value: BASE_FEE,
      });
    expect(await nft.balanceOf(owner.address)).to.equal(0n);
    expect(await nft.balanceOf(destination.address)).to.equal(25n);
  });

  it("rejects non-enumerable NFTs without reverting the claim", async function () {
    const { dmh, owner, relayer, destination, signerA, signerB } = await deployFixture();
    const NFT = await ethers.getContractFactory("MockERC721");
    const nft = await NFT.deploy();
    await nft.mint(owner.address);
    await nft.connect(owner).setApprovalForAll(await dmh.getAddress(), true);
    await dmh.connect(owner).addToken(1, await nft.getAddress(), 1);
    await time.increase(PERIOD);
    const signatures = await signClaim(dmh as never, signerA, signerB, destination.address);

    await expect(
      dmh
        .connect(relayer)
        .attemptClaim(1, destination.address, signatures.sigA, signatures.sigB, {
          value: BASE_FEE,
        }),
    ).to.emit(dmh, "TokenSkipped");
    expect(await nft.ownerOf(1)).to.equal(owner.address);
  });

  it("blocks claim reentrancy from an ERC721 recipient hook", async function () {
    const { dmh, owner, relayer, signerA, signerB } = await deployFixture();
    const NFT = await ethers.getContractFactory("MockERC721Enumerable");
    const nft = await NFT.deploy();
    const Recipient = await ethers.getContractFactory("ReentrantRecipient");
    const recipient = await Recipient.deploy(await dmh.getAddress());

    await nft.mint(owner.address);
    await nft.connect(owner).setApprovalForAll(await dmh.getAddress(), true);
    await dmh.connect(owner).addToken(1, await nft.getAddress(), 1);
    await time.increase(PERIOD);
    const signatures = await signClaim(
      dmh as never,
      signerA,
      signerB,
      await recipient.getAddress(),
    );

    await dmh
      .connect(relayer)
      .attemptClaim(1, await recipient.getAddress(), signatures.sigA, signatures.sigB, {
        value: BASE_FEE,
      });
    expect(await recipient.reentryBlocked()).to.equal(true);
    expect((await dmh.getVault(1)).nonce).to.equal(1n);
  });

  it("caps caller-specific fee escalation at 128 times base", async function () {
    const { dmh, relayer, destination } = await deployFixture();
    await time.increase(PERIOD);
    for (let attempt = 0; attempt < 9; attempt += 1) {
      const fee = await dmh.currentClaimFee(1, relayer.address);
      await dmh
        .connect(relayer)
        .attemptClaim(1, destination.address, "0x", "0x", { value: fee });
      await time.increase(3600);
    }
    expect(await dmh.currentClaimFee(1, relayer.address)).to.equal(BASE_FEE * 128n);
  });

  it("requires the exact fee and forwards normal-flow value immediately", async function () {
    const { dmh, relayer, destination, feeRecipient } = await deployFixture();
    await time.increase(PERIOD);
    await expect(
      dmh
        .connect(relayer)
        .attemptClaim(1, destination.address, "0x", "0x", { value: BASE_FEE + 1n }),
    ).to.be.revertedWithCustomError(dmh, "IncorrectFee");

    const before = await ethers.provider.getBalance(feeRecipient.address);
    await dmh
      .connect(relayer)
      .attemptClaim(1, destination.address, "0x", "0x", { value: BASE_FEE });
    expect(await ethers.provider.getBalance(feeRecipient.address)).to.equal(before + BASE_FEE);
    expect(await ethers.provider.getBalance(await dmh.getAddress())).to.equal(0n);
  });

  after(async function () {
    await network.provider.send("hardhat_reset");
  });
});
