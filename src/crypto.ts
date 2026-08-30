import { pbkdf2Sync } from "node:crypto";
import { Wallet } from "ethers";

export type PhraseSlot = "A" | "B";

export type DerivationInput = {
  phrase: string;
  owner: string;
  slot: PhraseSlot;
  chainId: number | bigint;
  vaultSalt: string;
};

const SECP256K1_ORDER = BigInt(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141",
);

export function normalizePhrase(phrase: string): string {
  return phrase.normalize("NFC").trim();
}

export function kdfSalt(input: Omit<DerivationInput, "phrase">): string {
  return `DMHv2|slot:${input.slot}|owner:${input.owner.toLowerCase()}|chain:${input.chainId.toString()}|vaultSalt:${input.vaultSalt.toLowerCase()}`;
}

export function derivePrivateKey(input: DerivationInput): string {
  const phrase = normalizePhrase(input.phrase);
  if (!phrase) throw new Error("Phrase cannot be empty");

  const baseSalt = kdfSalt(input);
  for (let retry = 0; ; retry += 1) {
    const salt = retry === 0 ? baseSalt : `${baseSalt}|retry:${retry}`;
    const bytes = pbkdf2Sync(
      Buffer.from(phrase, "utf8"),
      Buffer.from(salt, "utf8"),
      600_000,
      32,
      "sha256",
    );
    const scalar = BigInt(`0x${bytes.toString("hex")}`);
    if (scalar > 0n && scalar < SECP256K1_ORDER) return `0x${bytes.toString("hex")}`;
  }
}

export function deriveAddress(input: DerivationInput): string {
  return new Wallet(derivePrivateKey(input)).address;
}
