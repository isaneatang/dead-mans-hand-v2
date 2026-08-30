# DMH v2 Cryptographic Specification

This is the normative cross-implementation format. A change requires new test vectors and coordinated frontend, CLI, and documentation updates.

## Phrase Intake

1. Accept Unicode text.
2. Normalize with NFC.
3. Remove leading and trailing characters from this frozen ECMAScript trim set only: `U+0009-U+000D`, `U+0020`, `U+00A0`, `U+1680`, `U+2000-U+200A`, `U+2028`, `U+2029`, `U+202F`, `U+205F`, `U+3000`, and `U+FEFF`. JavaScript uses `String.prototype.trim()`; other implementations MUST reproduce this exact set rather than use a language's generic Unicode strip operation.
4. Preserve every internal byte after UTF-8 encoding, including spaces and line breaks.
5. Reject empty setup phrases, phrases shorter than 20 Unicode code points, and identical normalized Phrase A and Phrase B values.
6. Strength meters are guidance, not proof of entropy. Claims are never blocked by present-day strength policy.

## Public Vault Salt

Generate 32 random bytes with the operating system cryptographic RNG before deriving either key. Encode as lowercase `0x`-prefixed hexadecimal and submit it to `createVault` with the two derived addresses.

## KDF

For each slot `A` or `B`:

```text
salt_string = "DMHv2|slot:" + SLOT
            + "|owner:" + LOWERCASE_OWNER_ADDRESS
            + "|chain:" + DECIMAL_CHAIN_ID
            + "|vaultSalt:" + LOWERCASE_0X_BYTES32

candidate = PBKDF2-HMAC-SHA256(
  password = UTF8(NFC(phrase).trim()),
  salt = UTF8(salt_string),
  iterations = 600000,
  dkLen = 32
)
```

Interpret `candidate` as an unsigned big-endian integer. It is valid when `1 <= candidate < secp256k1_n`, where:

```text
secp256k1_n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
```

If invalid, rerun PBKDF2 with `salt_string + "|retry:1"`, then increment the retry number until valid. The iteration count and original password do not change.

The Ethereum address is the last 20 bytes of Keccak-256 of the uncompressed secp256k1 public key, excluding its `0x04` prefix.

## EIP-712 Claim

Domain:

```text
name: "DeadMansHandV2"
version: "2"
chainId: active chain ID
verifyingContract: deployed DMH v2 contract address
```

Type:

```text
ClaimAuthorization(uint256 vaultId,address destination,uint256 nonce)
```

Both phrase-derived keys sign the same typed data. The nonce is read immediately before signing. Only `vaultId`, `destination`, `sigA`, and `sigB` are submitted; the contract reads its authoritative nonce.

## Memory And Transport

- Never send phrases or private keys through RPC, fetch, XHR, analytics, logs, browser storage, cookies, URLs, or wallet transaction calldata.
- Derivation and signing occur in local memory.
- Drop references immediately after use. JavaScript garbage collection does not guarantee physical memory erasure.
