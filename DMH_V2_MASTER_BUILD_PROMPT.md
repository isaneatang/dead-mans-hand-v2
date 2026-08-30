# MASTER BUILD PROMPT — Dead Man's Hand v2 (DMH v2)
## Dual-Phrase, Signature-Based Crypto Inheritance Protocol on BOT Chain

> **You are a senior smart-contract + full-stack engineer.** Build the complete DMH v2 system
> exactly as specified below. Do not simplify the cryptographic flow, do not substitute the
> claim mechanism, and do not deviate from the security invariants in §5.9 and §11.
> Where this document says MUST, it is non-negotiable. Where it says SHOULD, deviate only
> with a written justification in the README.

---

## 0. MISSION IN ONE PARAGRAPH

DMH v2 is a **non-custodial inheritance / emergency-access vault** on BOT Chain. An owner
registers assets they already hold (nothing moves up front — only ERC-20 `approve()` /
ERC-721 `setApprovalForAll()` granted **to the vault contract**). The owner proves liveness
by calling `ping()`. If the owner goes silent past a configurable inactivity period, the vault
becomes claimable. **Claiming never transmits a secret**: at setup, two independent,
self-composed, high-entropy secret phrases are each run through a slow KDF **locally in the
browser** to deterministically derive two private keys; only the two derived **public
addresses** are registered on-chain. To claim, the beneficiary re-types both phrases, the
frontend re-derives both keys locally, each key signs an **EIP-712 message binding
vaultId + destination + nonce + chainId + contract address**, and only the two signatures are
broadcast. The contract verifies both via `ecrecover` against the registered addresses, checks
the inactivity gate, and sweeps registered assets from the owner's wallet to the signed
destination. This design defeats: plaintext leak (nothing secret ever touches the chain),
front-running (copied signatures still pay out to the signed destination), replay across
transactions/chains (nonce + EIP-712 domain), and brute-force (two independent high-entropy
phrases behind a deliberately slow KDF).

**Philosophy: "chain as witness."** The chain never has custody of secrets or assets — it
only witnesses commitments and verifies proofs. Honest constrained MVP over overbuilt vaporware.
Every known limitation is documented, never hidden.

---

## 1. NETWORK ENVIRONMENT (verified against dev-docs.botchain.ai)

This project deploys to **BOT Chain Testnet first**, architected for a clean mainnet switch.

| | Testnet (ACTIVE TARGET) | Mainnet (PREPARED, FAIL-CLOSED) |
|---|---|---|
| Chain ID | `968` | `677` |
| RPC | `https://rpc.bohr.life` | `https://rpc.botchain.ai` |
| Explorer | `https://scan.bohr.life` | `https://scan.botchain.ai` |
| Native token | BOT (gas) | BOT (gas) |
| Faucet | `https://faucet.botchain.ai/basic` | n/a (B DEX: `https://dex.botchain.ai/#/swap`) |

Chain facts that matter to the design:
- 100% EVM-compatible, Geth-API compatible. Standard tooling: Hardhat, Foundry, Remix,
  ethers.js, viem, MetaMask all work unmodified. `ecrecover` (precompile 0x01) is standard EVM
  and guaranteed present.
- Consensus: Parlia (PoSA), 0.75s blocks, fast finality. **Standard fee-priority mempool —
  no fair-ordering guarantees.** This is exactly why the claim mechanism MUST be
  signature-based, never plaintext-based.
- `eth_getLogs` is disabled on the public mainnet RPC endpoints — do not build any frontend
  feature that depends on wide log scans; read state via view functions instead.

**Network config MUST live in one file** (`config/chains.ts`), keyed by chainId, containing:
rpcUrl, explorerUrl, contract address, faucetUrl. The mainnet entry MUST ship with
`dmhAddress: null` so the app **fails closed** on mainnet (shows "not yet deployed on mainnet"
instead of guessing an address). The frontend MUST offer `wallet_addEthereumChain` /
`wallet_switchEthereumChain` prompts to add/switch to testnet 968 automatically.

---

## 2. THREAT MODEL — WHY EVERY DESIGN DECISION EXISTS

You MUST understand these before writing code. Each maps to a mechanism you will build.

