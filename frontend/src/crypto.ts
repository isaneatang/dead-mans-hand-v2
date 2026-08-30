import { Wallet } from "ethers";

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
  { resolve: (key: string) => void; reject: (error: Error) => void }
>();

worker.onmessage = ({ data }) => {
  const request = pending.get(data.id);
  if (!request) return;
  pending.delete(data.id);
  if (data.error) request.reject(new Error(data.error));
  else request.resolve(data.privateKey);
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

function derivePrivateKey(input: DerivationInput): Promise<string> {
  const id = requestId();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, ...input });
  });
}

const CLAIM_TYPES = {
  ClaimAuthorization: [
    { name: "vaultId", type: "uint256" },
    { name: "destination", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
};

export async function derivePublicAddress(input: DerivationInput): Promise<string> {
  let privateKey = await derivePrivateKey(input);
  try {
    return new Wallet(privateKey).address;
  } finally {
    privateKey = "";
  }
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
  let privateKey = await derivePrivateKey(input);
  try {
    const wallet = new Wallet(privateKey);
    const signature = await wallet.signTypedData(
      {
        name: "DeadMansHandV2",
        version: "2",
        chainId: input.chainId,
        verifyingContract: contractAddress,
      },
      CLAIM_TYPES,
      { vaultId, destination, nonce },
    );
    return { address: wallet.address, signature };
  } finally {
    privateKey = "";
  }
}

export function createVaultSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function normalizePhrase(phrase: string): string {
  return phrase.normalize("NFC").trim();
}
