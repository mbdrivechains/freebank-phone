#!/usr/bin/env python3
"""An independent check of webauthn-v1.json (PROTOCOL.md, "Face ID: passkeys"): a second implementation of the
desktop's assertion checks, in Python with `cryptography`, and of reading the key from the attestation object.

    python3 relay/testvectors/check_webauthn_v1.py
"""
import base64
import hashlib
import json
import pathlib
import sys

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec


def unb64u(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def check(pk, rp_id, origin, challenge, ad, cdj, sig, stored):
    """The new counter, or raises ValueError with why."""
    try:
        client = json.loads(cdj)
    except ValueError:
        raise ValueError("client data isn't JSON")
    if not isinstance(client, dict) or client.get("type") != "webauthn.get":
        raise ValueError("type")
    if client.get("challenge") != b64u(challenge):
        raise ValueError("challenge")
    if client.get("origin") != origin:
        raise ValueError("origin")
    if client.get("crossOrigin", False) is not False:
        raise ValueError("crossOrigin")
    if len(ad) < 37:
        raise ValueError("short authenticator data")
    if ad[:32] != hashlib.sha256(rp_id.encode()).digest():
        raise ValueError("rp id")
    if ad[32] & 0x01 == 0 or ad[32] & 0x04 == 0:
        raise ValueError("flags")
    key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), pk)
    try:
        key.verify(sig, ad + hashlib.sha256(cdj).digest(), ec.ECDSA(hashes.SHA256()))
    except InvalidSignature:
        raise ValueError("signature")
    count = int.from_bytes(ad[33:37], "big")
    if (count != 0 or stored != 0) and count <= stored:
        raise ValueError("counter")
    return count


def cbor(b, i=0):
    """A minimal CBOR decoder: (value, next index). Ints, byte and text strings, maps."""
    major, info = b[i] >> 5, b[i] & 31
    i += 1
    if info < 24:
        n = info
    elif info == 24:
        n, i = b[i], i + 1
    elif info == 25:
        n, i = int.from_bytes(b[i:i + 2], "big"), i + 2
    else:
        raise ValueError("cbor length")
    if major == 0:
        return n, i
    if major == 1:
        return -1 - n, i
    if major == 2:
        return b[i:i + n], i + n
    if major == 3:
        return b[i:i + n].decode(), i + n
    if major == 5:
        m = {}
        for _ in range(n):
            k, i = cbor(b, i)
            v, i = cbor(b, i)
            m[k] = v
        return m, i
    raise ValueError("cbor type")


def attested_key(obj):
    att, _ = cbor(obj)
    ad = att["authData"]
    assert ad[32] & 0x40, "no attested credential data"
    n = int.from_bytes(ad[53:55], "big")
    cred = ad[55:55 + n]
    key, _ = cbor(ad, 55 + n)
    assert key[1] == 2 and key[3] == -7 and key[-1] == 1, "not an ES256 P-256 key"
    return b"\x04" + key[-2] + key[-3], cred


def main():
    v = json.loads((pathlib.Path(__file__).parent / "webauthn-v1.json").read_text())
    pk, challenge = unb64u(v["pk"]), unb64u(v["challenge"])
    bad = 0
    for c in v["cases"]:
        try:
            got = check(pk, v["rp_id"], v["origin"], challenge, unb64u(c["ad"]), unb64u(c["cdj"]), unb64u(c["sig"]), c["stored_count"])
            ok, why = True, ""
        except ValueError as e:
            ok, why, got = False, str(e), None
        right = ok == c["ok"] and (not ok or got == c["new_count"])
        bad += not right
        print(("ok  " if right else "BAD ") + c["name"] + ("" if ok else f" (refused: {why})"))
    pk2, cred = attested_key(unb64u(v["attestation"]["object"]))
    right = b64u(pk2) == v["attestation"]["pk"] and b64u(cred) == v["attestation"]["cred"]
    bad += not right
    print(("ok  " if right else "BAD ") + "the key read from the attestation object")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