| # | Threat | Why it's real | Mechanism that defeats it |
|---|---|---|---|
| T1 | **Plaintext leak at claim** | Any calldata is permanently public; a plaintext secret submitted to a contract is burned forever the instant it hits the mempool | Secrets never leave the browser. Only ECDSA signatures are broadcast |
| T2 | **Mempool front-running** | Validators order by gas fee, not arrival; bots copy valid claim data and outbid | Signatures bind `destination` inside the EIP-712 payload. A copied tx still pays out to the signed destination — copying is economically pointless |
| T3 | **Signature replay (same chain)** | Deterministic signatures are static, copyable data | Per-vault monotonic `nonce` inside the signed payload, incremented on every claim execution |
| T4 | **Cross-chain / cross-contract replay** | Same phrases reused on testnet + mainnet ⇒ a testnet signature could drain the mainnet vault | Full EIP-712 domain: `chainId` + `verifyingContract` baked into every digest. ALSO chainId is in the KDF salt so testnet and mainnet derive different keys entirely |
| T5 | **Offline brute-force of phrases** | Registered addresses are public; attacker can guess phrases offline, derive keys, compare addresses — the contract never sees this | Two *independent*, self-composed, high-entropy phrases + slow KDF (PBKDF2-HMAC-SHA256, 600k iterations) + strong frontend entropy guidance. NOTE HONESTLY: this is the one threat mitigated by user behavior, not math |
| T6 | **Side-channel: which phrase failed?** | If the contract/UI reveals "sig A ok, sig B wrong", attacker brute-forces each phrase independently — halving the work | Uniform failure: identical revert, identical fee escalation, identical event regardless of which signature(s) failed |
| T7 | **Griefing / lockout via cooldown** | With signatures, on-chain guessing is useless to attackers — so a *global* cooldown would only be a weapon to lock out the real beneficiary by spamming garbage sigs | Cooldown is **per-caller**, not per-vault. Escalating fee (paid in native BOT) still deters spam |
| T8 | **Malicious destination redirection** | If destination were a loose tx parameter, a relayer/front-runner could redirect funds | Destination is inside the signed EIP-712 payload; contract sends ONLY to the recovered signed destination |
| T9 | **Signature malleability** | ECDSA (r,s,v) has a malleable s | Use OpenZeppelin `ECDSA.recover` (rejects high-s) — never raw `ecrecover` |
| T10 | **Gas-bomb collections** | Sweeping a 10,000-item enumerable NFT collection in one tx exceeds block gas | Bounded sweep (cap per collection per claim tx) + skip-and-continue + repeatable claims |

---

## 3. SYSTEM ARCHITECTURE

```
┌─────────────────────────  OWNER'S BROWSER (setup)  ─────────────────────────┐
│ Phrase A ─┐                                                                 │
│           ├─ NFC normalize ─ trim ─ PBKDF2(600k) ─► privKeyA ─► addrA ─┐    │
│ Phrase B ─┘                                        privKeyB ─► addrB ─┤    │
│   (phrases + keys NEVER leave this box; keys wiped from memory after) │    │
└────────────────────────────────────────────────────────────────────────┼────┘
                                                                         ▼
┌──────────────────────────  BOT CHAIN TESTNET (968)  ────────────────────────┐
│  DeadMansHandV2.sol                                                         │
│  createVault(addrA, addrB, inactivityPeriod)      ── stores ONLY addresses  │
│  addToken()/removeToken()  (≤50 entries)          ── registry, no custody   │
│  owner's EOA: approve(DMH, …) / setApprovalForAll ── allowance to CONTRACT  │
│  ping()                                           ── heartbeat, owner only  │
│  attemptClaim(vaultId, dest, sigA, sigB)          ── ecrecover ×2, sweep    │
└─────────────────────────────────────────────────────────────────────────────┘
                                                                         ▲
┌─────────────────────  BENEFICIARY'S BROWSER (claim)  ───────────────────┼────┐
│ Re-type Phrase A + Phrase B ─► re-derive privKeyA, privKeyB (same KDF)  │    │
│ Read vault nonce from chain ─► build EIP-712 ClaimAuthorization         │    │
│ Sign with BOTH derived keys (locally, ethers Wallet.signTypedData)      │    │
│ Broadcast ONLY {vaultId, destination, sigA, sigB} from ANY funded wallet ────┘
│ (derived addresses never need gas — any wallet can be the tx submitter) │
└──────────────────────────────────────────────────────────────────────────────┘
```

Key property to preserve: **the transaction submitter (`msg.sender`) is irrelevant to
authorization.** Authorization comes entirely from the two signatures. This makes the claim
relayer-friendly and makes front-running harmless (T2).

---

## 4. CRYPTOGRAPHIC SPECIFICATION (FROZEN — identical in JS frontend and Python CLI)

