import { Wallet } from "ethers";

type CryptoRequest = {
  id: string;
  operation: "address" | "signClaim";
  phrase: string;
  owner: string;
  slot: "A" | "B";
  chainId: number;
  vaultSalt: string;
  contractAddress?: string;
  vaultId?: bigint;
  destination?: string;
  nonce?: bigint;
};

const ORDER = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
const CLAIM_TYPES = {
  ClaimAuthorization: [
    { name: "vaultId", type: "uint256" },
    { name: "destination", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
};

function hex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

self.onmessage = async ({ data }: MessageEvent<CryptoRequest>) => {
  let privateKey = "";
  try {
    const phrase = data.phrase.normalize("NFC").trim();
    if (!phrase) throw new Error("Phrase cannot be empty.");
    const baseSalt = `DMHv2|slot:${data.slot}|owner:${data.owner.toLowerCase()}|chain:${data.chainId}|vaultSalt:${data.vaultSalt.toLowerCase()}`;
    const material = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(phrase),
      "PBKDF2",
      false,
      ["deriveBits"],
    );

    for (let retry = 0; ; retry += 1) {
      const salt = retry === 0 ? baseSalt : `${baseSalt}|retry:${retry}`;
      const result = new Uint8Array(
        await crypto.subtle.deriveBits(
          {
            name: "PBKDF2",
            hash: "SHA-256",
            salt: new TextEncoder().encode(salt),
            iterations: 600_000,
          },
          material,
          256,
        ),
      );
      privateKey = hex(result);
      const scalar = BigInt(privateKey);
      result.fill(0);
      if (scalar > 0n && scalar < ORDER) {
        const wallet = new Wallet(privateKey);
        if (data.operation === "address") {
          self.postMessage({ id: data.id, address: wallet.address });
          return;
        }
        if (
          !data.contractAddress ||
          data.vaultId === undefined ||
          !data.destination ||
          data.nonce === undefined
        ) {
          throw new Error("Claim signing input is incomplete.");
        }
        const signature = await wallet.signTypedData(
          {
            name: "DeadMansHandV2",
            version: "2",
            chainId: data.chainId,
            verifyingContract: data.contractAddress,
          },
          CLAIM_TYPES,
          {
            vaultId: data.vaultId,
            destination: data.destination,
            nonce: data.nonce,
          },
        );
        self.postMessage({ id: data.id, address: wallet.address, signature });
        return;
      }
    }
  } catch (error) {
    self.postMessage({
      id: data.id,
      error: error instanceof Error ? error.message : "Derivation failed.",
    });
  } finally {
    privateKey = "";
    data.phrase = "";
  }
};
