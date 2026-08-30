import { Wallet } from "ethers";

type DerivationInput = {
  phrase: string;
  owner: string;
  slot: "A" | "B";
  chainId: number;
  vaultSalt: string;
};

const worker = new Worker(new URL("./crypto.worker.ts", import.meta.url), { type: "module" });
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

function derivePrivateKey(input: DerivationInput): Promise<string> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, ...input });
  });
}

export async function derivePublicAddress(input: DerivationInput): Promise<string> {
  let privateKey = await derivePrivateKey(input);
  try {
    return new Wallet(privateKey).address;
  } finally {
    privateKey = "";
  }
}

export async function signClaim(
  input: DerivationInput,
  contractAddress: string,
  vaultId: bigint,
  destination: string,
  nonce: bigint,
): Promise<string> {
  let privateKey = await derivePrivateKey(input);
  try {
    const wallet = new Wallet(privateKey);
    return await wallet.signTypedData(
      {
        name: "DeadMansHandV2",
        version: "2",
        chainId: input.chainId,
        verifyingContract: contractAddress,
      },
      {
        ClaimAuthorization: [
          { name: "vaultId", type: "uint256" },
          { name: "destination", type: "address" },
          { name: "nonce", type: "uint256" },
        ],
      },
      { vaultId, destination, nonce },
    );
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