These parameters are **consensus-critical between implementations**. A single divergence
(encoding, iteration count, salt byte layout) silently produces different keys and permanently
locks users out. Freeze them, publish test vectors, test both implementations against them in CI.

### 4.1 Phrase intake rules (apply identically at setup and claim)
1. Accept **any Unicode text** — full multilingual support (Japanese, Arabic, emoji, poems,
   kanji + private translation, line breaks). This is a headline feature, not an accident.
2. Normalize: `phrase = phrase.normalize("NFC")` — MANDATORY, both setup and claim, both
   implementations (Python: `unicodedata.normalize("NFC", phrase)`).
3. Trim **leading and trailing** whitespace only. **Preserve internal whitespace and line
   breaks exactly** — they are deliberate entropy.
4. Reject empty phrases; enforce a minimum of 20 characters AND an entropy estimate
   (zxcvbn or equivalent) of "strong" before allowing setup to proceed. Advisory only at claim
   time (never block a claim on strength — the phrase is what it is).
5. Phrase A and Phrase B MUST differ (reject identical inputs at setup).

### 4.2 Key derivation (per phrase slot)
```
salt_string = "DMHv2|slot:" + SLOT + "|owner:" + LOWERCASE_OWNER_ADDRESS + "|chain:" + CHAIN_ID
            // SLOT ∈ {"A","B"}; owner address lowercase hex WITH 0x prefix; CHAIN_ID decimal, e.g. "968"

privKey = PBKDF2-HMAC-SHA256(
            password  = UTF8_BYTES(normalized_trimmed_phrase),
            salt      = UTF8_BYTES(salt_string),
            iterations= 600000,
            dkLen     = 32 )
```
- **Why no vaultId in the salt:** the vaultId does not exist until after vault creation, but
  keys must be derived *before* creation (their addresses are constructor inputs). Owner
  address + slot + chainId already gives per-owner, per-slot, per-network uniqueness.
  Do NOT "improve" this by adding vaultId — that is a chicken-and-egg bug.
- **Why chainId is in the salt:** same phrases on testnet and mainnet derive *different* keys,
  so a testnet key compromise never touches the mainnet vault (defense-in-depth on top of T4).
- Edge case: if `privKey mod secp256k1_order == 0` or ≥ order (probability ~2⁻¹²⁸, i.e. never),
  re-derive with `salt_string + "|retry:1"`. Handle it anyway; both implementations identically.
- Derive address via standard secp256k1 → keccak256(pubkey)[12:] (ethers `new Wallet(privKey).address`).
- Use WebCrypto `crypto.subtle.deriveBits` for PBKDF2 in the browser (native speed);
  `hashlib.pbkdf2_hmac` in Python. ~600k iterations ≈ sub-second on modern hardware,
  a few seconds on an old phone — show a spinner, this is acceptable and intentional.

### 4.3 EIP-712 claim authorization (what each derived key signs)
```
Domain:
  name               = "DeadMansHandV2"
  version            = "2"
  chainId            = <active chain id>          // 968 testnet, 677 mainnet
  verifyingContract  = <deployed DMH v2 address>

Types:
  ClaimAuthorization = [
    { name: "vaultId",     type: "uint256" },
    { name: "destination", type: "address" },
    { name: "nonce",       type: "uint256" }      // read live from chain: vaults[vaultId].nonce
  ]
```
- Both derived keys sign the **same** digest. Two signatures result: `sigA`, `sigB`.
- Contract verifies with OpenZeppelin `EIP712` + `ECDSA.recover` (T9). Never raw `ecrecover`.
- The nonce MUST be read from the contract immediately before signing. After ANY executed
  claim (even partial), the contract increments it, invalidating all previously issued
  signatures (T3).

### 4.4 Memory hygiene (frontend + CLI)
- Never log, persist (localStorage/sessionStorage/IndexedDB/cookies), or transmit phrases or
  derived private keys. Derivation and signing happen in-memory; null out references after use.
- Phrase inputs: `autocomplete="off"`, `spellcheck="false"`, no analytics on those fields.
- State honestly in SECURITY.md: JS cannot guarantee memory zeroing; the guarantee is
  "never stored, never transmitted," not "physically erased from RAM."

---

## 5. SMART CONTRACT SPECIFICATION — `DeadMansHandV2.sol`

Solidity `^0.8.24`. OpenZeppelin: `EIP712`, `ECDSA`, `ReentrancyGuard`, `IERC20`, `IERC721`,
`IERC721Enumerable`. NO proxy/upgradeability — immutable deployment (an upgradeable
inheritance vault is a custody backdoor; say so in SECURITY.md).

