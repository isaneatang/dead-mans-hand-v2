# DMH v2 Architecture Decisions

This document resolves conflicts in the original build prompt. It is normative for the implementation.

## Authorization

- Every vault requires two distinct phrase-derived secp256k1 signers and both signatures.
- The two public signer addresses provide 2-of-2 authorization and compromise compartmentalization. They do not multiply offline guessing cost because each public address is an independent offline oracle.
- Signatures authorize `vaultId`, `destination`, and the current nonce through EIP-712. The EIP-712 domain binds chain ID and contract address.
- Any funded account may relay a claim. Copying signatures cannot redirect assets because the destination is signed.
- Malformed and incorrect signatures follow one uniform protocol-failure path. The contract uses `ECDSA.tryRecover`, not reverting `ECDSA.recover`.

## Key Derivation

- Each vault receives a browser-generated public random `bytes32 vaultSalt` before creation.
- The KDF salt includes slot, lowercase owner address, decimal chain ID, and lowercase 32-byte vault salt.
- The public vault salt prevents key reuse and correlation across an owner's vaults. It is uniqueness, not secrecy.
- NFC normalization only resolves canonical Unicode equivalence. Internal whitespace, punctuation, homoglyphs, and non-canonical visual similarities remain byte-sensitive.

## Vault And Asset Model

- The constrained MVP allows one non-deactivated vault per owner. A single contract allowance cannot safely allocate the same owner's assets among competing vaults.
- Assets remain in the owner's wallet. DMH receives conditional transfer authorization, which still creates smart-contract risk.
- Only registered ERC-20 and enumerable ERC-721 assets are supported. Native BOT, ERC-1155, and non-enumerable ERC-721 are excluded.
- ERC-20 allowance amount is chosen explicitly by the owner. The UI must not silently request an unlimited allowance.
- A claim has a global NFT transfer cap, not a per-collection-only cap. Freshly signed claims can sweep leftovers.

## Fees And Cooldowns

- Failure counts, escalating fees, and cooldowns are scoped to `vaultId + caller`. One caller cannot increase another caller's fee.
- A claim must send the exact required fee. There is no excess-refund external call.
- Failed authorization returns rather than reverting so its fee and cooldown remain effective. For five minutes after a successful claim, a pair of signatures valid for exactly the immediately previous nonce is treated as a stale legitimate race and reverts before fee forwarding or failure accounting. The bounded grace period covers ordinary transaction races without making public claim calldata a permanent fee-free replay. Nonce zero has no previous nonce and uses the uniform failed-authorization path.
- The immutable fee recipient must accept native BOT. Deployment must test this property.
- The deployment script requires the immutable fee recipient to be an EOA. The fixed 150,000 gas transfer budget is retained because increasing it would amplify hostile-token gas griefing; transfers that exceed it are skipped.
- Token-call returndata is copied only after checking its size and never beyond 32 bytes, preventing return-data bombs from expanding claim memory.
- The contract retains no value received through normal DMH calls. Unsolicited native currency can still be forced to a contract address, so an absolute zero-balance claim is not made.

## State And Reporting

- Vault IDs begin at 1 and every view validates existence where ambiguity matters.
- `ping`, token registration, and token removal are ACTIVE-only.
- A successful claim moves the vault to CLAIMED. CLAIMED vaults remain claimable for bounded leftover sweeps but cannot be pinged or edited.
- CLAIMED vaults have no renewed waiting period. Newly received assets from registered token contracts are immediately sweepable under existing approvals until the owner deactivates the vault and revokes approvals.
- The owner may permanently deactivate an ACTIVE or CLAIMED vault.
- Claim maturity uses `block.timestamp >= lastPing + inactivityPeriod`.
- Receipt events distinguish protocol success from protocol failure and report successful and skipped token operations. A transaction containing `ClaimFailed` has EVM status 1 but is not a successful claim.

## Frontend Supply Chain

- Runtime JavaScript and fonts are bundled and self-hosted. No CDN scripts, analytics, or third-party code run on phrase-entry pages.
- A restrictive Content Security Policy is required.
- Production serves CSP as an HTTP response header because `frame-ancestors` is ignored in an HTML meta policy. The bundled frontend does not require `unsafe-inline` or `unsafe-eval`.
- The policy is duplicated in `frontend/index.html`, `frontend/public/_headers`, and `frontend/vite.config.ts`. Browsers enforce every received policy independently, so all three must change together.
- `script-src` allows `chrome-extension:`, `moz-extension:`, and `safari-web-extension:`. Extension wallets inject their inpage provider as a script element with an extension-scheme URL, and the page CSP applies to it. This is the minimum allowance that makes extension wallets usable; `unsafe-inline` and `unsafe-eval` are not substitutes for it and stay excluded.
- Phrases and derived keys are never logged, transmitted, or persisted. JavaScript cannot guarantee physical RAM zeroing, and documentation must say so.
- Private-key derivation, public-address derivation, and EIP-712 signing stay inside the crypto worker. The main UI receives only public addresses and signatures.

## Wallet Discovery

- Wallets are found through EIP-6963 announcements first, with `window.ethereum` (including the legacy `providers` array) as a fallback for wallet in-app browsers that do not announce. A provider already announced is never listed twice.
- `window.ethereum` alone is insufficient: a single slot cannot hold two extensions, and several extensions no longer write it at all.
- Provider flags such as `isMetaMask` are set by unrelated wallets and are used only to label legacy fallback entries, never to choose between wallets.
- When more than one wallet is discovered the user chooses. Silent selection is treated as a bug.
- One selected provider is shared by connect, network switching, and account/chain subscriptions, and subscriptions rebind when the selection changes or a wallet appears after mount.
- Discovery waits a bounded interval rather than failing on the first tick, because both extensions and wallet in-app browsers inject asynchronously.
