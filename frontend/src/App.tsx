import { useEffect, useState } from "react";
import {
  BrowserProvider,
  Contract,
  Log,
  LogDescription,
  formatEther,
  formatUnits,
  isAddress,
  parseUnits,
} from "ethers";
import { chains } from "../../config/chains";
import {
  createVaultSalt,
  derivePublicAddress,
  normalizePhrase,
  signClaim,
} from "./crypto";
import { connectTestnetWallet } from "./wallet";
import {
  DMH_ADDRESS,
  DMH_ABI,
  ERC20_ABI,
  ERC721_ABI,
  dmh,
  explorerAddress,
  explorerTx,
  nft,
  provider,
  token,
  waitFor,
} from "./contract";

type Page = "home" | "create" | "dashboard" | "claim" | "inspect";
type WalletState = {
  provider: BrowserProvider;
  signer: Awaited<ReturnType<BrowserProvider["getSigner"]>>;
  address: string;
};
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

const chain = chains[968];
const ERROR_MESSAGES: Record<string, string> = {
  "0xcaa60a55":
    "This wallet already has an active or claimed vault. Deactivate that vault first, or connect a different testnet owner wallet.",
  "0x17479ac8":
    "That inactivity period is outside the contract's allowed range.",
  "0x5e231fff":
    "The two public signer addresses are invalid. Derive the phrases again.",
  "0x378bf55b":
    "The public vault salt was invalid. Please derive the phrases again.",
  "0x30cd7471": "This wallet is not the owner of that vault.",
  "0x7c1964b5": "This vault is not yet claimable.",
  "0x0440ee75": "This wallet is temporarily cooling down after a failed claim.",
  "0x3ee5aeb5": "The claim fee was not exact. Refresh the fee and try again.",
};

