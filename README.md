# Dead Man's Hand v2

DMH v2 is a testnet-first, non-custodial inheritance and emergency-access protocol for BOT Chain. Assets remain in the owner's wallet and can be swept only after inactivity with two phrase-derived EIP-712 signatures.

> Status: deployed to BOT Chain testnet. Reviewed design, unaudited implementation. Do not use with real value.

## Testnet Deployment

| Component | Address | Deployment transaction |
|---|---|---|
| DMH v2 | [`0x2560Ad3B98bbF47d6c1A5A36ebC557F8e3d64f00`](https://scan.bohr.life/address/0x2560Ad3B98bbF47d6c1A5A36ebC557F8e3d64f00) | [`0x3b25...77e0`](https://scan.bohr.life/tx/0x3b25de170aaa3d9918bcbf03fcf252610d07fef483093ea90e8745bf3bc377e0) |
| DMH Test Token | [`0xB0C6A739fF2458d27e8C9B9A719CE1859FE0B47F`](https://scan.bohr.life/address/0xB0C6A739fF2458d27e8C9B9A719CE1859FE0B47F) | [`0xe61f...0c97`](https://scan.bohr.life/tx/0xe61f2cddc0e963c6a5d2d4723fef7d49cc7811dcad9d520f9b4b47ee0c4d0c97) |
| DMH Test NFT | [`0x7F7044782e51221C88dCD131ff685D109D7Cb3Cd`](https://scan.bohr.life/address/0x7F7044782e51221C88dCD131ff685D109D7Cb3Cd) | [`0x5316...9327`](https://scan.bohr.life/tx/0x5316001b78e216049aca445cd8ecc9d1d425331de9e354a8171721b979939327) |

All three contracts are source-verified on BOT Blockscout using Solidity `0.8.24`, optimizer enabled with 500 runs.

- Chain ID: `968`
- Base claim fee: `0.001 BOT`
- Immutable fee recipient: `0x3B81167efca849a04524172b1A678A424F2e7C84`
- Mainnet chain `677`: intentionally disabled

## Live Validation

Vault `1` completed a real setup-to-claim cycle on chain `968`:

| Step | Transaction |
|---|---|
| Mint 1,000 DTT | [`0x3b26...f3a4`](https://scan.bohr.life/tx/0x3b26206044b409c64f6571a6becfcd43ec0f0a1de0d980d122bd74e3a6b7f3a4) |
| Mint test NFT | [`0x7015...a21d`](https://scan.bohr.life/tx/0x701502e077db526195fb57e967bf2dc72d3ab38b6dcac1759ff553058336a21d) |
| Create one-minute vault | [`0x3053...514c`](https://scan.bohr.life/tx/0x305388689c243fb97fec9a2ae777779c05959bb163a256c8a5c6e4342c36514c) |
| Register DTT | [`0xf561...aeb0`](https://scan.bohr.life/tx/0xf561203dd617019f1583a8eeddd6c21265687943ea2dc2915881fe530d97aeb0) |
| Register NFT | [`0xfbf6...c8e0`](https://scan.bohr.life/tx/0xfbf6330a08bacf953a9e667159aeb6d2286b6e9aee7e96122faae05cd560c8e0) |
| Approve DTT | [`0x7f1a...77e0`](https://scan.bohr.life/tx/0x7f1af23fdb44f7ec322a5125a8c8ae1171b7f29c03f3a224cc9777ea5bbe77e0) |
| Approve NFT | [`0x8899...2567`](https://scan.bohr.life/tx/0x8899e67286919cb7cc7903298af07f827bd67be9cff6ec7c248b9ba481502567) |
| Dual-signature claim | [`0x9d84...8a59`](https://scan.bohr.life/tx/0x9d84dc2101f99359ef22b2f925e40c90f6c28d3c4114926ed4082285c8ff8a59) |

Result: `1,000 DTT` and NFT `#1` moved directly from the deployer wallet to `0x3B81167efca849a04524172b1A678A424F2e7C84`; the vault nonce advanced to `1`.

## Security Model

- Two mandatory, independent phrase-derived signers.
- No phrase or derived private key is sent on-chain.
- Signed destination makes copied claims unable to redirect assets.
- Per-vault nonce prevents replay.
- EIP-712 domain and KDF chain binding prevent cross-chain reuse.
- Per-caller fee escalation and cooldown avoid vault-wide griefing.
- No upgrade proxy or administrative asset-control key.

See `docs/DECISIONS.md` and `docs/CRYPTO_SPEC.md` before changing security-sensitive behavior.

## Development

```bash
npm install
npm run compile
npm test
```

BOT Chain testnet is chain `968`. Mainnet chain `677` intentionally has no configured DMH address and fails closed.
