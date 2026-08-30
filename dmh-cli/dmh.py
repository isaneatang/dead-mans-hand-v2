#!/usr/bin/env python3
"""Offline verifier for the frozen DMH v2 phrase derivation and claim format."""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import sys
import unicodedata
from pathlib import Path

from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils import is_address, to_checksum_address


ORDER = int("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141", 16)
ROOT = Path(__file__).resolve().parent.parent
ECMASCRIPT_TRIM = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def normalize_phrase(phrase: str) -> str:
    return unicodedata.normalize("NFC", phrase).strip(ECMASCRIPT_TRIM)


def derive_private_key(phrase: str, owner: str, slot: str, chain_id: int, vault_salt: str) -> bytes:
    normalized = normalize_phrase(phrase)
    if not normalized:
        raise ValueError("Phrase cannot be empty")
    if not is_address(owner):
        raise ValueError("Owner must be an EVM address")
    if slot not in ("A", "B"):
        raise ValueError("Slot must be A or B")
    if len(vault_salt) != 66 or not vault_salt.startswith("0x"):
        raise ValueError("Vault salt must be 32-byte 0x-prefixed hex")

    base_salt = (
        f"DMHv2|slot:{slot}|owner:{owner.lower()}|chain:{chain_id}"
        f"|vaultSalt:{vault_salt.lower()}"
    )
    retry = 0
    while True:
        salt = base_salt if retry == 0 else f"{base_salt}|retry:{retry}"
        candidate = hashlib.pbkdf2_hmac(
            "sha256", normalized.encode("utf-8"), salt.encode("utf-8"), 600_000, dklen=32
        )
        scalar = int.from_bytes(candidate, "big")
        if 0 < scalar < ORDER:
            return candidate
        retry += 1


def derived_address(private_key: bytes) -> str:
    return Account.from_key(private_key).address


def claim_typed_data(
    chain_id: int, contract: str, vault_id: int, destination: str, nonce: int
) -> dict:
    return {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "ClaimAuthorization": [
                {"name": "vaultId", "type": "uint256"},
                {"name": "destination", "type": "address"},
                {"name": "nonce", "type": "uint256"},
            ],
        },
        "primaryType": "ClaimAuthorization",
        "domain": {
            "name": "DeadMansHandV2",
            "version": "2",
            "chainId": chain_id,
            "verifyingContract": to_checksum_address(contract),
        },
        "message": {
            "vaultId": vault_id,
            "destination": to_checksum_address(destination),
            "nonce": nonce,
        },
    }


def derive_command(args: argparse.Namespace) -> int:
    phrase = getpass.getpass("Phrase (hidden): ")
    key = derive_private_key(phrase, args.owner, args.slot, args.chain_id, args.vault_salt)
    print(f"Derived address: {derived_address(key)}")
    if args.show_private_key:
        print("WARNING: This private key grants signing power. Never share or fund it.", file=sys.stderr)
        print(f"Private key: 0x{key.hex()}")
    return 0


def sign_command(args: argparse.Namespace) -> int:
    if not is_address(args.contract) or not is_address(args.destination):
        raise ValueError("Contract and destination must be EVM addresses")
    phrase = getpass.getpass(f"Phrase {args.slot} (hidden): ")
    key = derive_private_key(phrase, args.owner, args.slot, args.chain_id, args.vault_salt)
    message = encode_typed_data(
        full_message=claim_typed_data(
            args.chain_id, args.contract, args.vault_id, args.destination, args.nonce
        )
    )
    signature = Account.sign_message(message, key).signature.hex()
    print(f"Signer: {derived_address(key)}")
    print(f"Signature: 0x{signature}")
    return 0


def verify_vectors_command(_: argparse.Namespace) -> int:
    vectors = json.loads((ROOT / "test-vectors.json").read_text(encoding="utf-8"))
    failures = 0
    for vector in vectors:
        key = derive_private_key(
            vector["phrase"],
            vector["owner"],
            vector["slot"],
            vector["chainId"],
            vector["vaultSalt"],
        )
        key_hex = f"0x{key.hex()}"
        address = derived_address(key)
        ok = key_hex == vector["expectedPrivateKey"] and address == vector["expectedAddress"]
        print(f"{'PASS' if ok else 'FAIL'} {vector['name']}")
        if not ok:
            failures += 1
    return 1 if failures else 0


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Offline DMH v2 cryptographic verifier")
    commands = result.add_subparsers(dest="command", required=True)

    derive = commands.add_parser("derive")
    derive.add_argument("--owner", required=True)
    derive.add_argument("--slot", choices=("A", "B"), required=True)
    derive.add_argument("--chain-id", type=int, required=True)
    derive.add_argument("--vault-salt", required=True)
    derive.add_argument("--show-private-key", action="store_true")
    derive.set_defaults(handler=derive_command)

    sign = commands.add_parser("sign-claim")
    sign.add_argument("--owner", required=True)
    sign.add_argument("--slot", choices=("A", "B"), required=True)
    sign.add_argument("--chain-id", type=int, required=True)
    sign.add_argument("--vault-salt", required=True)
    sign.add_argument("--contract", required=True)
    sign.add_argument("--vault-id", type=int, required=True)
    sign.add_argument("--destination", required=True)
    sign.add_argument("--nonce", type=int, required=True)
    sign.set_defaults(handler=sign_command)

    verify = commands.add_parser("verify-vectors")
    verify.set_defaults(handler=verify_vectors_command)
    return result


def main() -> int:
    try:
        args = parser().parse_args()
        return args.handler(args)
    except (ValueError, OSError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