function friendlyError(error: unknown): string {
  const value = error as {
    data?: string;
    info?: { error?: { data?: string } };
    shortMessage?: string;
    message?: string;
  };
  const data = value?.data ?? value?.info?.error?.data;
  if (typeof data === "string" && ERROR_MESSAGES[data.slice(0, 10)])
    return ERROR_MESSAGES[data.slice(0, 10)];
  if (value?.shortMessage?.includes("user rejected"))
    return "The wallet request was cancelled.";
  if (value?.shortMessage?.includes("insufficient funds"))
    return "This wallet does not have enough BOT for gas and the claim fee.";
  if (value?.shortMessage?.includes("timeout"))
    return "The network took too long to respond. Check the explorer before retrying.";
  return "The wallet request could not be completed. Check the network and wallet, then try again.";
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

function Header({
  page,
  setPage,
  wallet,
  setWallet,
}: {
  page: Page;
  setPage: (p: Page) => void;
  wallet?: WalletState;
  setWallet: (w?: WalletState) => void;
}) {
  async function connect() {
    try {
      setWallet(await connectTestnetWallet());
    } catch (e) {
      alert(friendlyError(e));
    }
  }
  return (
    <header>
      <button className="wordmark" onClick={() => setPage("home")}>
        DMH <sup>v2</sup>
      </button>
      <nav aria-label="Primary navigation">
        {(["create", "dashboard", "claim", "inspect"] as Page[]).map((item) => (
          <button
            className={page === item ? "active" : ""}
            key={item}
            onClick={() => setPage(item)}
          >
            {item[0].toUpperCase() + item.slice(1)}
          </button>
        ))}
      </nav>
      <div className="header-actions">
        <span className="network">TESTNET · 968</span>
        {wallet ? (
          <button className="wallet-chip" onClick={() => setWallet(undefined)}>
            {wallet.address.slice(0, 6)}...{wallet.address.slice(-4)}
          </button>
        ) : (
          <button className="secondary compact" onClick={connect}>
            Connect
          </button>
        )}
      </div>
    </header>
  );
}

function Home({ setPage }: { setPage: (p: Page) => void }) {
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
            A non-custodial inheritance protocol guarded by time, two private
            phrases, and nothing else.
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
          <p>
            Your assets stay in your wallet. Only chosen token allowances are
            granted.
          </p>
        </article>
        <article>
          <b>02</b>
          <h2>Stay present</h2>
          <p>
            A heartbeat resets your inactivity clock. While you respond, nothing
            can move.
          </p>
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

function PhraseField({
  label,
  value,
  setValue,
  confirm = false,
}: {
  label: string;
  value: string;
  setValue: (v: string) => void;
  confirm?: boolean;
}) {
  return (
    <label className="phrase-field">
      <span>{label}</span>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onPaste={confirm ? (e) => e.preventDefault() : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder="Write something original..."
      />
      <small>
        {Array.from(normalizePhrase(value)).length} characters · internal spaces
        and line breaks matter
      </small>
    </label>
  );
}

function ConnectNotice({ wallet }: { wallet?: WalletState }) {
  return !wallet ? (
    <p className="notice">Connect a BOT testnet wallet before continuing.</p>
  ) : null;
}

function CreateVault({
  wallet,
  setPage,
}: {
  wallet?: WalletState;
  setPage: (p: Page) => void;
}) {
  const [a, setA] = useState("");
  const [ac, setAc] = useState("");
  const [b, setB] = useState("");
  const [bc, setBc] = useState("");
  const [period, setPeriod] = useState("300");
  const [derived, setDerived] = useState<{
    a: string;
    b: string;
    salt: string;
  }>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [vaultId, setVaultId] = useState<bigint>();
  const [asset, setAsset] = useState("");
  const [assetType, setAssetType] = useState("0");
  const [allowance, setAllowance] = useState("1000");
  const [assetNotice, setAssetNotice] = useState("");
  async function derive() {
    const na = normalizePhrase(a);
    const nb = normalizePhrase(b);
    if (!wallet) return setNotice("Connect the owner wallet first.");
    if (Array.from(na).length < 20 || Array.from(nb).length < 20)
      return setNotice("Each phrase needs at least 20 characters.");
    if (na !== normalizePhrase(ac) || nb !== normalizePhrase(bc))
      return setNotice("Both confirmations must match exactly.");
    if (na === nb) return setNotice("Phrase A and Phrase B must differ.");
    setBusy(true);
    setNotice("Deriving locally. Nothing secret is sent.");
    const salt = createVaultSalt();
    try {
      const [signerA, signerB] = await Promise.all([
        derivePublicAddress({
          phrase: na,
          owner: wallet.address,
          slot: "A",
          chainId: 968,
          vaultSalt: salt,
        }),
        derivePublicAddress({
          phrase: nb,
          owner: wallet.address,
          slot: "B",
          chainId: 968,
          vaultSalt: salt,
        }),
      ]);
      setDerived({ a: signerA, b: signerB, salt });
      setA("");
      setAc("");
      setB("");
      setBc("");
      setNotice(
        "Public signers are ready. Choose a period and create the vault."
      );
    } catch (e) {
      setNotice(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  async function create() {
    if (!wallet || !derived) return;
    setBusy(true);
    setNotice("Checking whether this wallet can create a vault...");
    try {
      const contract = dmh(wallet.signer);
      const existing = await contract.liveVaultOf(wallet.address);
      if (existing !== 0n) {
        setNotice(ERROR_MESSAGES["0xcaa60a55"]);
        return;
      }
      setNotice("Confirm createVault in your wallet.");
      const tx = await contract.createVault(
        derived.a,
        derived.b,
        derived.salt,
        BigInt(period)
      );
      const hash = await waitFor(tx);
      const id = await contract.vaultCount();
      setVaultId(id);
      setNotice(`Vault ${id} created. Transaction: ${hash}`);
    } catch (e) {
      setNotice(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  async function registerAsset() {
    if (!wallet || !vaultId || !isAddress(asset))
      return setAssetNotice(
        "Enter a valid token address after creating the vault."
      );
    setBusy(true);
    try {
      const contract = dmh(wallet.signer);
      const addTx = await contract.addToken(vaultId, asset, Number(assetType));
      const addHash = await waitFor(addTx);
      const assetContract = new Contract(
        asset,
        Number(assetType) === 0 ? ERC20_ABI : ERC721_ABI,
        wallet.signer
      );
      const approvalTx =
        Number(assetType) === 0
          ? await assetContract.approve(
              DMH_ADDRESS,
              parseUnits(allowance || "0", 18)
            )
          : await assetContract.setApprovalForAll(DMH_ADDRESS, true);
      const approvalHash = await waitFor(approvalTx);
      setAssetNotice(`Registered and approved. ${addHash} / ${approvalHash}`);
    } catch (e) {
      setAssetNotice(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="flow">
      <p className="eyebrow">Create · owner setup</p>
      <h1>Prepare what remains.</h1>
      <p className="intro">
        Two independent original phrases are required. Keep them in separate
        places. They are never sent to the chain.
      </p>
      <ConnectNotice wallet={wallet} />
      <div className="phrase-grid">
        <section>
          <h2>First half</h2>
          <PhraseField label="Phrase A" value={a} setValue={setA} />
          <PhraseField
            label="Retype Phrase A"
            value={ac}
            setValue={setAc}
            confirm
          />
        </section>
        <section>
          <h2>Second half</h2>
          <PhraseField label="Phrase B" value={b} setValue={setB} />
          <PhraseField
            label="Retype Phrase B"
            value={bc}
            setValue={setBc}
            confirm
          />
        </section>
      </div>
      <button className="primary" disabled={busy || !!derived} onClick={derive}>
        {busy ? "Working locally..." : "Derive public signers"}
      </button>
      {derived && (
        <section className="result">
          <p>Only these public values leave your device.</p>
          <code>Signer A: {derived.a}</code>
          <code>Signer B: {derived.b}</code>
          <small>Vault salt: {derived.salt}</small>
          <fieldset className="period-picker">
            <legend>Inactivity period</legend>
            <div className="period-options">
              {[["300", "5 minutes", "demo"], ["900", "15 minutes", "demo"], ["2592000", "30 days", "standard"], ["7776000", "90 days", "standard"], ["31536000", "365 days", "standard"]].map(([value, label, note]) => <button type="button" className={period === value ? "period-option selected" : "period-option"} key={value} onClick={() => setPeriod(value)}><strong>{label}</strong><small>{note}</small></button>)}
            </div>
          </fieldset>
          <button className="primary" disabled={busy} onClick={create}>
            {busy ? "Waiting for confirmation..." : "Create vault on-chain"}
          </button>
        </section>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {vaultId && (
        <section className="result">
          <h2>Register assets</h2>
          <p>
            Registration and approval are separate wallet transactions. Native
            BOT is not supported.
          </p>
          <label className="standard-field">
            <span>ERC-20 or enumerable ERC-721 address</span>
            <input
              value={asset}
              onChange={(e) => setAsset(e.target.value)}
              placeholder="0x..."
            />
          </label>
          <label className="standard-field">
            <span>Asset type</span>
            <select
              value={assetType}
              onChange={(e) => setAssetType(e.target.value)}
            >
              <option value="0">ERC-20</option>
              <option value="1">Enumerable ERC-721</option>
            </select>
          </label>
          {assetType === "0" && (
            <label className="standard-field">
              <span>ERC-20 allowance amount</span>
              <input
                value={allowance}
                onChange={(e) => setAllowance(e.target.value)}
                inputMode="decimal"
              />
            </label>
          )}
          <button className="primary" disabled={busy} onClick={registerAsset}>
            Register and approve asset
          </button>
          {assetNotice && <p className="notice">{assetNotice}</p>}
          <button className="secondary" onClick={() => setPage("dashboard")}>
            Open owner dashboard
          </button>
        </section>
      )}
    </main>
  );
}

function useVault(vaultId: string) {
  const [data, setData] = useState<{
    vault: Vault;
    tokens: { token: string; tokenType: number }[];
    claimable: boolean;
    remaining: bigint;
  }>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!vaultId || !/^\d+$/.test(vaultId)) return;
    let active = true;
    (async () => {
      try {
        const contract = dmh();
        const vault = await contract.getVault(BigInt(vaultId));
        const tokens = await contract.getVaultTokens(BigInt(vaultId));
        const [claimable, remaining] = await Promise.all([
          contract.isClaimable(BigInt(vaultId)),
          contract.remainingTime(BigInt(vaultId)),
        ]);
        if (active) setData({ vault, tokens, claimable, remaining });
      } catch (e) {
        if (active)
          setError(friendlyError(e));
      }
    })();
    return () => {
      active = false;
    };
  }, [vaultId]);
  return { data, error };
}

function VaultCard({ id, wallet }: { id: bigint; wallet: WalletState }) {
  const [tick, setTick] = useState(0);
  const [notice, setNotice] = useState("");
  const { data, error } = useVault(id.toString());
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  void tick;
  async function act(method: "ping" | "deactivateVault") {
    try {
      const tx = await dmh(wallet.signer)[method](id);
      const hash = await waitFor(tx);
      setNotice(`${method} confirmed: ${hash}`);
    } catch (e) {
          setNotice(friendlyError(e));
    }
  }
  if (error) return <p className="notice">{error}</p>;
  if (!data) return <p className="notice">Loading vault {id.toString()}...</p>;
  const seconds = Number(data.remaining);
  return (
    <section className="result dashboard-card">
      <div className="card-heading">
        <span>Vault {id.toString()}</span>
        <span className={`state state-${data.vault.state}`}>
          {["ACTIVE", "CLAIMED", "DEACTIVATED"][data.vault.state]}
        </span>
      </div>
      <p className="countdown">
        {data.claimable
          ? "Claimable now"
          : `${Math.floor(seconds / 86400)}d ${Math.floor(
              (seconds % 86400) / 3600
            )}h ${Math.floor((seconds % 3600) / 60)}m ${
              seconds % 60
            }s remaining`}
      </p>
      <p className="mono">
        Nonce {data.vault.nonce.toString()} · {data.tokens.length} registered
        assets
      </p>
      <div className="actions">
        <button
          className="secondary"
          disabled={data.vault.state !== 0}
          onClick={() => act("ping")}
        >
          Ping
        </button>
        <button
          className="secondary"
          disabled={data.vault.state === 2}
          onClick={() => act("deactivateVault")}
        >
          Deactivate
        </button>
        <a
          className="secondary link-button"
          href={explorerAddress(DMH_ADDRESS)}
          target="_blank"
          rel="noreferrer"
        >
          Explorer
        </a>
      </div>
      {notice && <p className="notice">{notice}</p>}
    </section>
  );
}

function Dashboard({ wallet }: { wallet?: WalletState }) {
  const [ids, setIds] = useState<bigint[]>();
  useEffect(() => {
    if (wallet)
      dmh()
        .vaultsOf(wallet.address)
        .then(setIds)
        .catch(() => setIds([]));
  }, [wallet]);
  if (!wallet)
    return (
      <main className="flow narrow">
        <h1>Your vaults.</h1>
        <p className="intro">
          Connect the owner wallet to view heartbeat status and registered
          assets.
        </p>
        <p className="notice">Use the Connect button in the header.</p>
      </main>
    );
  return (
    <main className="flow narrow">
      <p className="eyebrow">Owner dashboard</p>
      <h1>Keep the signal alive.</h1>
      <p className="intro mono">{wallet.address}</p>
      {ids?.length ? (
        ids.map((id) => (
          <VaultCard key={id.toString()} id={id} wallet={wallet} />
        ))
      ) : (
        <p className="notice">No vaults found for this wallet.</p>
      )}
    </main>
  );
}

function Claim() {
  const [id, setId] = useState("");
  const [destination, setDestination] = useState("");
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [data, setData] = useState<{
    vault: Vault;
    claimable: boolean;
    remaining: bigint;
  }>();
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  async function locate() {
    try {
      const contract = dmh();
      const vault = await contract.getVault(BigInt(id));
      const [claimable, remaining] = await Promise.all([
        contract.isClaimable(BigInt(id)),
        contract.remainingTime(BigInt(id)),
      ]);
      setData({ vault, claimable, remaining });
      setNotice("");
    } catch (e) {
      setNotice(friendlyError(e));
    }
  }
  async function claim() {
    if (!data || !isAddress(destination))
      return setNotice("Enter a valid destination address.");
    setBusy(true);
    try {
      const [sigA, sigB] = await Promise.all([
        signClaim(
          {
            phrase: normalizePhrase(a),
            owner: data.vault.owner,
            slot: "A",
            chainId: 968,
            vaultSalt: data.vault.vaultSalt,
          },
          DMH_ADDRESS,
          BigInt(id),
          destination,
          data.vault.nonce
        ),
        signClaim(
          {
            phrase: normalizePhrase(b),
            owner: data.vault.owner,
            slot: "B",
            chainId: 968,
            vaultSalt: data.vault.vaultSalt,
          },
          DMH_ADDRESS,
          BigInt(id),
          destination,
          data.vault.nonce
        ),
      ]);
      setA("");
      setB("");
      const wallet = await connectTestnetWallet();
      const fee = await dmh().currentClaimFee(BigInt(id), wallet.address);
      const tx = await dmh(wallet.signer).attemptClaim(
        BigInt(id),
        destination,
        sigA,
        sigB,
        { value: fee }
      );
      const receipt = await tx.wait();
      let failed = false;
      for (const log of receipt.logs as Log[]) {
        try {
          if (dmh().interface.parseLog(log)?.name === "ClaimFailed")
            failed = true;
        } catch {
          /* Ignore unrelated token logs. */
        }
      }
      setNotice(
        failed
          ? "Claim was not accepted. Both phrases must match exactly. Check the caller cooldown."
          : `Claim transaction confirmed: ${tx.hash}`
      );
    } catch (e) {
      setNotice(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="flow narrow">
      <p className="eyebrow">Claim · two signatures</p>
      <h1>
        A quiet process,
        <br />
        with exact words.
      </h1>
      <label className="standard-field">
        <span>Vault ID</span>
        <input
          value={id}
          onChange={(e) => setId(e.target.value)}
          inputMode="numeric"
          placeholder="1"
        />
      </label>
      <button className="primary" onClick={locate}>
        Locate vault
      </button>
      {data && (
        <section className="result">
          <p className="mono">Owner: {data.vault.owner}</p>
          <p>
            {data.claimable
              ? "This vault is claimable."
              : `Not claimable yet. ${data.remaining.toString()} seconds remain.`}
          </p>
          {data.claimable && (
            <>
              <PhraseField label="Phrase A" value={a} setValue={setA} />
              <PhraseField label="Phrase B" value={b} setValue={setB} />
              <label className="standard-field">
                <span>Destination</span>
                <input
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                  placeholder="Connected or external address"
                />
              </label>
              <button className="primary" disabled={busy} onClick={claim}>
                {busy
                  ? "Deriving and submitting..."
                  : "Sign both phrases and claim"}
              </button>
            </>
          )}
        </section>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
    </main>
  );
}

function Inspect() {
  const [id, setId] = useState("");
  const { data, error } = useVault(id);
  return (
    <main className="flow narrow">
      <p className="eyebrow">Public inspector</p>
      <h1>
        The chain keeps
        <br />
        only the witness.
      </h1>
      <p className="intro">
        Public vault metadata is readable without connecting a wallet. No phrase
        exists here.
      </p>
      <label className="standard-field">
        <span>Vault ID</span>
        <input
          value={id}
          onChange={(e) => setId(e.target.value)}
          inputMode="numeric"
          placeholder="1"
        />
      </label>
      {data && (
        <section className="result">
          <p className="state">
            {["ACTIVE", "CLAIMED", "DEACTIVATED"][data.vault.state]}
          </p>
          <p className="countdown">
            {data.claimable
              ? "Claimable now"
              : `${data.remaining.toString()} seconds remaining`}
          </p>
          <code>Signer A: {data.vault.signerA}</code>
          <code>Signer B: {data.vault.signerB}</code>
          <p className="mono">Registered assets: {data.tokens.length}</p>
          {data.tokens.map((entry) => (
            <div className="asset-row" key={entry.token}>
              <span className="mono">{entry.token}</span>
              <span>
                {entry.tokenType === 0 ? "ERC-20" : "Enumerable ERC-721"}
              </span>
            </div>
          ))}
        </section>
      )}
      {error && <p className="notice">{error}</p>}
    </main>
  );
}

export function App() {
  const [page, setPage] = useState<Page>("home");
  const [wallet, setWallet] = useState<WalletState>();
  return (
    <>
      <Header
        page={page}
        setPage={setPage}
        wallet={wallet}
        setWallet={setWallet}
      />
      {page === "home" && <Home setPage={setPage} />}
      {page === "create" && <CreateVault wallet={wallet} setPage={setPage} />}
      {page === "dashboard" && <Dashboard wallet={wallet} />}
      {page === "claim" && <Claim />}
      {page === "inspect" && <Inspect />}
    </>
  );
}
