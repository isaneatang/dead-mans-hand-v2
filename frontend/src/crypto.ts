export type DerivationInput = {
  phrase: string;
  owner: string;
  slot: "A" | "B";
  chainId: number;
  vaultSalt: string;
};

const worker = new Worker(new URL("./crypto.worker.ts", import.meta.url), {
  type: "module",
});

const pending = new Map<
  string,
  {
    resolve: (result: CryptoResult) => void;
    reject: (error: Error) => void;
  }
>();

type CryptoResult = { address: string; signature?: string };

worker.onmessage = ({ data }) => {
  const request = pending.get(data.id);
  if (!request) return;
  pending.delete(data.id);
  if (data.error) request.reject(new Error(data.error));
  else request.resolve({ address: data.address, signature: data.signature });
};

worker.onerror = () => {
  for (const [key, request] of pending) {
    pending.delete(key);
    request.reject(new Error("Local key derivation failed in this browser."));
  }
};

function requestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function runWorker(
  input: DerivationInput,
  operation: "address" | "signClaim",
  claim?: {
    contractAddress: string;
    vaultId: bigint;
    destination: string;
    nonce: bigint;
  },
): Promise<CryptoResult> {
  const id = requestId();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, operation, ...input, ...claim });
  });
}

export async function derivePublicAddress(input: DerivationInput): Promise<string> {
  return (await runWorker(input, "address")).address;
}

/**
 * Derives once, then returns both the public address and the claim signature.
 * The caller compares the address locally before spending a fee on-chain.
 */
export async function deriveAndSignClaim(
  input: DerivationInput,
  contractAddress: string,
  vaultId: bigint,
  destination: string,
  nonce: bigint,
): Promise<{ address: string; signature: string }> {
  const result = await runWorker(input, "signClaim", {
    contractAddress,
    vaultId,
    destination,
    nonce,
  });
  if (!result.signature) throw new Error("Local claim signing failed in this browser.");
  return { address: result.address, signature: result.signature };
}

export function createVaultSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function normalizePhrase(phrase: string): string {
  return phrase.normalize("NFC").trim();
}
