type DeriveRequest = {
  id: string;
  phrase: string;
  owner: string;
  slot: "A" | "B";
  chainId: number;
  vaultSalt: string;
};

const ORDER = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");

function hex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

self.onmessage = async ({ data }: MessageEvent<DeriveRequest>) => {
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
      const privateKey = hex(result);
      const scalar = BigInt(privateKey);
      result.fill(0);
      if (scalar > 0n && scalar < ORDER) {
        self.postMessage({ id: data.id, privateKey });
        return;
      }
    }
  } catch (error) {
    self.postMessage({
      id: data.id,
      error: error instanceof Error ? error.message : "Derivation failed.",
    });
  } finally {
    data.phrase = "";
  }
};