### 5.1 Data structures
```solidity
enum VaultState { ACTIVE, CLAIMED, DEACTIVATED }
enum TokenType  { ERC20, ERC721 }

struct TokenEntry { address token; TokenType tokenType; }

struct Vault {
    address owner;            // real EOA holding the assets
    address signerA;          // derived address, phrase slot A
    address signerB;          // derived address, phrase slot B
    uint64  lastPing;         // block.timestamp of last heartbeat
    uint64  inactivityPeriod; // seconds; bounds: 1 minutes .. 3650 days
    uint32  failedAttempts;   // for fee escalation
    uint256 nonce;            // replay protection; ++ on every executed claim
    VaultState state;
    TokenEntry[] tokens;      // ≤ MAX_TOKENS (50)
}

mapping(uint256 => Vault) vaults;          // vaultId = incrementing counter
mapping(address => uint256[]) ownerVaults; // lookup by owner
mapping(uint256 => mapping(address => uint64)) callerCooldownUntil; // PER-CALLER (T7)
```

### 5.2 Constants & fee model
```solidity
uint256 public constant MAX_TOKENS = 50;
uint256 public constant NFT_SWEEP_CAP = 20;        // max NFTs per collection per claim tx (T10)
uint256 public baseClaimFee;                        // in native BOT wei; constructor param (e.g. 0.001 BOT testnet)
uint32  public constant MAX_FEE_DOUBLINGS = 7;      // fee caps at base × 128
uint64  public constant COOLDOWN_DURATION = 1 hours;// per-caller, self-expiring
address public immutable feeRecipient;              // fees forwarded immediately; contract NEVER holds value
```
- `currentClaimFee(vaultId) = baseClaimFee << min(failedAttempts, MAX_FEE_DOUBLINGS)`.
- Fee is paid in **native BOT via `msg.value`** (v1's "1 USDT" is replaced — no reliable
  canonical USDT on testnet). Forward the exact fee to `feeRecipient` immediately
  (`call{value:...}`); refund any excess `msg.value` to the caller. The contract's balance
  MUST be zero at the end of every transaction — assert this in tests.

### 5.3 Functions

**`createVault(address signerA, address signerB, uint64 inactivityPeriod) → uint256 vaultId`**
- Requires: signerA/signerB nonzero, distinct from each other AND from msg.sender
  (owner's own EOA must not be a claim signer); period within bounds.
- Sets owner = msg.sender, lastPing = now, state = ACTIVE, nonce = 0.
- Emits `VaultCreated(vaultId, owner, signerA, signerB, inactivityPeriod)`.

**`addToken(uint256 vaultId, address token, TokenType t)` / `removeToken(...)`** — owner only,
ACTIVE only, ≤50 entries, no duplicates. Registry only — approvals happen as separate direct
calls from owner's EOA to each token contract (`approve(dmh, amount)` /
`setApprovalForAll(dmh, true)`). The frontend orchestrates those; the vault contract never
initiates them.

**`ping(uint256 vaultId)`** — STRICTLY owner only (T-adjacent: anyone else resetting the clock
breaks the inheritance trigger; anyone maliciously *not* being able to call it is the point).
Sets lastPing = now. Emits `Pinged`.

**`deactivateVault(uint256 vaultId)`** — owner only. State → DEACTIVATED, permanent. Frontend
MUST remind the owner to also revoke the ERC-20/721 approvals (list them with revoke buttons).

**`isClaimable(uint256 vaultId) → bool`** — view:
`state != DEACTIVATED && block.timestamp > lastPing + inactivityPeriod`.
(CLAIMED vaults remain claimable for leftover-sweep re-claims — see 5.5.)

**`attemptClaim(uint256 vaultId, address destination, bytes sigA, bytes sigB)` payable** — see 5.4.

Views: `getVault`, `getVaultTokens`, `currentClaimFee`, `vaultsOf(owner)`, `remainingTime(vaultId)`.

