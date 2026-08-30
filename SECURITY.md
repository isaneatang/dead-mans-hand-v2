# Security Policy

DMH v2 is an unaudited testnet implementation. Do not approve assets with real value.

## Threat Model

- Phrases and derived keys remain local; only public signer addresses and EIP-712 signatures are transmitted.
- The signed destination prevents mempool copies from redirecting assets.
- A monotonic vault nonce prevents same-contract replay. EIP-712 domain separation prevents cross-chain and cross-contract replay.
- Two signer addresses provide 2-of-2 authorization and separately stored compromise resistance. They do not multiply offline guessing work because each public address can be tested independently.
- PBKDF2 slows guessing but cannot rescue a weak or publicly known phrase. Original high-entropy phrases are the user's security contribution.
- Caller-scoped fees and cooldowns deter repeated calls without allowing one caller to raise another caller's fee.

## Browser Limits

JavaScript cannot guarantee physical RAM erasure. The frontend guarantee is that phrases and private keys are never intentionally persisted, logged, transmitted, or placed in wallet calldata. Bundled dependencies and a restrictive Content Security Policy reduce, but do not eliminate, browser supply-chain risk.

The claim UI may compare locally derived addresses with public registered signers. This reveals nothing unavailable to an offline attacker and is never emitted on-chain.

## Contract Limits

- Assets stay in the owner wallet, but approvals grant DMH conditional transfer authority and therefore expose assets to implementation risk.
- Only registered ERC-20 and enumerable ERC-721 assets are supported.
- Native BOT, ERC-1155, and non-enumerable ERC-721 are excluded.
- At most 20 NFTs transfer per claim; leftovers require new signatures over the next nonce.
- Broken token contracts are skipped using bounded calls, but no software can make arbitrary hostile token behavior risk-free.
- The owner may revoke approvals or move assets, leaving nothing to sweep. This is intrinsic to non-custody.
- There is no guardian dispute window, automated keeper, recovery backdoor, proxy, or upgrade key.
- One non-deactivated vault is allowed per owner because contract-level token allowances cannot safely distinguish competing vault allocations.
- The immutable fee recipient must accept native BOT or fee-bearing claims will revert.

## Disclosure

No production disclosure channel exists yet. Do not deploy to mainnet until one is published and an independent smart-contract security review is complete.
