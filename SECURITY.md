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

JavaScript cannot guarantee physical RAM erasure. The frontend guarantee is that phrases and private keys are never intentionally persisted, logged, transmitted, or placed in wallet calldata. Private-key derivation, address derivation, and EIP-712 signing run inside a dedicated web worker; only public addresses and signatures return to the main UI thread. Phrases still exist in UI and worker memory, and garbage collection cannot guarantee their physical erasure. Bundled dependencies and a restrictive Content Security Policy reduce, but do not eliminate, browser supply-chain risk.

The claim UI compares both locally derived addresses with both public registered signers as one combined check. It does not identify which entry mismatched. After repeated mismatches the UI adds a short local delay, but this is only friction for manual attempts: an attacker can bypass the frontend and test guesses offline without any on-chain fee, cooldown, or visibility.

The HTML meta policy is a fallback, not the complete deployment control. Production hosting MUST send the same CSP as an HTTP response header and include `frame-ancestors 'none'`; browsers ignore `frame-ancestors` in a meta policy. The policy intentionally excludes `unsafe-inline` and `unsafe-eval`. `frontend/public/_headers` supplies CSP and related headers for hosts that support the Cloudflare Pages/Netlify headers format; other hosts must install equivalent response-header configuration.

## Asset Discovery Privacy

The owner may opt in to "Scan my wallet for assets", which asks the public BOT explorer which tokens an address holds. This sends the owner address to a third party and therefore links that address to the browser session. It is never automatic, manual entry always remains available, and no phrase, private key, or signature is ever sent to the explorer.

## Contract Limits

- **CLAIMED vaults are not closed.** A CLAIMED vault remains immediately claimable, cannot be pinged back to ACTIVE, and has no new waiting period. Assets newly received by the owner from registered token contracts can be swept under still-live approvals. To stop future claims, the owner must deactivate the vault and revoke every token approval.
- Assets stay in the owner wallet, but approvals grant DMH conditional transfer authority and therefore expose assets to implementation risk.
- Only registered ERC-20 and enumerable ERC-721 assets are supported.
- Native BOT, ERC-1155, and non-enumerable ERC-721 are excluded.
- At most 20 NFTs transfer per claim; leftovers require new signatures over the next nonce.
- Broken token contracts are skipped using bounded calls, but no software can make arbitrary hostile token behavior risk-free.
- The owner may revoke approvals or move assets, leaving nothing to sweep. This is intrinsic to non-custody.
- There is no guardian dispute window, automated keeper, recovery backdoor, proxy, or upgrade key.
- One non-deactivated vault is allowed per owner because contract-level token allowances cannot safely distinguish competing vault allocations.
- The immutable fee recipient must accept native BOT or fee-bearing claims will revert.
- The deployment script rejects contract fee recipients; use an EOA and verify its control before deployment.
- ERC-20 and ERC-721 transfers use a fixed 150,000 gas budget. Transfers requiring more gas are skipped safely, so registered assets and destinations should be tested before production use.
- For five minutes after a successful claim, a pair of signatures valid for exactly the immediately previous nonce is treated as a stale legitimate race and reverts without fee or cooldown. After that grace period, replays use the uniform failed-authorization path. At nonce zero there is no previous nonce.
- Sweep events report what token contracts returned; they are not independent proof that a hostile or non-compliant token changed balances or ownership correctly. Verify valuable asset movement on the token contract.

## Disclosure

No production disclosure channel exists yet. Do not deploy to mainnet until one is published and an independent smart-contract security review is complete.