### 5.4 `attemptClaim` — exact order of operations
```
 1. Vault exists; state != DEACTIVATED.
 2. block.timestamp > lastPing + inactivityPeriod          → else revert VaultNotYetClaimable()
 3. block.timestamp >= callerCooldownUntil[vaultId][msg.sender] → else revert CallerInCooldown()
 4. destination != address(0).
 5. msg.value >= currentClaimFee(vaultId)                   → else revert InsufficientFee()
 6. digest = _hashTypedDataV4(keccak256(abi.encode(
        CLAIM_TYPEHASH, vaultId, destination, vaults[vaultId].nonce)))
 7. okA = (ECDSA.recover(digest, sigA) == signerA)
    okB = (ECDSA.recover(digest, sigB) == signerB)
    // evaluate BOTH before branching — uniform behavior (T6)
 8. if (!(okA && okB)):
        failedAttempts++ (uniform, regardless of which failed)
        callerCooldownUntil[vaultId][msg.sender] = now + COOLDOWN_DURATION
        forward fee to feeRecipient; refund excess
        emit ClaimFailed(vaultId, msg.sender)     // NO detail about which sig failed
        return   // NOT revert — fee must be consumed or spam is free. Return, don't revert.
 9. // success path:
    vaults[vaultId].nonce++            // invalidate these signatures immediately (T3)
    state = CLAIMED
    forward fee; refund excess
    _sweep(vaultId, owner, destination) // skip-and-continue, see 5.5
    emit ClaimExecuted(vaultId, destination, msg.sender)
```
`nonReentrant` on `attemptClaim`. State changes (nonce++, state=CLAIMED) BEFORE any external
token calls (checks-effects-interactions).

**Design note you MUST NOT change:** on wrong signatures the function **returns after
consuming the fee** rather than reverting — a revert would refund the fee and make griefing
free. Document this in the natspec.

### 5.5 `_sweep` — skip-and-continue asset transfer
For each registered TokenEntry:
- **ERC20**: `balance = min(balanceOf(owner), allowance(owner, this))`; if >0,
  `try transferFrom(owner, destination, balance)`. On failure (revert / returns false):
  emit `TokenSkipped(vaultId, token, reason)`, continue. Never let one bad token brick the claim.
- **ERC721**: requires `IERC721Enumerable` (probe via ERC-165 `supportsInterface`). If not
  enumerable → `TokenSkipped`. Else transfer up to `NFT_SWEEP_CAP` tokens via
  `tokenOfOwnerByIndex(owner, 0)` loop (always index 0 — the list shifts as you transfer),
  each in a try/catch (T10).
- **Leftovers are recoverable**: a CLAIMED vault may be claimed again (fresh signatures over
  the *incremented* nonce, fee applies, inactivity gate still satisfied by definition). This
  handles >CAP collections and temporarily-broken tokens. The frontend claim-success screen
  MUST detect skipped/remaining assets and offer "run another sweep."

### 5.6 Events
`VaultCreated`, `TokenAdded`, `TokenRemoved`, `Pinged`, `VaultDeactivated`,
`ClaimFailed(vaultId, caller)`, `ClaimExecuted(vaultId, destination, caller)`,
`TokenSkipped(vaultId, token, bytes32 reason)`, `FeeForwarded(amount)`.

### 5.7 Custom errors (gas + clarity)
`VaultNotFound, NotOwner, VaultNotActive, VaultNotYetClaimable, CallerInCooldown,
InsufficientFee, InvalidDestination, TooManyTokens, DuplicateToken, InvalidSigners,
InvalidPeriod`.
There MUST NOT exist any error or event distinguishing sigA-failure from sigB-failure (T6).

### 5.8 Explicitly OUT of contract scope (document, don't build)
- Native BOT sweeping (no approve mechanism exists for native coin; WBOT wrapping is a
  documented user-side workaround only if a canonical wrapped contract exists — do not deploy
  your own wrapper).
- ERC-1155 (documented exclusion, roadmap item).
- Guardian/veto dispute window (roadmap item — mention in README as v3 candidate).
- Keeper automation (contract is passive by design; claims require a claimant).

### 5.9 SECURITY INVARIANTS — the test suite MUST prove every one
1. No plaintext or key material appears in any calldata, event, or storage — ever.
2. A valid (sigA,sigB) pair replayed after a successful claim MUST fail (nonce moved).
3. Signatures for destination X submitted with tx-param destination Y MUST fail.
4. Signatures made against chainId 677 domain MUST fail on 968 and vice-versa (fork test).
5. Signatures made for a different contract address MUST fail.
6. Failure behavior is byte-identical whether sigA, sigB, or both are wrong (gas may differ
   marginally; events/state MUST NOT).
