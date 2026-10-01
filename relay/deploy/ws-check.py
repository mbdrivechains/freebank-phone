#!/usr/bin/env python3
"""End-to-end check of fb-relay's WebSocket path: TLS (for wss://), the upgrade, and the relay protocol.

It joins a room nobody hosts (a well-formed room id no desktop owns) and expects {"t":"offline"} and then a normal
close (1000). No keys, rooms or data of anyone's are involved. Python 3 standard library only.

    python3 ws-check.py wss://app.ecxfreebank.com/ws --origin https://app.ecxfreebank.com
    python3 ws-check.py ws://127.0.0.1:8480/ws
    python3 ws-check.py wss://app.ecxfreebank.com/ws --origin https://evil.example --expect 403

Exit status 0 when what it saw is what it expected.
"""

import argparse
import base64
import hashlib
import json
import os
import socket
import ssl
import struct
import sys
import urllib.parse

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
NOBODYS_ROOM = "A" * 22  # well-formed (22 chars of base64url), and no desktop's key hashes to it


def fail(msg: str) -> None:
    print(f"FAIL: {msg}")
    sys.exit(1)


class Frames:
    """Reads server frames (unmasked) from a socket, after any bytes left over from the HTTP response."""

    def __init__(self, sock, rest: bytes):
        self.sock, self.buf = sock, rest

    def _need(self, n: int) -> bytes:
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                fail("the connection ended in the middle of a frame")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def next(self):
        b0, b1 = self._need(2)
        opcode, length = b0 & 0x0F, b1 & 0x7F
        if b1 & 0x80:
            fail("the server masked a frame")
        if length == 126:
            (length,) = struct.unpack("!H", self._need(2))
        elif length == 127:
            (length,) = struct.unpack("!Q", self._need(8))
        return opcode, self._need(length)


def send_text(sock, text: str) -> None:
    payload = text.encode()
    mask = os.urandom(4)
    head = bytes([0x81])
    n = len(payload)
    if n < 126:
        head += bytes([0x80 | n])
    elif n < 65536:
        head += bytes([0x80 | 126]) + struct.pack("!H", n)
    else:
        head += bytes([0x80 | 127]) + struct.pack("!Q", n)
    sock.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("url", help="ws://host:port/ws or wss://host/ws")
    ap.add_argument("--origin", help="send this Origin header, as a browser would")
    ap.add_argument("--expect", type=int, default=101, help="the HTTP status expected for the upgrade (101)")
    ap.add_argument("--insecure", action="store_true", help="don't verify the TLS certificate (local tests only)")
    a = ap.parse_args()

    u = urllib.parse.urlsplit(a.url)
    if u.scheme not in ("ws", "wss") or not u.hostname:
        fail("the URL must be ws://… or wss://…")
    port = u.port or (443 if u.scheme == "wss" else 80)
    raw = socket.create_connection((u.hostname, port), timeout=10)
    if u.scheme == "wss":
        ctx = ssl.create_default_context()
        if a.insecure:
            ctx.check_hostname, ctx.verify_mode = False, ssl.CERT_NONE
        sock = ctx.wrap_socket(raw, server_hostname=u.hostname)
        print(f"TLS: {sock.version()}, certificate for {u.hostname} {'not checked' if a.insecure else 'verified'}")
    else:
        sock = raw

    key = base64.b64encode(os.urandom(16)).decode()
    host = u.hostname if u.port is None else f"{u.hostname}:{u.port}"
    lines = [
        f"GET {u.path or '/'} HTTP/1.1",
        f"Host: {host}",
        "Upgrade: websocket",
        "Connection: Upgrade",
        f"Sec-WebSocket-Key: {key}",
        "Sec-WebSocket-Version: 13",
    ]
    if a.origin:
        lines.append(f"Origin: {a.origin}")
    sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())

    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            fail("the connection ended during the upgrade")
        buf += chunk
    head, rest = buf.split(b"\r\n\r\n", 1)
    status_line = head.split(b"\r\n")[0].decode(errors="replace")
    try:
        status = int(status_line.split()[1])
    except (IndexError, ValueError):
        fail(f"not an HTTP response: {status_line!r}")
    print(f"upgrade: {status_line}")
    if status != a.expect:
        fail(f"expected HTTP {a.expect}")
    if status != 101:
        print("OK")
        return
    want = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
    if f"sec-websocket-accept: {want}".lower() not in head.decode(errors="replace").lower():
        fail("wrong Sec-WebSocket-Accept")

    send_text(sock, json.dumps({"t": "join", "room": NOBODYS_ROOM}))
    frames = Frames(sock, rest)
    got_offline = False
    while True:
        opcode, payload = frames.next()
        if opcode == 0x1:
            msg = json.loads(payload)
            print(f"relay said: {msg}")
            if msg != {"t": "offline"}:
                fail('expected {"t":"offline"}')
            got_offline = True
        elif opcode == 0x8:
            code = struct.unpack("!H", payload[:2])[0] if len(payload) >= 2 else None
            print(f"relay closed: {code} {payload[2:].decode(errors='replace')}")
            if not got_offline or code != 1000:
                fail('expected {"t":"offline"} and then a normal close (1000)')
            print("OK")
            return
        # pings and pongs: nothing to do in a check this short


if __name__ == "__main__":
    main()
