import { useCallback, useEffect, useMemo, useState } from "react";
import { formatUnits, isAddress, getAddress, parseUnits, type Log } from "ethers";
import {
  createVaultSalt,
  deriveAndSignClaim,
  derivePublicAddress,
  normalizePhrase,
} from "./crypto";
import {
  connectWallet,
  eagerWallet,
  switchNetwork,
  watchWallet,
  TESTNET_CHAIN_ID,
  type WalletState,
} from "./wallet";
import {
  DMH_ADDRESS,
  ERC721_ENUMERABLE_INTERFACE_ID,
  dmh,
  dmhDeployed,
  dmhInterface,
  erc20,
  erc721,
  discoverAssets,
  explorerAddress,
  explorerTx,
  friendlyError,
  skipReason,
  type DiscoveredAsset,
} from "./contract";

type Page = "home" | "create" | "dashboard" | "claim" | "inspect";

type Vault = {
  owner: string;
  signerA: string;
  signerB: string;
  vaultSalt: string;
  lastPing: bigint;
  inactivityPeriod: bigint;
  nonce: bigint;
  state: number;
};

type TokenEntry = { token: string; kind: number };

type AssetHealth = {
  token: string;
  kind: number;
  label: string;
  detail: string;
  ok: boolean;
};

type SweepRow = { label: string; detail: string; ok: boolean };

const STATE_LABEL = ["ACTIVE", "CLAIMED", "DEACTIVATED"];
const MIN_PERIOD = 60;
const MAX_PERIOD = 3650 * 86400;

/* eslint-disable @typescript-eslint/no-explicit-any */
function toVault(raw: any): Vault {
  return {
    owner: raw.owner,
    signerA: raw.signerA,
    signerB: raw.signerB,
    vaultSalt: String(raw.vaultSalt).toLowerCase(),
    lastPing: BigInt(raw.lastPing),
    inactivityPeriod: BigInt(raw.inactivityPeriod),
    nonce: BigInt(raw.nonce),
    state: Number(raw.state),
  };
}