7. Caller-X cooldown never blocks caller-Y.
8. Contract native balance == 0 after every tx (fees forwarded, excess refunded).
9. One reverting/false-returning token cannot prevent other tokens from sweeping.
10. `ping` from any non-owner reverts. `attemptClaim` before expiry reverts.
11. Reentrancy attempt from a malicious ERC-721 `onERC721Received`-style hook cannot re-enter
    `attemptClaim` or double-sweep.
12. Owner's own EOA cannot be registered as signerA/signerB.

---

## 6. FRONTEND SPECIFICATION

### 6.1 Stack
- Static SPA deployable to Cloudflare Pages (Hono shell serving static assets is fine —
  ALL logic is client-side; there is no backend and there must never be one: a backend that
  ever sees a phrase is a critical vulnerability).
- ethers v6 (or viem) via CDN/bundle; WebCrypto for PBKDF2; zxcvbn for entropy scoring.
- Wallet: MetaMask / injected EIP-1193. Auto-prompt add/switch to chain 968.

### 6.2 Visual design — modeled on commonsmade.com (user's stated preference), verified palette
Calm, editorial, typography-led. Trust and permanence, not crypto-hype.

```
--dmh-bg:      #111713;   /* deep forest-black — page background            */
--dmh-shell:   #0a0f0b;   /* panels / cards                                 */
--dmh-ink:     #f3eedd;   /* warm cream — primary text & accents            */
--dmh-line:    rgba(243,238,221,0.13);  /* hairline borders                 */
--dmh-muted:   rgba(243,238,221,0.54);  /* secondary text                   */
--dmh-quiet:   rgba(243,238,221,0.36);  /* tertiary/labels                  */
--dmh-danger:  #ffaaa5;   /* SOFT salmon — warnings/failures. NEVER harsh red:
                             a failed inheritance claim is a grief moment,
                             not a scolding */
--dmh-success: #8ee0a2;   /* desaturated green — confirmed success ONLY     */
```
Typography:
- Display/headings: **Young Serif** (Google Fonts) — literary, permanent.
- Body/UI: **Inter**.
- Data (addresses, hashes, countdowns, vault IDs): **JetBrains Mono**.
- **Phrase entry fields**: multi-line `<textarea>` styled with the serif at generous size and
  line-height — the phrase is a meaningful personal artifact (a poem, a kanji pairing),
  not a password box. This is a deliberate storytelling detail; implement it.
Layout: generous whitespace, hairline-bordered cards on the shell color, max-width ~1100px,
subtle settle-easing transitions (`cubic-bezier(.22,1,.36,1)`), no gradients/glow/neon.
Motif: **two halves of a seal / two keys converging** as the visual metaphor for the
dual-phrase model — use it on the landing hero and the setup step divider.
Include a persistent, quiet **"TESTNET — chain 968"** badge in the header at all times.

### 6.3 Pages & flows

**(1) Landing** — one-line pitch ("If you go silent, your assets don't."), how-it-works in three
steps (Register → Stay alive with pings → Claim with two phrases), the two-keys motif,
honest-status strip (testnet-only, unaudited, link to SECURITY.md), CTA: Create Vault / Claim.

**(2) Create Vault wizard — exact step order:**
1. **Educate** (one screen, 4 sentences max): why two phrases, why they must be original
   (never famous poems/lyrics/quotes — attackers dictionary-attack public text), never
   personal facts (pet names/birthdays are the FIRST thing a targeted attacker tries),
   store the two in *separate places/people*.
2. **Phrase A**: serif textarea + live zxcvbn strength meter + inline warnings
   (detected date-like patterns, short input, common-phrase flags). NFC applied silently.
3. **Phrase A confirm**: full re-type (paste disabled on confirm field). Byte-exact match
   after normalization+trim required. Mismatch shows a calm amber notice, never red.
4. **Phrase B** + **confirm** — same, plus prompt: "Store this one somewhere different from
   Phrase A — with a trusted person or in a separate physical location."
5. **Derive** (spinner ~1s per phrase): show the two derived *addresses* (never keys) with
   the label "these public addresses are all the chain will ever know."
6. **Vault settings**: inactivity period picker (presets 30/90/180/365 days + custom;
   testnet-only extra presets of 5/15 minutes for demo purposes, clearly labeled).
7. **Create on-chain**: `createVault` tx → confirm → show vaultId.
8. **Register assets**: token address input with auto-detect (ERC-165/heuristics) of
   ERC20 vs ERC721; for each added token, immediately drive the corresponding `approve`/
   `setApprovalForAll` tx from the owner wallet and show live allowance status per row.
   Warn clearly when a registered token has zero/insufficient allowance.
