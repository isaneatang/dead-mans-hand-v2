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
- Failed authorization returns rather than reverting so its fee and cooldown remain effective.
- The immutable fee recipient must accept native BOT. Deployment must test this property.
- The contract retains no value received through normal DMH calls. Unsolicited native currency can still be forced to a contract address, so an absolute zero-balance claim is not made.

## State And Reporting

- Vault IDs begin at 1 and every view validates existence where ambiguity matters.
- `ping`, token registration, and token removal are ACTIVE-only.
- A successful claim moves the vault to CLAIMED. CLAIMED vaults remain claimable for bounded leftover sweeps but cannot be pinged or edited.
- The owner may permanently deactivate an ACTIVE or CLAIMED vault.
- Claim maturity uses `block.timestamp >= lastPing + inactivityPeriod`.
- Receipt events distinguish protocol success from protocol failure and report successful and skipped token operations. A transaction containing `ClaimFailed` has EVM status 1 but is not a successful claim.

## Frontend Supply Chain

- Runtime JavaScript and fonts are bundled and self-hosted. No CDN scripts, analytics, or third-party code run on phrase-entry pages.
- A restrictive Content Security Policy is required.
- Phrases and derived keys are never logged, transmitted, or persisted. JavaScript cannot guarantee physical RAM zeroing, and documentation must say so.