function toTokens(raw: any): TokenEntry[] {
  return (raw ?? []).map((entry: any) => ({
    token: String(entry.token),
    kind: Number(entry.tokenType),
  }));
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "0s";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${rest}s`;
  if (minutes > 0) return `${minutes}m ${rest}s`;
  return `${rest}s`;
}

function useNow(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Buttons instead of a native select: dropdowns are unreliable in wallet browsers. */
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  columns = 2,
}: {
  label: string;
  value: T;
  options: { value: T; title: string; note?: string }[];
  onChange: (value: T) => void;
  columns?: number;
}) {
  return (
    <fieldset className="segmented">
      <legend>{label}</legend>
      <div className="segmented-options" data-columns={columns}>
        {options.map((option) => (
          <button
            type="button"
            key={option.value}
            aria-pressed={value === option.value}
            className={value === option.value ? "segment selected" : "segment"}
            onClick={() => onChange(option.value)}
          >
            <strong>{option.title}</strong>
            {option.note && <small>{option.note}</small>}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function Notice({ text, tone = "warn" }: { text: string; tone?: "warn" | "good" }) {
  if (!text) return null;
  return (
    <p className={tone === "good" ? "notice good" : "notice"} role="status">
      {text}
    </p>
  );
}

function TxLink({ hash }: { hash: string }) {
  return (
    <a className="tx-link" href={explorerTx(hash)} target="_blank" rel="noreferrer">
      {short(hash)}
    </a>
  );
}

function Seal() {
  return (
    <div className="seal" aria-hidden="true">
      <span>A</span>
      <i />
      <span>B</span>
    </div>
  );
}

function PhraseField({
  label,
  value,
  setValue,
  confirm = false,
}: {
  label: string;
  value: string;
  setValue: (value: string) => void;
  confirm?: boolean;
}) {
  return (
    <label className="phrase-field">
      <span>{label}</span>
      <textarea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onPaste={confirm ? (event) => event.preventDefault() : undefined}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        placeholder={
          confirm ? "Type it again by hand" : "Write something only you could have written…"
        }
      />
      <small>
        {Array.from(normalizePhrase(value)).length} characters · spaces and line breaks count
      </small>
    </label>
  );
}

/* ------------------------------- period picker ------------------------------- */

function PeriodPicker({
  seconds,
  setSeconds,
}: {
  seconds: number;
  setSeconds: (value: number) => void;
}) {
  const [mode, setMode] = useState<"preset" | "custom">("preset");
  const [amount, setAmount] = useState("30");
  const [unit, setUnit] = useState<"minutes" | "hours" | "days">("days");

  const presets = [
    { value: "300", title: "5 minutes", note: "demo" },
    { value: "900", title: "15 minutes", note: "demo" },
    { value: "2592000", title: "30 days", note: "standard" },
    { value: "7776000", title: "90 days", note: "standard" },
    { value: "15552000", title: "180 days", note: "standard" },
    { value: "31536000", title: "365 days", note: "standard" },
  ];

  const applyCustom = (rawAmount: string, rawUnit: "minutes" | "hours" | "days") => {
    const parsed = Number(rawAmount);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    const multiplier = rawUnit === "minutes" ? 60 : rawUnit === "hours" ? 3600 : 86400;
    setSeconds(Math.min(MAX_PERIOD, Math.max(MIN_PERIOD, Math.floor(parsed * multiplier))));
  };

  return (
    <div className="period-block">
      <Segmented
        label="How should the period be chosen?"
        value={mode}
        columns={2}
        onChange={(next) => {
          setMode(next);
          if (next === "custom") applyCustom(amount, unit);
        }}
        options={[
          { value: "preset", title: "Common periods" },
          { value: "custom", title: "Custom length" },
        ]}
      />

      {mode === "preset" ? (
        <Segmented
          label="Inactivity period"
          value={String(seconds)}
          columns={3}
          onChange={(next) => setSeconds(Number(next))}
          options={presets}
        />
      ) : (
        <div className="custom-period">
          <label className="standard-field">
            <span>Length</span>
            <input
              value={amount}
              inputMode="numeric"
              onChange={(event) => {
                setAmount(event.target.value);
                applyCustom(event.target.value, unit);
              }}
            />
          </label>
          <Segmented
            label="Unit"
            value={unit}
            columns={3}
            onChange={(next) => {
              setUnit(next);
              applyCustom(amount, next);
            }}
            options={[
              { value: "minutes", title: "Minutes" },
              { value: "hours", title: "Hours" },
              { value: "days", title: "Days" },
            ]}
          />
        </div>
      )}

      <p className="period-summary">
        Assets become claimable after <strong>{formatDuration(seconds)}</strong> without a ping.
        Allowed range is 1 minute to 3650 days.
      </p>
    </div>
  );
}

/* --------------------------------- assets ---------------------------------- */

async function readAssetHealth(
  entry: TokenEntry,
  owner: string,
): Promise<AssetHealth> {
  try {
    if (entry.kind === 0) {
      const contract = erc20(entry.token);
      const [symbol, decimals, balance, allowance] = await Promise.all([
        contract.symbol().catch(() => "ERC-20"),
        contract.decimals().catch(() => 18),
        contract.balanceOf(owner),
        contract.allowance(owner, DMH_ADDRESS),
      ]);
      const units = Number(decimals);
      const sweepable = allowance < balance ? allowance : balance;
      return {
        token: entry.token,
        kind: 0,
        label: String(symbol),
        detail: `balance ${formatUnits(balance, units)} · allowance ${formatUnits(
          allowance,
          units,
        )} · sweepable ${formatUnits(sweepable, units)}`,
        ok: sweepable > 0n,
      };
    }
    const contract = erc721(entry.token);
    const [approved, balance] = await Promise.all([
      contract.isApprovedForAll(owner, DMH_ADDRESS).catch(() => false),
      contract.balanceOf(owner).catch(() => 0n),
    ]);
    return {
      token: entry.token,
      kind: 1,
      label: "ERC-721",
      detail: `${balance} held · ${approved ? "operator approved" : "approval missing"}`,
      ok: Boolean(approved) && balance > 0n,
    };
  } catch {
    return {
      token: entry.token,
      kind: entry.kind,
      label: "Unknown",
      detail: "This contract did not answer standard calls.",
      ok: false,
    };
  }
}

function AssetManager({
  wallet,
  vaultId,
  owner,
  canRegister,
}: {
  wallet: WalletState;
  vaultId: bigint;
  owner: string;
  canRegister: boolean;
}) {
  const [address, setAddress] = useState("");
  const [manual, setManual] = useState(false);
  const [amountMode, setAmountMode] = useState<"balance" | "custom">("balance");
  const [amount, setAmount] = useState("1000");
  const [health, setHealth] = useState<AssetHealth[]>([]);
  const [found, setFound] = useState<DiscoveredAsset[]>();
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    try {
      const entries = toTokens(await dmh().getVaultTokens(vaultId));
      setHealth(await Promise.all(entries.map((entry) => readAssetHealth(entry, owner))));
    } catch (error) {
      setNotice(friendlyError(error));
    }
  }, [vaultId, owner]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const registered = useMemo(
    () => new Set(health.map((entry) => entry.token.toLowerCase())),
    [health],
  );

  async function scan() {
    setBusy(true);
    setNotice("Asking the public explorer which assets this wallet holds…");
    try {
      const assets = await discoverAssets(owner);
      setFound(assets);
      setChosen({});
      setNotice(
        assets.length === 0
          ? "No tokens were found for this wallet. You can still add an address manually."
          : "",
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  /** Registers then approves one asset. Each asset needs two wallet confirmations. */
  async function addAsset(target: string, kind: number, approveValue: bigint) {
    await (await dmh(wallet.signer).addToken(vaultId, target, kind)).wait();
    if (kind === 0) {
      if (approveValue === 0n) return;
      await (await erc20(target, wallet.signer).approve(DMH_ADDRESS, approveValue)).wait();
    } else {
      await (await erc721(target, wallet.signer).setApprovalForAll(DMH_ADDRESS, true)).wait();
    }
  }

  async function addSelected() {
    const queue = (found ?? []).filter(
      (asset) => chosen[asset.address] && asset.kind !== -1 && !registered.has(asset.address.toLowerCase()),
    );
    if (queue.length === 0) return setNotice("Select at least one supported asset.");

    setBusy(true);
    try {
      for (let index = 0; index < queue.length; index += 1) {
        const asset = queue[index];
        setNotice(
          `Asset ${index + 1} of ${queue.length} (${asset.symbol}): confirm the two wallet prompts.`,
        );
        await addAsset(asset.address, asset.kind, asset.balance);
      }
      setNotice(`Registered and approved ${queue.length} asset${queue.length > 1 ? "s" : ""}.`);
      setChosen({});
      await refresh();
      setFound(await discoverAssets(owner).catch(() => found ?? []));
    } catch (error) {
      setNotice(friendlyError(error));
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function registerManual() {
    if (!isAddress(address)) return setNotice("Enter a valid contract address.");
    setBusy(true);
    setNotice("Detecting the asset type…");
    try {
      const target = getAddress(address);
      let kind = -1;
      let decimals = 18;

      const enumerable = await erc721(target)
        .supportsInterface(ERC721_ENUMERABLE_INTERFACE_ID)
        .catch(() => false);
      if (enumerable) {
        kind = 1;
      } else {
        const found20 = await erc20(target).decimals().catch(() => null);
        if (found20 !== null) {
          kind = 0;
          decimals = Number(found20);
        }
      }

      if (kind === -1) {
        setNotice(
          "This asset is not supported. Only ERC-20 tokens and enumerable ERC-721 collections can be swept.",
        );
        return;
      }

      setNotice("Confirm the two wallet prompts: registration, then approval.");
      const value =
        kind === 0
          ? amountMode === "balance"
            ? await erc20(target).balanceOf(owner)
            : parseUnits(amount || "0", decimals)
          : 0n;
      await addAsset(target, kind, value);

      setAddress("");
      setNotice("Asset registered and approved.");
      await refresh();
    } catch (error) {
      setNotice(friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(entry: AssetHealth) {
    setBusy(true);
    try {
      const tx =
        entry.kind === 0
          ? await erc20(entry.token, wallet.signer).approve(DMH_ADDRESS, 0n)
          : await erc721(entry.token, wallet.signer).setApprovalForAll(DMH_ADDRESS, false);
      await tx.wait();
      setNotice("Approval revoked.");
      await refresh();
    } catch (error) {
      setNotice(friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>Registered assets</h2>
      <p className="muted">
        Assets stay in your wallet. Registration plus an approval is what lets a verified claim
        sweep them. Native BOT, ERC-1155, and non-enumerable collections are not supported.
      </p>

      {health.length === 0 ? (
        <p className="muted">Nothing registered yet.</p>
      ) : (
        <div className="asset-list">
          {health.map((entry) => (
            <div className="asset-row" key={entry.token}>
              <div>
                <a
                  className="mono"
                  href={explorerAddress(entry.token)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {short(entry.token)}
                </a>
                <small>
                  {entry.label} · {entry.detail}
                </small>
              </div>
              <div className="asset-actions">
                <span className={entry.ok ? "pill good" : "pill bad"}>
                  {entry.ok ? "ready" : "not sweepable"}
                </span>
                <button className="ghost" disabled={busy} onClick={() => revoke(entry)}>
                  Revoke
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {!canRegister ? (
        <p className="muted">
          This vault can no longer register assets. You can still revoke approvals above.
        </p>
      ) : (
        <>
          <div className="actions">
            <button className="secondary" disabled={busy} onClick={scan}>
              {busy ? "Working…" : "Scan my wallet for assets"}
            </button>
            <button className="ghost" disabled={busy} onClick={() => setManual(!manual)}>
              {manual ? "Hide manual entry" : "Add an address manually"}
            </button>
          </div>
          <p className="muted">
            Scanning asks the public BOT explorer which tokens this address holds. It reveals your
            address to the explorer and never sends phrases or keys.
          </p>

          {found && found.length > 0 && (
            <div className="asset-list">
              {found.map((asset) => {
                const already = registered.has(asset.address.toLowerCase());
                const usable = asset.kind !== -1 && !already;
                return (
                  <label
                    className={usable ? "asset-row selectable" : "asset-row"}
                    key={asset.address}
                  >
                    <div className="scan-main">
                      <input
                        type="checkbox"
                        disabled={!usable || busy}
                        checked={Boolean(chosen[asset.address])}
                        onChange={(event) =>
                          setChosen({ ...chosen, [asset.address]: event.target.checked })
                        }
                      />
                      <div>
                        <span className="mono">
                          {asset.symbol} · {asset.name}
                        </span>
                        <small>
                          {asset.kind === 0
                            ? `${formatUnits(asset.balance, asset.decimals)} held`
                            : `${asset.balance} item${asset.balance === 1n ? "" : "s"} held`}
                          {" · "}
                          {short(asset.address)}
                        </small>
                      </div>
                    </div>
                    <span
                      className={
                        already ? "pill" : asset.kind === -1 ? "pill bad" : "pill good"
                      }
                    >
                      {already ? "registered" : (asset.blocked ?? "can be added")}
                    </span>
                  </label>
                );
              })}
              <button className="primary" disabled={busy} onClick={addSelected}>
                {busy ? "Working…" : "Register and approve selected"}
              </button>
              <p className="muted">
                Each asset needs two confirmations: one to register it, one to approve it.
                ERC-20 approvals use the balance shown above.
              </p>
            </div>
          )}

          {manual && (
            <>
              <label className="standard-field">
                <span>Asset contract address</span>
                <input
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  placeholder="0x…"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <Segmented
                label="ERC-20 approval amount"
                value={amountMode}
                onChange={setAmountMode}
                options={[
                  { value: "balance", title: "Current balance", note: "recommended" },
                  { value: "custom", title: "Custom amount" },
                ]}
              />
              {amountMode === "custom" && (
                <label className="standard-field">
                  <span>Amount to approve</span>
                  <input
                    value={amount}
                    inputMode="decimal"
                    onChange={(event) => setAmount(event.target.value)}
                  />
                </label>
              )}
              <button className="primary" disabled={busy} onClick={registerManual}>
                {busy ? "Working…" : "Register and approve"}
              </button>
            </>
          )}
        </>
      )}
      <Notice text={notice} />
    </section>
  );
}

/* ------------------------------ beneficiary sheet --------------------------- */

function BeneficiarySheet({ vaultId }: { vaultId: bigint }) {
  return (
    <section className="panel sheet">
      <p className="eyebrow">Beneficiary sheet</p>
      <h2>Instructions for the person you trust</h2>
      <p className="muted">
        Both phrases are required, exactly as written, including spaces and line breaks. If either
        is lost the vault can never be claimed. Store them in two separate places.
      </p>
      <dl>
        <dt>Vault ID</dt>
        <dd className="mono">{vaultId.toString()}</dd>
        <dt>Contract</dt>
        <dd className="mono">{DMH_ADDRESS}</dd>
        <dt>Network</dt>
        <dd>BOT Chain Testnet · chain {TESTNET_CHAIN_ID}</dd>
        <dt>Claim page</dt>
        <dd className="mono">{window.location.origin}</dd>
      </dl>
      <div className="ruled">
        <span>Phrase A — write by hand, store separately from Phrase B</span>
        <span>Phrase B — write by hand, store separately from Phrase A</span>
      </div>
      <button className="secondary" onClick={() => window.print()}>
        Print this sheet
      </button>
    </section>
  );
}

/* --------------------------------- create ---------------------------------- */

function CreateVault({
  wallet,
  ready,
  setPage,
}: {
  wallet?: WalletState;
  ready: boolean;
  setPage: (page: Page) => void;
}) {
  const [phraseA, setPhraseA] = useState("");
  const [confirmA, setConfirmA] = useState("");
  const [phraseB, setPhraseB] = useState("");
  const [confirmB, setConfirmB] = useState("");
  const [seconds, setSeconds] = useState(2592000);
  const [derived, setDerived] = useState<{ a: string; b: string; salt: string }>();
  const [vaultId, setVaultId] = useState<bigint>();
  const [txHash, setTxHash] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  async function derive() {
    if (!wallet || !ready) return setNotice("Connect a BOT testnet wallet first.");
    const a = normalizePhrase(phraseA);
    const b = normalizePhrase(phraseB);
    if (Array.from(a).length < 20 || Array.from(b).length < 20) {
      return setNotice("Each phrase needs at least 20 characters.");
    }
    if (a !== normalizePhrase(confirmA)) return setNotice("Phrase A confirmation does not match.");
    if (b !== normalizePhrase(confirmB)) return setNotice("Phrase B confirmation does not match.");
    if (a === b) return setNotice("Phrase A and Phrase B must be different.");

    setBusy(true);
    setNotice("Deriving both keys on this device. Nothing secret is sent anywhere.");
    try {
      const existing = await dmh().liveVaultOf(wallet.address);
      if (BigInt(existing) !== 0n) {
        setNotice(
          `This wallet already owns live vault ${existing}. Deactivate it on the dashboard first, or connect a different owner wallet.`,
        );
        return;
      }
      const salt = createVaultSalt();
      const [a1, b1] = await Promise.all([
        derivePublicAddress({
          phrase: a,
          owner: wallet.address,
          slot: "A",
          chainId: TESTNET_CHAIN_ID,
          vaultSalt: salt,
        }),
        derivePublicAddress({
          phrase: b,
          owner: wallet.address,
          slot: "B",
          chainId: TESTNET_CHAIN_ID,
          vaultSalt: salt,
        }),
      ]);
      setDerived({ a: a1, b: b1, salt });
      setPhraseA("");
      setConfirmA("");
      setPhraseB("");
      setConfirmB("");
      setNotice("Both public signers are ready. Choose a period, then create the vault.");
    } catch (error) {
      setNotice(friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (!wallet || !derived) return;
    setBusy(true);
    setNotice("Confirm the vault creation in your wallet.");
    try {
      const contract = dmh(wallet.signer);
      const tx = await contract.createVault(derived.a, derived.b, derived.salt, BigInt(seconds));
      const receipt = await tx.wait();
      let created = 0n;
      for (const log of (receipt?.logs ?? []) as Log[]) {
        try {
          const parsed = dmhInterface.parseLog(log);
          if (parsed?.name === "VaultCreated") created = BigInt(parsed.args[0]);
        } catch {
          /* Unrelated log. */
        }
      }
      if (created === 0n) created = BigInt(await contract.liveVaultOf(wallet.address));
      setVaultId(created);
      setTxHash(tx.hash);
      setNotice("");
    } catch (error) {
      setNotice(friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flow">
      <p className="eyebrow">Create · owner setup</p>
      <h1>Prepare what remains.</h1>
      <p className="intro">
        Write two original phrases. Never use a known poem, lyric, quote, or personal fact such as a
        pet name or birthday. Keep each phrase in a different place.
      </p>

      {!vaultId && (
        <>
          <div className="phrase-grid">
            <section className="panel">
              <h2>First half</h2>
              <PhraseField label="Phrase A" value={phraseA} setValue={setPhraseA} />
              <PhraseField label="Retype Phrase A" value={confirmA} setValue={setConfirmA} confirm />
            </section>
            <section className="panel">
              <h2>Second half</h2>
              <PhraseField label="Phrase B" value={phraseB} setValue={setPhraseB} />
              <PhraseField label="Retype Phrase B" value={confirmB} setValue={setConfirmB} confirm />
            </section>
          </div>

          {!derived && (
            <button className="primary" disabled={busy || !ready} onClick={derive}>
              {busy ? "Deriving on this device…" : "Derive public signers"}
            </button>
          )}
        </>
      )}

      {derived && !vaultId && (
        <section className="panel">
          <h2>Confirm and create</h2>
          <p className="muted">These public addresses are all the chain will ever know.</p>
          <code>Signer A: {derived.a}</code>
          <code>Signer B: {derived.b}</code>
          <PeriodPicker seconds={seconds} setSeconds={setSeconds} />
          <button className="primary" disabled={busy} onClick={create}>
            {busy ? "Waiting for confirmation…" : "Create vault on-chain"}
          </button>
        </section>
      )}

      <Notice text={notice} />

      {vaultId && wallet && (
        <>
          <section className="panel">
            <h2>Vault {vaultId.toString()} is live</h2>
            {txHash && (
              <p className="muted">
                Creation transaction: <TxLink hash={txHash} />
              </p>
            )}
            <p className="muted">
              Nothing can be claimed until {formatDuration(seconds)} pass without a ping.
            </p>
            <button className="secondary" onClick={() => setPage("dashboard")}>
              Open owner dashboard
            </button>
          </section>
          <AssetManager wallet={wallet} vaultId={vaultId} owner={wallet.address} canRegister />
          <BeneficiarySheet vaultId={vaultId} />
        </>
      )}
    </main>
  );
}

/* -------------------------------- dashboard -------------------------------- */

function VaultCard({ id, wallet }: { id: bigint; wallet: WalletState }) {
  const [vault, setVault] = useState<Vault>();
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const now = useNow();

  const load = useCallback(async () => {
    try {
      setVault(toVault(await dmh().getVault(id)));
    } catch (error) {
      setNotice(friendlyError(error));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(method: "ping" | "deactivateVault") {
    setBusy(true);
    setNotice(method === "ping" ? "Confirm the heartbeat." : "Confirm the deactivation.");
    try {
      const tx = await dmh(wallet.signer)[method](id);
      await tx.wait();
      setNotice(method === "ping" ? "Heartbeat recorded." : "Vault deactivated.");
      await load();
    } catch (error) {
      setNotice(friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  if (!vault) return <p className="notice">Loading vault {id.toString()}…</p>;

  const deadline = Number(vault.lastPing + vault.inactivityPeriod);
  const remaining = deadline - now;
  const claimable = vault.state !== 2 && remaining <= 0;

  return (
    <section className="panel">
      <div className="card-heading">
        <span>Vault {id.toString()}</span>
        <span className={`pill state-${vault.state}`}>{STATE_LABEL[vault.state]}</span>
      </div>
      <p className="countdown">
        {vault.state === 2
          ? "Deactivated"
          : claimable
            ? "Claimable now"
            : `${formatDuration(remaining)} remaining`}
      </p>
      <p className="muted mono">
        nonce {vault.nonce.toString()} · period {formatDuration(Number(vault.inactivityPeriod))}
      </p>
      <div className="actions">
        <button className="secondary" disabled={busy || vault.state !== 0} onClick={() => act("ping")}>
          Ping now
        </button>
        <button
          className="secondary"
          disabled={busy || vault.state === 2}
          onClick={() => act("deactivateVault")}
        >
          Deactivate
        </button>
      </div>
      {vault.state === 2 && (
        <p className="muted">
          Deactivation stops claims, but token approvals stay live. Revoke them below.
        </p>
      )}
      <Notice text={notice} />
      <AssetManager
        wallet={wallet}
        vaultId={id}
        owner={vault.owner}
        canRegister={vault.state === 0}
      />
    </section>
  );
}

function Dashboard({ wallet, ready }: { wallet?: WalletState; ready: boolean }) {
  const [ids, setIds] = useState<bigint[]>();
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!wallet || !ready) return;
    dmh()
      .vaultsOf(wallet.address)
      .then((list: bigint[]) => setIds(list.map((value) => BigInt(value))))
      .catch((error: unknown) => setNotice(friendlyError(error)));
  }, [wallet, ready]);

  if (!wallet || !ready) {
    return (
      <main className="flow narrow">
        <p className="eyebrow">Owner dashboard</p>
        <h1>Keep the signal alive.</h1>
        <p className="intro">Connect the owner wallet to see timers, heartbeats and approvals.</p>
      </main>
    );
  }

  return (
    <main className="flow narrow">
      <p className="eyebrow">Owner dashboard</p>
      <h1>Keep the signal alive.</h1>
      <p className="intro mono">{wallet.address}</p>
      <Notice text={notice} />
      {ids === undefined ? (
        <p className="muted">Loading your vaults…</p>
      ) : ids.length === 0 ? (
        <p className="muted">This wallet has no vaults yet.</p>
      ) : (
        ids.map((id) => <VaultCard key={id.toString()} id={id} wallet={wallet} />)
      )}
    </main>
  );
}

/* ---------------------------------- claim ---------------------------------- */

function Claim({ wallet, ready }: { wallet?: WalletState; ready: boolean }) {
  const [idText, setIdText] = useState("");
  const [vault, setVault] = useState<{ id: bigint; data: Vault }>();
  const [phraseA, setPhraseA] = useState("");
  const [phraseB, setPhraseB] = useState("");
  const [destination, setDestination] = useState("");
  const [verified, setVerified] = useState(false);
  const [fee, setFee] = useState<bigint>();
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [rows, setRows] = useState<SweepRow[]>();
  const [outcome, setOutcome] = useState<"none" | "success" | "rejected">("none");
  const [txHash, setTxHash] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const now = useNow();

  useEffect(() => {
    if (wallet && ready && !destination) setDestination(wallet.address);
  }, [wallet, ready, destination]);

  useEffect(() => {
    if (!vault || !wallet) return;
    dmh()
      .currentClaimFee(vault.id, wallet.address)
      .then((value: bigint) => setFee(BigInt(value)))
      .catch(() => setFee(undefined));
    dmh()
      .callerCooldownUntil(vault.id, wallet.address)
      .then((value: bigint) => setCooldownUntil(Number(value)))
      .catch(() => setCooldownUntil(0));
  }, [vault, wallet, outcome]);

  async function locate() {
    if (!/^\d+$/.test(idText.trim())) return setNotice("Enter the numeric vault ID.");
    setBusy(true);
    setNotice("");
    setRows(undefined);
    setOutcome("none");
    try {
      const id = BigInt(idText.trim());
      setVault({ id, data: toVault(await dmh().getVault(id)) });
    } catch (error) {
      setVault(undefined);
      setNotice(friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  async function claim() {
    if (!vault) return;
    if (!wallet || !ready) return setNotice("Connect a funded BOT testnet wallet to submit.");
    if (!isAddress(destination)) return setNotice("Enter a valid destination address.");
    if (!verified) return setNotice("Confirm that you checked the destination address.");

    setBusy(true);
    setRows(undefined);
    setOutcome("none");
    setNotice("Reading the live nonce, then deriving both keys on this device…");

    try {
      const fresh = toVault(await dmh().getVault(vault.id));
      const target = getAddress(destination);
      const [first, second] = await Promise.all([
        deriveAndSignClaim(
          {
            phrase: normalizePhrase(phraseA),
            owner: fresh.owner,
            slot: "A",
            chainId: TESTNET_CHAIN_ID,
            vaultSalt: fresh.vaultSalt,
          },
          DMH_ADDRESS,
          vault.id,
          target,
          fresh.nonce,
        ),
        deriveAndSignClaim(
          {
            phrase: normalizePhrase(phraseB),
            owner: fresh.owner,
            slot: "B",
            chainId: TESTNET_CHAIN_ID,
            vaultSalt: fresh.vaultSalt,
          },
          DMH_ADDRESS,
          vault.id,
          target,
          fresh.nonce,
        ),
      ]);

      // Local-only comparison against public addresses. Nothing extra reaches the chain,
      // and it saves the claimant a fee plus a cooldown when a phrase is mistyped.
      const okA = first.address.toLowerCase() === fresh.signerA.toLowerCase();
      const okB = second.address.toLowerCase() === fresh.signerB.toLowerCase();
      if (!okA || !okB) {
        const which = !okA && !okB ? "Both phrases do" : !okA ? "Phrase A does" : "Phrase B does";
        setNotice(
          `${which} not match this vault yet. Nothing was submitted and no fee was spent. Check spacing, line breaks and capitalisation.`,
        );
        return;
      }

      const requiredFee = BigInt(await dmh().currentClaimFee(vault.id, wallet.address));
      setFee(requiredFee);
      setNotice("Both phrases match. Confirm the claim in your wallet.");

      const tx = await dmh(wallet.signer).attemptClaim(
        vault.id,
        target,
        first.signature,
        second.signature,
        { value: requiredFee },
      );
      const receipt = await tx.wait();

      const report: SweepRow[] = [];
      let rejected = false;
      for (const log of (receipt?.logs ?? []) as Log[]) {
        let parsed;
        try {
          parsed = dmhInterface.parseLog(log);
        } catch {
          continue;
        }
        if (!parsed) continue;
        if (parsed.name === "ClaimFailed") rejected = true;
        if (parsed.name === "ERC20Swept") {
          report.push({
            label: `ERC-20 ${short(parsed.args[1])}`,
            detail: `${parsed.args[3].toString()} base units transferred`,
            ok: true,
          });
        }
        if (parsed.name === "ERC721Swept") {
          report.push({
            label: `NFT ${short(parsed.args[1])}`,
            detail: `token #${parsed.args[3].toString()} transferred`,
            ok: true,
          });
        }
        if (parsed.name === "TokenSkipped") {
          report.push({
            label: `Skipped ${short(parsed.args[1])}`,
            detail: skipReason(String(parsed.args[2])),
            ok: false,
          });
        }
        if (parsed.name === "SweepLimitReached") {
          report.push({
            label: "Per-claim NFT limit reached",
            detail: "Run another sweep with fresh signatures to continue.",
            ok: false,
          });
        }
      }

      setPhraseA("");
      setPhraseB("");
      setTxHash(tx.hash);
      setRows(report);
      setOutcome(rejected ? "rejected" : "success");
      setNotice(
        rejected
          ? "The contract rejected this claim. The fee was consumed and this wallet is now in cooldown."
          : "",
      );
      setVault({ id: vault.id, data: toVault(await dmh().getVault(vault.id)) });
    } catch (error) {
      setNotice(friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  const deadline = vault ? Number(vault.data.lastPing + vault.data.inactivityPeriod) : 0;
  const remaining = deadline - now;
  const claimable = Boolean(vault) && vault!.data.state !== 2 && remaining <= 0;
  const cooling = cooldownUntil > now;

  return (
    <main className="flow narrow">
      <p className="eyebrow">Claim · two signatures</p>
      <h1>
        A quiet process,
        <br />
        with exact words.
      </h1>
      <p className="intro">
        Phrases are turned into signatures on this device. They are never sent to the chain, and any
        funded wallet can submit the transaction.
      </p>

      <label className="standard-field">
        <span>Vault ID</span>
        <input
          value={idText}
          onChange={(event) => setIdText(event.target.value)}
          inputMode="numeric"
          placeholder="1"
        />
      </label>
      <button className="primary" disabled={busy} onClick={locate}>
        {busy ? "Working…" : "Locate vault"}
      </button>

      {vault && (
        <section className="panel">
          <div className="card-heading">
            <span>Vault {vault.id.toString()}</span>
            <span className={`pill state-${vault.data.state}`}>
              {STATE_LABEL[vault.data.state]}
            </span>
          </div>
          <p className="muted mono">owner {short(vault.data.owner)}</p>
          <p className="countdown">
            {vault.data.state === 2
              ? "Deactivated — this vault can never be claimed"
              : claimable
                ? "Claimable now"
                : `${formatDuration(remaining)} remaining`}
          </p>

          {claimable && (
            <>
              <PhraseField label="Phrase A" value={phraseA} setValue={setPhraseA} />
              <PhraseField label="Phrase B" value={phraseB} setValue={setPhraseB} />
              <label className="standard-field">
                <span>Send assets to</span>
                <input
                  value={destination}
                  onChange={(event) => {
                    setDestination(event.target.value);
                    setVerified(false);
                  }}
                  placeholder="0x…"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={verified}
                  onChange={(event) => setVerified(event.target.checked)}
                />
                <span>
                  I checked this address in full. The destination is signed and cannot change later.
                </span>
              </label>
              <p className="muted">
                {fee === undefined
                  ? "Fee loads once a wallet is connected."
                  : `Fee for this wallet: ${formatUnits(fee, 18)} BOT`}
                {cooling && ` · cooldown ends in ${formatDuration(cooldownUntil - now)}`}
              </p>
              <button className="primary" disabled={busy || cooling} onClick={claim}>
                {busy ? "Deriving and submitting…" : "Sign both phrases and claim"}
              </button>
            </>
          )}
        </section>
      )}

      <Notice text={notice} tone={outcome === "success" ? "good" : "warn"} />

      {rows && (
        <section className="panel">
          <h2>{outcome === "success" ? "Sweep report" : "Attempt report"}</h2>
          {txHash && (
            <p className="muted">
              Transaction: <TxLink hash={txHash} />
            </p>
          )}
          {rows.length === 0 ? (
            <p className="muted">
              No asset movements were reported. Registered assets may have no balance or approval.
            </p>
          ) : (
            <div className="asset-list">
              {rows.map((row, index) => (
                <div className="asset-row" key={`${row.label}-${index}`}>
                  <div>
                    <span className="mono">{row.label}</span>
                    <small>{row.detail}</small>
                  </div>
                  <span className={row.ok ? "pill good" : "pill bad"}>
                    {row.ok ? "moved" : "skipped"}
                  </span>
                </div>
              ))}
            </div>
          )}
          <button
            className="secondary"
            onClick={() => {
              setRows(undefined);
              setOutcome("none");
              setNotice("Enter both phrases again to sweep anything that remains.");
            }}
          >
            Run another sweep
          </button>
        </section>
      )}
    </main>
  );
}

/* --------------------------------- inspect --------------------------------- */

function Inspect() {
  const [idText, setIdText] = useState("");
  const [vault, setVault] = useState<{ id: bigint; data: Vault; tokens: TokenEntry[] }>();
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const now = useNow();

  async function lookup() {
    if (!/^\d+$/.test(idText.trim())) {
      setVault(undefined);
      return setNotice("Enter the numeric vault ID.");
    }
    setBusy(true);
    setNotice("");
    try {
      const id = BigInt(idText.trim());
      const [data, tokens] = await Promise.all([
        dmh().getVault(id),
        dmh().getVaultTokens(id),
      ]);
      setVault({ id, data: toVault(data), tokens: toTokens(tokens) });
    } catch (error) {
      setVault(undefined);
      setNotice(friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  const remaining = vault
    ? Number(vault.data.lastPing + vault.data.inactivityPeriod) - now
    : 0;

  return (
    <main className="flow narrow">
      <p className="eyebrow">Public inspector</p>
      <h1>
        The chain keeps
        <br />
        only the witness.
      </h1>
      <p className="intro">
        Anyone can read a vault without a wallet. There is no secret here to reveal.
      </p>
      <label className="standard-field">
        <span>Vault ID</span>
        <input
          value={idText}
          onChange={(event) => setIdText(event.target.value)}
          inputMode="numeric"
          placeholder="1"
        />
      </label>
      <button className="primary" disabled={busy} onClick={lookup}>
        {busy ? "Reading…" : "Inspect on chain"}
      </button>
      <Notice text={notice} />

      {vault && (
        <section className="panel">
          <div className="card-heading">
            <span>Vault {vault.id.toString()}</span>
            <span className={`pill state-${vault.data.state}`}>
              {STATE_LABEL[vault.data.state]}
            </span>
          </div>
          <p className="countdown">
            {vault.data.state === 2
              ? "Deactivated"
              : remaining <= 0
                ? "Claimable now"
                : `${formatDuration(remaining)} remaining`}
          </p>
          <code>Owner: {vault.data.owner}</code>
          <code>Signer A: {vault.data.signerA}</code>
          <code>Signer B: {vault.data.signerB}</code>
          <p className="muted mono">nonce {vault.data.nonce.toString()}</p>
          <div className="asset-list">
            {vault.tokens.length === 0 ? (
              <p className="muted">No registered assets.</p>
            ) : (
              vault.tokens.map((entry) => (
                <div className="asset-row" key={entry.token}>
                  <a
                    className="mono"
                    href={explorerAddress(entry.token)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {short(entry.token)}
                  </a>
                  <span>{entry.kind === 0 ? "ERC-20" : "Enumerable ERC-721"}</span>
                </div>
              ))
            )}
          </div>
        </section>
      )}
    </main>
  );
}

/* ----------------------------------- home ---------------------------------- */

function Home({ setPage }: { setPage: (page: Page) => void }) {
  return (
    <main>
      <section className="hero">
        <div>
          <p className="eyebrow">Chain as witness</p>
          <h1>
            If you go silent,
            <br />
            <em>your assets don't.</em>
          </h1>
          <p className="lede">
            A non-custodial inheritance protocol guarded by time, two private phrases, and nothing
            else.
          </p>
          <div className="actions">
            <button className="primary" onClick={() => setPage("create")}>
              Create a vault
            </button>
            <button className="secondary" onClick={() => setPage("claim")}>
              Make a claim
            </button>
          </div>
        </div>
        <Seal />
      </section>
      <section className="steps">
        <article>
          <b>01</b>
          <h2>Register</h2>
          <p>Assets stay in your wallet. Only a chosen allowance is granted.</p>
        </article>
        <article>
          <b>02</b>
          <h2>Stay present</h2>
          <p>A heartbeat resets the clock. While you answer, nothing can move.</p>
        </article>
        <article>
          <b>03</b>
          <h2>Pass it on</h2>
          <p>Two local signatures release registered assets after silence.</p>
        </article>
      </section>
      <aside className="status">
        <span>Reviewed design</span>
        <span>Unaudited implementation</span>
        <span>Testnet only</span>
      </aside>
    </main>
  );
}

/* ----------------------------------- app ----------------------------------- */

export function App() {
  const [page, setPage] = useState<Page>("home");
  const [wallet, setWallet] = useState<WalletState>();
  const [walletNotice, setWalletNotice] = useState("");
  const [connecting, setConnecting] = useState(false);

  const refreshWallet = useCallback(async () => {
    setWallet(await eagerWallet());
  }, []);

  useEffect(() => {
    void refreshWallet();
    return watchWallet(() => void refreshWallet());
  }, [refreshWallet]);

  const ready = Boolean(wallet && wallet.chainId === TESTNET_CHAIN_ID);
  const wrongNetwork = Boolean(wallet && wallet.chainId !== TESTNET_CHAIN_ID);

  async function connect() {
    setConnecting(true);
    setWalletNotice("");
    try {
      setWallet(await connectWallet());
    } catch (error) {
      setWalletNotice(error instanceof Error ? error.message : friendlyError(error));
    } finally {
      setConnecting(false);
    }
  }

  async function fixNetwork() {
    setWalletNotice("");
    try {
      await switchNetwork();
      await refreshWallet();
    } catch (error) {
      setWalletNotice(friendlyError(error));
    }
  }

  const nav = useMemo(() => ["create", "dashboard", "claim", "inspect"] as Page[], []);

  return (
    <>
      <header>
        <button className="wordmark" onClick={() => setPage("home")}>
          DMH <sup>v2</sup>
        </button>
        <nav aria-label="Primary">
          {nav.map((item) => (
            <button
              key={item}
              className={page === item ? "active" : ""}
              onClick={() => setPage(item)}
            >
              {item[0].toUpperCase() + item.slice(1)}
            </button>
          ))}
        </nav>
        <div className="header-actions">
          <span className="network">TESTNET · {TESTNET_CHAIN_ID}</span>
          {wallet ? (
            <a
              className="wallet-chip"
              href={explorerAddress(wallet.address)}
              target="_blank"
              rel="noreferrer"
            >
              {short(wallet.address)}
            </a>
          ) : (
            <button className="secondary compact" disabled={connecting} onClick={connect}>
              {connecting ? "Connecting…" : "Connect"}
            </button>
          )}
        </div>
      </header>

      {!dmhDeployed && (
        <div className="banner">
          DMH v2 is not deployed on this network. The app refuses to guess a contract address.
        </div>
      )}

      {wrongNetwork && (
        <div className="banner">
          <span>This wallet is on chain {wallet?.chainId}. DMH v2 runs on BOT testnet 968.</span>
          <button className="ghost" onClick={fixNetwork}>
            Switch to BOT testnet
          </button>
        </div>
      )}

      {walletNotice && <div className="banner">{walletNotice}</div>}

      {page === "home" && <Home setPage={setPage} />}
      {page === "create" && <CreateVault wallet={wallet} ready={ready} setPage={setPage} />}
      {page === "dashboard" && <Dashboard wallet={wallet} ready={ready} />}
      {page === "claim" && <Claim wallet={wallet} ready={ready} />}
      {page === "inspect" && <Inspect />}
    </>
  );
}