9. **Final review + Beneficiary Sheet**: restate irrevocably — "Both phrases are required,
   word-for-word, including line breaks. Losing either permanently locks the vault. There is
   no recovery." Generate a **printable beneficiary instruction sheet** (client-side, no
   network): vaultId, contract address, chain info, claim URL, step-by-step claim
   instructions, and blank ruled areas labeled "Phrase A — write by hand, store separately
   from Phrase B." The phrases themselves are NEVER pre-filled.

**(3) Dashboard (owner)** — connect wallet → list vaults: state chip, countdown
(mono font, live), Ping button (with tx), token list with allowance health, deactivate
(with approval-revocation checklist), copy beneficiary sheet again.

**(4) Claim page (beneficiary)** — deliberately calm; assume the user may be grieving:
1. Locate vault: by vaultId or owner address. Show claimability status; if not yet claimable,
   show remaining time and stop.
2. Enter Phrase A → derive → check derived address matches registered signerA **locally**.
   ⚠️ UX-vs-security decision (made): local address comparison DOES tell the claimant
   which phrase is wrong. This is acceptable because the attacker can do the identical
   comparison offline anyway (addresses are public) — it leaks nothing on-chain and nothing
   an offline attacker doesn't already have. The CONTRACT stays uniform (T6); the local UI
   may be helpful. Document this reasoning in SECURITY.md.
3. Enter Phrase B → same.
4. Destination: default = connected wallet, editable to any external address, with an
   "I've verified this address" checkbox.
5. Show fee (current escalated fee in BOT), sign both EIP-712 payloads locally, submit one
   `attemptClaim` tx.
6. Result: success → per-token sweep report (transferred / skipped with reasons) + "run
   another sweep" if anything remains. Failure → generic calm message ("The claim was not
   accepted. Both phrases must match exactly — including spaces and line breaks.") in amber,
   with the cooldown countdown for this wallet.

**(5) Vault inspector (public, read-only)** — any vaultId: state, countdown, registered tokens,
fee level. No secrets exist to show; demonstrates "chain as witness" transparency.

### 6.4 Frontend guardrails
- Phrase fields: no autocomplete/spellcheck/analytics; paste allowed on first entry
  (long poems!), disabled on confirm re-type.
- All derivation in a web worker if it would jank the main thread.
- Read the vault nonce immediately before signing; if the tx fails with nonce mismatch,
  prompt to re-sign (someone claimed between sign and submit).
- Every tx: pending/confirmed/failed states with explorer links to `scan.bohr.life`.

---

## 7. PYTHON CLI (narrow scope — trust/verification tool, not a parallel app)

`dmh-cli/` — a single well-commented script + README. Purpose: let advanced users verify the
frontend's cryptography independently, offline.

Commands:
- `derive` — prompt for phrase (hidden input), owner address, slot, chainId → print derived
  address (print private key ONLY with explicit `--show-private-key` flag + red warning).
- `sign-claim` — derive + sign the EIP-712 ClaimAuthorization → print sigA/sigB hex for manual
  submission (e.g., via explorer write-contract UI).
- `verify-vectors` — run the shared test vectors, exit nonzero on any mismatch.

Rules: pure Python + `eth-account` + `eth-utils` only; NO network calls whatsoever; NFC via
`unicodedata`; MUST pass the identical test-vector file the JS tests use (§8.3). Frame it in
docs as "independent verification tool — the web app is the primary product."

---

## 8. TESTING REQUIREMENTS (Hardhat or Foundry — pick one, use it well)

### 8.1 Unit/integration (minimum)
Vault lifecycle; ping authorization; add/remove token bounds; fee escalation curve
(base ×2^n, capped at 2^7); cooldown per-caller isolation; happy-path claim (ERC20 + ERC721
mocks); allowance-shortfall partial sweep; malicious token mocks (reverting, false-returning,
gas-guzzling, reentrant) — every §5.9 invariant has a named test.

### 8.2 Adversarial suite (mandatory, named tests)
replay-after-success; wrong-destination; wrong-chainId-domain; wrong-verifying-contract;
sigA-valid-sigB-garbage vs sigB-valid-sigA-garbage produce identical state/events;
copied-signatures-submitted-by-attacker pays out to signed destination anyway (T2 proof);
reentrancy via ERC721 hook; owner-as-signer rejected at creation.

