import { useState } from "react";
import { isAddress } from "ethers";
import { chains } from "../../config/chains";
import { createVaultSalt, derivePublicAddress, normalizePhrase } from "./crypto";
import { connectTestnetWallet } from "./wallet";

type Page = "home" | "create" | "claim" | "inspect";

const chain = chains[968];

function Seal() {
  return (
    <div className="seal" aria-hidden="true">
      <span>A</span><i /><span>B</span>
    </div>
  );
}

function Header({ page, setPage }: { page: Page; setPage: (page: Page) => void }) {
  return (
    <header>
      <button className="wordmark" onClick={() => setPage("home")}>DMH <sup>v2</sup></button>
      <nav aria-label="Primary navigation">
        {(["create", "claim", "inspect"] as Page[]).map((item) => (
          <button className={page === item ? "active" : ""} key={item} onClick={() => setPage(item)}>
            {item[0].toUpperCase() + item.slice(1)}
          </button>
        ))}
      </nav>
      <span className="network">TESTNET · 968</span>
    </header>
  );
}

function Home({ setPage }: { setPage: (page: Page) => void }) {
  return (
    <main>
      <section className="hero">
        <div>
          <p className="eyebrow">Chain as witness</p>
          <h1>If you go silent,<br /><em>your assets don't.</em></h1>
          <p className="lede">A non-custodial inheritance protocol guarded by time, two private phrases, and nothing else.</p>
          <div className="actions">
            <button className="primary" onClick={() => setPage("create")}>Create a vault</button>
            <button className="secondary" onClick={() => setPage("claim")}>Make a claim</button>
          </div>
        </div>
        <Seal />
      </section>
      <section className="steps">
        <article><b>01</b><h2>Register</h2><p>Your assets stay in your wallet. Only chosen token allowances are granted.</p></article>
        <article><b>02</b><h2>Stay present</h2><p>A heartbeat resets your inactivity clock. While you respond, nothing can move.</p></article>
        <article><b>03</b><h2>Pass it on</h2><p>Two local signatures release registered assets after silence. The phrases never leave the device.</p></article>
      </section>
      <aside className="status"><span>Reviewed design</span><span>Unaudited implementation</span><span>Testnet only</span></aside>
    </main>
  );
}

function PhraseField({ label, value, setValue, confirm = false }: { label: string; value: string; setValue: (v: string) => void; confirm?: boolean }) {
  return (
    <label className="phrase-field">
      <span>{label}</span>
      <textarea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onPaste={confirm ? (event) => event.preventDefault() : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder="Write something original that has never appeared in a book, lyric, post, or message..."
      />
      <small>{Array.from(normalizePhrase(value)).length} characters · internal spaces and line breaks matter</small>
    </label>
  );
}

function CreateVault() {
  const [address, setAddress] = useState("");
  const [phraseA, setPhraseA] = useState("");
  const [confirmA, setConfirmA] = useState("");
  const [phraseB, setPhraseB] = useState("");
  const [confirmB, setConfirmB] = useState("");
  const [derived, setDerived] = useState<{ signerA: string; signerB: string; salt: string }>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  async function connect() {
    try {
      const wallet = await connectTestnetWallet();
      setAddress(wallet.address);
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Wallet connection failed.");
    }
  }

  async function derive() {
    const a = normalizePhrase(phraseA);
    const b = normalizePhrase(phraseB);
    if (!isAddress(address)) return setNotice("Connect a valid owner wallet first.");
    if (Array.from(a).length < 20 || Array.from(b).length < 20) return setNotice("Each phrase needs at least 20 characters.");
    if (a !== normalizePhrase(confirmA) || b !== normalizePhrase(confirmB)) return setNotice("A confirmation does not match exactly after normalization.");
    if (a === b) return setNotice("Phrase A and Phrase B must be independent.");
    setBusy(true);
    setNotice("Deriving both public signers locally. This deliberate pause slows offline guessing.");
    const salt = createVaultSalt();
    try {
      const signerA = await derivePublicAddress({ phrase: a, owner: address, slot: "A", chainId: 968, vaultSalt: salt });
      const signerB = await derivePublicAddress({ phrase: b, owner: address, slot: "B", chainId: 968, vaultSalt: salt });
      setDerived({ signerA, signerB, salt });
      setPhraseA(""); setConfirmA(""); setPhraseB(""); setConfirmB("");
      setNotice(chain.dmhAddress ? "Public signers are ready for vault creation." : "Public signers derived. Contract deployment is intentionally pending; no transaction was sent.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Derivation failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flow">
      <p className="eyebrow">Create · two independent secrets</p>
      <h1>Prepare what remains.</h1>
      <p className="intro">Never use personal facts, known poems, lyrics, quotes, or text found online. Keep each phrase in a different place. Both are permanently required.</p>
      <div className="wallet-row"><span className="mono">{address || "No owner wallet connected"}</span><button className="secondary" onClick={connect}>Connect wallet</button></div>
      <div className="phrase-grid">
        <section><h2>First half</h2><PhraseField label="Phrase A" value={phraseA} setValue={setPhraseA} /><PhraseField label="Retype Phrase A" value={confirmA} setValue={setConfirmA} confirm /></section>
        <section><h2>Second half</h2><PhraseField label="Phrase B" value={phraseB} setValue={setPhraseB} /><PhraseField label="Retype Phrase B" value={confirmB} setValue={setConfirmB} confirm /></section>
      </div>
      <button className="primary" disabled={busy} onClick={derive}>{busy ? "Deriving locally..." : "Derive public signers"}</button>
      {notice && <p className="notice" role="status">{notice}</p>}
      {derived && <section className="result"><p>These public addresses are all the chain will ever know.</p><code>{derived.signerA}</code><code>{derived.signerB}</code><small>Public vault salt: {derived.salt}</small></section>}
    </main>
  );
}

function Claim() {
  return (
    <main className="flow narrow">
      <p className="eyebrow">Claim · when the clock has passed</p>
      <h1>A quiet process,<br />with exact words.</h1>
      <p className="intro">Enter a vault ID to inspect its timer and registered signers. Phrase entry remains unavailable until a verified contract address is configured.</p>
      <label className="standard-field"><span>Vault ID</span><input inputMode="numeric" placeholder="e.g. 42" /></label>
      <button className="primary" disabled={!chain.dmhAddress}>Locate vault</button>
      {!chain.dmhAddress && <p className="notice">DMH v2 is not deployed on testnet yet. The application refuses to guess a contract address.</p>}
    </main>
  );
}

function Inspect() {
  return (
    <main className="flow narrow">
      <p className="eyebrow">Public inspector</p>
      <h1>The chain keeps<br />only the witness.</h1>
      <p className="intro">Vault state, timer, token registry, public signers, and fee are transparent. No secret exists here to reveal.</p>
      <label className="standard-field"><span>Vault ID</span><input inputMode="numeric" placeholder="Enter a vault number" /></label>
      <button className="primary" disabled={!chain.dmhAddress}>Inspect on chain</button>
      {!chain.dmhAddress && <p className="notice">Inspector activates after a verified testnet deployment.</p>}
    </main>
  );
}

export function App() {
  const [page, setPage] = useState<Page>("home");
  return <><Header page={page} setPage={setPage} />{page === "home" && <Home setPage={setPage} />}{page === "create" && <CreateVault />}{page === "claim" && <Claim />}{page === "inspect" && <Inspect />}</>;
}
