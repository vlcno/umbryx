"""Push notifications to the iPhone app through Apple's push service (APNs), in plain Python.

APNs only speaks HTTP/2 and wants a token signed with the developer account's push key (ES256), neither of which the
standard library has, so this file has the little of each that one push needs: a JSON Web Token signed with
p256.sign, and an HTTP/2 connection that sends one request and reads the answer. The headers it sends are written
out plainly (HPACK literals, no compression), and the answer's status is read from its first header (200) or, for a
refusal, from the JSON reason Apple puts in the body, so no HPACK decoder is needed.

Blocking calls: the server runs them in a worker thread (see Hub.notify)."""
import base64
import hashlib
import json
import socket
import ssl
import struct
import time

import p256

HOSTS = {False: "api.push.apple.com", True: "api.sandbox.push.apple.com"}


def _b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def provider_token(team_id, key_id, d, now=None):
    """The token every request carries, ES256-signed. Apple refuses one older than an hour, and new ones more often
    than every 20 minutes, so the server makes one every 50 minutes (see Hub.notify)."""
    header = _b64(json.dumps({"alg": "ES256", "kid": key_id}, separators=(",", ":")).encode())
    claims = _b64(json.dumps({"iss": team_id, "iat": int(now or time.time())}, separators=(",", ":")).encode())
    r, s = p256.sign(d, hashlib.sha256((header + "." + claims).encode()).digest())
    return header + "." + claims + "." + _b64(r.to_bytes(32, "big") + s.to_bytes(32, "big"))


def _frame(kind, flags, stream, payload=b""):
    return struct.pack(">I", len(payload))[1:] + bytes([kind, flags]) + struct.pack(">I", stream) + payload


def _int(value, prefix_bits, first=0):
    """An HPACK integer with a prefix of prefix_bits bits (RFC 7541 5.1)."""
    top = (1 << prefix_bits) - 1
    if value < top:
        return bytes([first | value])
    out, value = bytearray([first | top]), value - top
    while value >= 128:
        out.append((value & 0x7F) | 0x80)
        value >>= 7
    out.append(value)
    return bytes(out)


def _header_block(headers):
    """Each header as "literal, not indexed, new name", without Huffman coding: plain and always accepted."""
    out = bytearray()
    for name, value in headers:
        name, value = name.encode("ascii"), str(value).encode("utf-8")
        out += b"\x00" + _int(len(name), 7) + name + _int(len(value), 7) + value
    return bytes(out)


def _read_exact(tls, size):
    data = b""
    while len(data) < size:
        chunk = tls.recv(size - len(data))
        if not chunk:
            raise ConnectionError("APNs closed the connection")
        data += chunk
    return data


def send(device_token, payload, topic, token, sandbox=False, push_type="alert", priority=10, collapse_id=None,
         expiration=0, timeout=10):
    """One push to one device. Returns (status, reason): (200, None) when Apple took it; otherwise Apple's reason,
    such as "BadDeviceToken" or "Unregistered" (forget that device), "InvalidProviderToken" (the key or ids are
    wrong)."""
    host = HOSTS[bool(sandbox)]
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    headers = [(":method", "POST"), (":scheme", "https"), (":path", "/3/device/" + device_token), (":authority", host),
               ("authorization", "bearer " + token), ("apns-topic", topic), ("apns-push-type", push_type),
               ("apns-priority", priority), ("apns-expiration", expiration), ("content-length", len(body))]
    if collapse_id:
        headers.append(("apns-collapse-id", collapse_id[:64]))
    context = ssl.create_default_context()
    context.set_alpn_protocols(["h2"])
    with socket.create_connection((host, 443), timeout=timeout) as raw, context.wrap_socket(raw, server_hostname=host) as tls:
        if tls.selected_alpn_protocol() != "h2":
            raise ConnectionError("APNs did not agree to HTTP/2")
        tls.sendall(b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n" + _frame(0x4, 0, 0)            # preface, our (default) settings
                    + _frame(0x1, 0x4, 1, _header_block(headers))                    # HEADERS, END_HEADERS, stream 1
                    + _frame(0x0, 0x1, 1, body))                                     # DATA, END_STREAM
        status, data = None, b""
        while True:
            head = _read_exact(tls, 9)                                               # length, type, flags, stream
            length, kind, flags = int.from_bytes(head[:3], "big"), head[3], head[4]
            stream = int.from_bytes(head[5:9], "big") & 0x7FFFFFFF
            payload = _read_exact(tls, length)
            if kind in (0x0, 0x1) and flags & 0x8:                                   # PADDED
                payload = payload[1:len(payload) - payload[0]]
            if kind == 0x4 and not flags & 0x1:                                      # their SETTINGS: acknowledge
                tls.sendall(_frame(0x4, 0x1, 0))
            elif kind == 0x6 and not flags & 0x1:                                    # PING: answer
                tls.sendall(_frame(0x6, 0x1, 0, payload))
            elif kind == 0x7:                                                        # GOAWAY
                code = struct.unpack(">I", payload[4:8])[0] if len(payload) >= 8 else -1
                raise ConnectionError("APNs ended the connection (HTTP/2 error %d)" % code)
            elif stream == 1 and kind == 0x3:                                        # RST_STREAM
                raise ConnectionError("APNs refused the request")
            elif stream == 1 and kind == 0x1:                                        # the answer's headers
                if flags & 0x20:                                                     # PRIORITY fields first
                    payload = payload[5:]
                if payload[:1] == b"\x88":                                           # :status 200 (static index 8)
                    status = 200
                if flags & 0x1:
                    break
            elif stream == 1 and kind == 0x0:
                data += payload
                if flags & 0x1:
                    break
    if status == 200 and not data:
        return 200, None
    try:
        reason = json.loads(data).get("reason") if data else None
    except ValueError:
        reason = None
    return status or 400, reason or "Unknown"
