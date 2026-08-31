# Dead Man's Hand v2

DMH v2 is a testnet-first, non-custodial inheritance and emergency-access protocol for BOT Chain. Assets remain in the owner's wallet and can be swept only after inactivity with two phrase-derived EIP-712 signatures.

> Status: deployed to BOT Chain testnet. Reviewed design, unaudited implementation. Do not use with real value.

> Hardened deployment completed on 2026-08-31. Existing vaults, approvals, and signatures from the previous contract did not migrate because the EIP-712 domain binds the contract address.

## Testnet Deployment

| Component | Address | Deployment transaction |
|---|---|---|
| DMH v2 | [`0x57DeF08fdafA9Ae9428bCCE440c624CC83B1f6F8`](https://scan.bohr.life/address/0x57DeF08fdafA9Ae9428bCCE440c624CC83B1f6F8) | [`0x0bfa...5682`](https://scan.bohr.life/tx/0x0bfa3a9dee34de054937f337f2883ca7e112d0f4f8fc8a73e8d32a7ff5435682) |
| DMH Test Token | [`0x8F1Bbd85d6099177e2E83aE4706a1350b203D18a`](https://scan.bohr.life/address/0x8F1Bbd85d6099177e2E83aE4706a1350b203D18a) | [`0x4ea1...d5ce`](https://scan.bohr.life/tx/0x4ea1e6fe5736567eefbb05341b83c055c0aa55281baa06fb519e3e9930ebd5ce) |
| DMH Test NFT | [`0xFa83790cA269A81f7AA63aB583996b15f31fe00b`](https://scan.bohr.life/address/0xFa83790cA269A81f7AA63aB583996b15f31fe00b) | [`0x0353...f971`](https://scan.bohr.life/tx/0x0353b337661dbcdf8bfff2a4eed2edb5b75f0570e7d389a7649a8ad448d7f971) |

All three contracts are source-verified on BOT Blockscout using Solidity `0.8.24`, optimizer enabled with 500 runs.

- Chain ID: `968`
- Base claim fee: `0.001 BOT`
- Immutable fee recipient: `0x3d53CB82BffA53bdA7217aD3F8a640fE7c052a6e`
- Mainnet chain `677`: intentionally disabled

## Live Validation

Vault `2` completed a real setup-to-claim cycle against the hardened deployment on chain `968`:

| Step | Transaction |
|---|---|
| Fee-recipient probe | [`0x56a0...91f`](https://scan.bohr.life/tx/0x56a039f9ca8e7a6285f793159e6dd550188d6993390b15ea4c27e92022bab91f) |
| Mint 1,000 DTT | [`0xbc85...e036`](https://scan.bohr.life/tx/0xbc8520932e92e897df54ab537ae341b23647947028ec04c881854a0f9899e036) |
| Mint test NFT | [`0x2268...5f4f`](https://scan.bohr.life/tx/0x22687a601d71c8c778bb9db3937d95e41fa9669ae514f2781395ae0b6a125f4f) |
| Create one-minute vault | [`0x600f...7791`](https://scan.bohr.life/tx/0x600fa510bbc0920020e1c2e9207447ceaa1acb27bc4a05aafb683d822a727791) |
| Register DTT | [`0x7ea6...e952`](https://scan.bohr.life/tx/0x7ea6e2209407c3114f622cefd515a8d42ff3dba6216eb08ca421b20d7fdbe952) |
| Register NFT | [`0xf136...ae76`](https://scan.bohr.life/tx/0xf1362fecb37e5a38fb0773553701e23e2b1542ce79d06d90d664282c323aae76) |
| Approve DTT | [`0x7ba1...43d`](https://scan.bohr.life/tx/0x7ba184e695713e1df4036ef160b6ad63588855e04558bd96eeb616009cbe043d) |
| Approve NFT | [`0xc012...f2e`](https://scan.bohr.life/tx/0xc0120fc007fbf64c1f804de970d616be0da985e2312efc396ef179ac4698af2e) |
| Dual-signature claim | [`0xc58f...a940`](https://scan.bohr.life/tx/0xc58fcc447eec27713d9b58c61df61520ab16f7a60088228f022815c0a6eda940) |
| Deactivate validated vault | [`0xd3d3...d6ce`](https://scan.bohr.life/tx/0xd3d347fbe01a35910ac546d734b58194265d28633d460616e3b23e56dd2cd6ce) |
| Revoke NFT approval | [`0x0d07...0230`](https://scan.bohr.life/tx/0x0d07ab65dd3b1a5b6055461dd0ac02967e5e17df911608c25b2d6625687c0230) |

Result: `1,000 DTT` and NFT `#2` moved directly from the deployer wallet to `0x3d53CB82BffA53bdA7217aD3F8a640fE7c052a6e`; the vault nonce advanced to `1`. The validated vault was then deactivated and its remaining operator approval revoked.

## Security Model

- Two mandatory, independent phrase-derived signers.
- No phrase or derived private key is sent on-chain.
- Signed destination makes copied claims unable to redirect assets.
- Per-vault nonce prevents replay.
- EIP-712 domain and KDF chain binding prevent cross-chain reuse.
- Per-caller fee escalation and cooldown avoid vault-wide griefing.
- No upgrade proxy or administrative asset-control key.

> **CLAIMED is not closed:** after a successful claim the vault remains immediately claimable, cannot be pinged, and newly received assets from registered token contracts can be swept under existing approvals without another waiting period. Deactivate the vault and revoke every approval to stop future sweeps.

See `docs/DECISIONS.md` and `docs/CRYPTO_SPEC.md` before changing security-sensitive behavior.

## Development

```bash
npm install
npm run compile
npm test
```

BOT Chain testnet is chain `968`. Mainnet chain `677` intentionally has no configured DMH address and fails closed.