### 8.3 Cross-implementation test vectors (consensus-critical)
`test-vectors.json`, ≥10 cases: ASCII phrase; multi-line English poem (embedded \n);
Japanese kanji+kana; emoji; leading/trailing-whitespace (must trim); NFC-vs-NFD identical
visual input (MUST derive same key); mixed-script; 500-char phrase. Each entry: phrase,
owner, slot, chainId → expected privKey, expected address, plus one full expected EIP-712
signature per case. JS test suite AND `dmh-cli verify-vectors` both consume this exact file
in CI. Any mismatch = build failure.

### 8.4 Live testnet validation (document results in README)
Deploy to 968 → full setup→ping→expire (use a short demo period)→claim cycle with a real
test ERC-20 you deploy alongside; verify contract source on scan.bohr.life; record the
deployed addresses and tx hashes in the README status table.

---

## 9. DEPLOYMENT

1. Hardhat/Foundry config for chain 968 (`https://rpc.bohr.life`), deployer key via env var
   (never committed; `.env` in `.gitignore`).
2. Deploy `DeadMansHandV2` with constructor `(baseClaimFee, feeRecipient)`.
3. Deploy a `MockERC20` ("DMH Test Token") and a `MockERC721Enumerable` for the demo flow.
4. Verify all sources on `scan.bohr.life` (Blockscout-style verification).
5. Write addresses into `config/chains.ts` under 968. Leave 677 = `null` (fail closed).
6. Frontend → Cloudflare Pages (static).
7. Git: full history, comprehensive `.gitignore` (env, node_modules, artifacts, cache).

**Mainnet switch procedure (document in README, do NOT execute):** re-deploy the identical
verified bytecode to 677 → fill the 677 config entry → EIP-712 domain and KDF salt pick up
the new chainId automatically → users MUST create fresh vaults on mainnet (testnet vaults,
keys and signatures are cryptographically unusable there — by design, T4).

---

## 10. DOCUMENTATION DELIVERABLES

- **README.md** — overview, threat-model summary table (§2), architecture diagram, deployed
  testnet addresses + explorer links, demo walkthrough with the short-period vault, honest
  status table ("what works / what's untested / what's out of scope"), mainnet-switch
  procedure, "reviewed design, unaudited implementation" statement.
- **SECURITY.md** — full threat model; the phrase-strength honesty section (entropy is the
  user's job; the KDF only buys margin); the local-address-check UX decision and its
  reasoning (§6.3-4.2); memory-hygiene limits of JS; known limitations (native BOT,
  ERC-1155, non-enumerable 721s, NFT_SWEEP_CAP, no dispute window); disclosure contact.
- **docs/CRYPTO_SPEC.md** — §4 verbatim, as the frozen normative spec both implementations
  cite, plus the test-vector file format.
- Solidity natspec on every external function, including the "return-not-revert on bad
  signatures" rationale.

---

## 11. ACCEPTANCE CHECKLIST (all must be true before "done")

- [ ] No phrase or private key ever leaves the browser/CLI (grep the codebase: no phrase
      variable reaches fetch/XHR/storage/analytics/console).
- [ ] Contract deployed AND verified on scan.bohr.life; addresses in README.
- [ ] All §5.9 invariants have passing named tests; adversarial suite (§8.2) passes.
- [ ] JS and Python derive identical keys/signatures for all test vectors in CI.
- [ ] Full demo cycle proven on testnet 968 with tx-hash evidence in README.
- [ ] Mainnet fails closed in the UI.
- [ ] UI matches §6.2 (dark forest/cream, serif phrase fields, soft-salmon failures,
      testnet badge, two-keys motif).
- [ ] Beneficiary instruction sheet generates and prints client-side.
- [ ] README + SECURITY.md + CRYPTO_SPEC.md complete and honest.

---

## 12. WHAT NOT TO DO (anti-goals)

- Do NOT add a backend, database, or any server that could ever see a phrase.
- Do NOT "optimize" the KDF iteration count down, or swap the KDF, without updating the
  frozen spec + vectors everywhere simultaneously.
- Do NOT make failure responses informative about which signature failed (contract level).
- Do NOT store fees in the contract, add upgradeability, or add an owner/admin key that can
  touch vault flow. `feeRecipient` and `baseClaimFee` are the only privileged surface;
  baseClaimFee changes (if you add a setter) must be timelocked or omitted entirely — prefer
  immutable.
- Do NOT implement ZK circuits — the signature scheme was chosen over ZK deliberately
  (equally leak-proof for this design, vastly smaller and better-audited risk surface).
- Do NOT let the mainnet config contain a guessed address. `null` until real deployment.
