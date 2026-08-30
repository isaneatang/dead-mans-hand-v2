import { expect } from "chai";
import vectors from "../test-vectors.json";
import { deriveAddress, derivePrivateKey } from "../src/crypto";

describe("shared cryptographic vectors", function () {
  this.timeout(120_000);

  for (const vector of vectors) {
    it(`derives ${vector.name}`, function () {
      const input = {
        phrase: vector.phrase,
        owner: vector.owner,
        slot: vector.slot as "A" | "B",
        chainId: vector.chainId,
        vaultSalt: vector.vaultSalt,
      };
      expect(derivePrivateKey(input)).to.equal(vector.expectedPrivateKey);
      expect(deriveAddress(input)).to.equal(vector.expectedAddress);
    });
  }

  it("normalizes NFC and NFD forms to the same key", function () {
    const vector = vectors[5];
    const nfc = vector.phrase.normalize("NFC");
    const nfd = vector.phrase.normalize("NFD");
    const common = {
      owner: vector.owner,
      slot: vector.slot as "A" | "B",
      chainId: vector.chainId,
      vaultSalt: vector.vaultSalt,
    };
    expect(derivePrivateKey({ ...common, phrase: nfc })).to.equal(
      derivePrivateKey({ ...common, phrase: nfd }),
    );
  });
});
