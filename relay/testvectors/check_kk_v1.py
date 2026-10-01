#!/usr/bin/env python3
"""Check kk-v1.json with Python's `cryptography` (OpenSSL), independently of the JS and Rust code that use it.

    python3 relay/testvectors/check_kk_v1.py [path/to/kk-v1.json]

Recomputes every derived value in the file from the fixed keys: the keys themselves, the room, the pairing key,
ciphertext and comparison code, the session keys and messages, and the host proof (message and signature). Exits 1
on the first mismatch.
"""

import base64
import hashlib
import json
import pathlib
import sys

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

path = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else pathlib.Path(__file__).with_name("kk-v1.json"))
V = json.loads(path.read_text())
checked = 0


def unb64u(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def check(what: str, got, want) -> None:
    global checked
    if got != want:
        print(f"MISMATCH {what}:\n  got  {got!r}\n  want {want!r}")
        sys.exit(1)
    checked += 1


def raw_pub(key) -> bytes:
    return key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def pub_key(raw: bytes):
    return ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), raw)


def hkdf(ikm: bytes, salt: bytes, info: bytes, n: int) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=n, salt=salt, info=info).derive(ikm)


# Keys: d = SHA-256(label), pub = its uncompressed point.
keys = {}
for name, k in V["keys"].items():
    d = hashlib.sha256(k["scalar_label"].encode()).digest()
    check(f"keys.{name}.jwk.d", unb64u(k["jwk"]["d"]), d)
    priv = ec.derive_private_key(int.from_bytes(d, "big"), ec.SECP256R1())
    check(f"keys.{name}.pub", k["pub"], b64u(raw_pub(priv)))
    keys[name] = priv
pub = {name: raw_pub(k) for name, k in keys.items()}


def ecdh(priv_name: str, pub_raw: bytes) -> bytes:
    return keys[priv_name].exchange(ec.ECDH(), pub_key(pub_raw))


# Room.
check("room.room", V["room"]["room"], b64u(hashlib.sha256(pub["D"]).digest())[:22])

# Pairing: the key, the ciphertext, the comparison code.
p = V["pair"]
c = unb64u(p["c"])
check("pair.ecdh", p["ecdh"], b64u(ecdh("E", pub["D"])))
check("pair.ecdh (desktop side)", p["ecdh"], b64u(ecdh("D", pub["E"])))
k = hkdf(ecdh("E", pub["D"]), c, b"fb-pair-v1", 32)
check("pair.k", p["k"], b64u(k))
check("pair.ct", p["ct"], b64u(AESGCM(k).encrypt(unb64u(p["nonce"]), p["plaintext"].encode(), None)))
check("pair.frame", p["frame"], {"t": "pair", "e": b64u(pub["E"]), "ct": p["ct"], "n": p["nonce"]})
check("pair.plaintext.p", json.loads(p["plaintext"])["p"], b64u(pub["P"]))
h = hashlib.sha256(b"fb-pair-sas-v1" + pub["D"] + pub["P"] + pub["E"] + c).digest()
code = f"{int.from_bytes(h[:4], 'big') % 1_000_000:06d}"
check("pair.sas.h_hex", p["sas"]["h_hex"], h.hex())
check("pair.sas.u32", p["sas"]["u32"], int.from_bytes(h[:4], "big"))
check("pair.sas.code", p["sas"]["code"], code)
check("pair.sas.display", p["sas"]["display"], f"{code[:3]} {code[3:]}")

# Session (KK): the phone's view, and the desktop's mirrored terms.
s = V["session"]
dh1, dh2, dh3 = ecdh("eP", pub["eD"]), ecdh("eP", pub["D"]), ecdh("P", pub["eD"])
check("session dh1 both sides", dh1, ecdh("eD", pub["eP"]))
check("session dh2 both sides", dh2, ecdh("D", pub["eP"]))
check("session dh3 both sides", dh3, ecdh("eD", pub["P"]))
for name, val in (("dh1", dh1), ("dh2", dh2), ("dh3", dh3), ("ikm", dh1 + dh2 + dh3)):
    check(f"session.{name}", s[name], b64u(val))
th = hashlib.sha256(b"fb-kk-v1" + pub["P"] + pub["D"] + pub["eP"] + pub["eD"]).digest()
check("session.th", s["th"], b64u(th))
okm = hkdf(dh1 + dh2 + dh3, th, b"fb-session-v1", 64)
check("session.k_pd", s["k_pd"], b64u(okm[:32]))
check("session.k_dp", s["k_dp"], b64u(okm[32:]))
for direction, key in (("phone_to_desktop", okm[:32]), ("desktop_to_phone", okm[32:])):
    for m in s[direction]:
        nonce = m["counter"].to_bytes(12, "big")
        check(f"session.{direction}[{m['counter']}].nonce", m["nonce"], b64u(nonce))
        check(f"session.{direction}[{m['counter']}].ct", m["ct"], b64u(AESGCM(key).encrypt(nonce, m["plaintext"].encode(), None)))

# Host proof: ECDSA P-256/SHA-256 over "fb-relay-proof-v1" || n; r || s.
pr = V["proof"]
n = unb64u(pr["n"])
msg = b"fb-relay-proof-v1" + n
check("proof.context", pr["context"], "fb-relay-proof-v1")
check("proof.n_hex", pr["n_hex"], n.hex())
check("proof.msg_hex", pr["msg_hex"], msg.hex())
sig = unb64u(pr["sig"])
check("proof.sig length", len(sig), 64)
der = encode_dss_signature(int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big"))
d_pub = pub_key(pub["D"])
try:
    d_pub.verify(der, msg, ec.ECDSA(hashes.SHA256()))
    checked += 1
except InvalidSignature:
    check("proof.sig verifies over the message", False, True)
try:
    d_pub.verify(der, n, ec.ECDSA(hashes.SHA256()))
    check("proof.sig must not verify over the bare challenge", True, False)
except InvalidSignature:
    checked += 1
check("proof.frame", pr["frame"], {"t": "proof", "sig": pr["sig"]})

print(f"OK: {checked} checks of {path.name} with cryptography (OpenSSL)")
