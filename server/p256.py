"""P-256 (secp256r1) signatures in plain Python, so the server still needs nothing beyond the standard library:
ECDSA verification (passkeys, see passkeys.py), ECDSA signing with deterministic nonces (RFC 6979; the tokens for
Apple's push service, see push.py), and RSA PKCS#1 v1.5 verification (Windows Hello passkeys).

Plain Python is slow next to a crypto library, but a signature takes a few milliseconds and the server makes or checks
a handful an hour. Signing walks every bit of the nonce the same way (a Montgomery ladder); the server only signs its
own push tokens, about once an hour, never anything a visitor asks for."""
import hashlib
import hmac

P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
A = P - 3
B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B
N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
G = (0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296,
     0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5)


def on_curve(point):
    x, y = point
    return 0 <= x < P and 0 <= y < P and (y * y - (x * x * x + A * x + B)) % P == 0


def _add(p, q):
    """Two points added (None is the point at infinity)."""
    if p is None:
        return q
    if q is None:
        return p
    (x1, y1), (x2, y2) = p, q
    if x1 == x2:
        if (y1 + y2) % P == 0:
            return None
        slope = (3 * x1 * x1 + A) * pow(2 * y1, -1, P) % P
    else:
        slope = (y2 - y1) * pow(x2 - x1, -1, P) % P
    x3 = (slope * slope - x1 - x2) % P
    return x3, (slope * (x1 - x3) - y1) % P


def _mul(k, point):
    """k times a point, the same steps for every bit (a Montgomery ladder)."""
    r0, r1 = None, point
    for i in reversed(range(256)):
        if (k >> i) & 1:
            r0, r1 = _add(r0, r1), _add(r1, r1)
        else:
            r0, r1 = _add(r0, r0), _add(r0, r1)
    return r0


def public_key(d):
    return _mul(d, G)


def verify(point, digest, r, s):
    """ECDSA: whether (r, s) signs digest (SHA-256, 32 bytes) for the public key point."""
    if not (1 <= r < N and 1 <= s < N) or not on_curve(point):
        return False
    e = int.from_bytes(digest, "big")
    w = pow(s, -1, N)
    total = _add(_mul(e * w % N, G), _mul(r * w % N, point))
    return total is not None and total[0] % N == r


def _nonces(d, digest):
    """RFC 6979 deterministic nonces for SHA-256: the same message and key always give the same signature, and no
    random number generator is trusted with the key."""
    x = d.to_bytes(32, "big")
    h = (int.from_bytes(digest, "big") % N).to_bytes(32, "big")
    v, k = b"\x01" * 32, b"\x00" * 32
    k = hmac.new(k, v + b"\x00" + x + h, hashlib.sha256).digest()
    v = hmac.new(k, v, hashlib.sha256).digest()
    k = hmac.new(k, v + b"\x01" + x + h, hashlib.sha256).digest()
    v = hmac.new(k, v, hashlib.sha256).digest()
    while True:
        v = hmac.new(k, v, hashlib.sha256).digest()
        candidate = int.from_bytes(v, "big")
        if 1 <= candidate < N:
            yield candidate
        k = hmac.new(k, v + b"\x00", hashlib.sha256).digest()
        v = hmac.new(k, v, hashlib.sha256).digest()


def sign(d, digest):
    """ECDSA with the private key d over a SHA-256 digest: (r, s)."""
    e = int.from_bytes(digest, "big")
    for k in _nonces(d, digest):
        r = _mul(k, G)[0] % N
        if not r:
            continue
        s = pow(k, -1, N) * (e + r * d) % N
        if s:
            return r, s
    raise AssertionError("unreachable")


def der_signature(data):
    """(r, s) from an ECDSA signature in DER (SEQUENCE of two INTEGERs), as passkeys send them."""
    def item(pos, tag):
        if data[pos] != tag:
            raise ValueError("bad DER")
        length, pos = data[pos + 1], pos + 2
        if length & 0x80:
            count = length & 0x7F
            length, pos = int.from_bytes(data[pos:pos + count], "big"), pos + count
        return data[pos:pos + length], pos + length
    body, end = item(0, 0x30)
    if end != len(data):
        raise ValueError("bad DER")
    data = body
    r, pos = item(0, 0x02)
    s, pos = item(pos, 0x02)
    if pos != len(data):
        raise ValueError("bad DER")
    return int.from_bytes(r, "big"), int.from_bytes(s, "big")


_SHA256_PREFIX = bytes.fromhex("3031300d060960864801650304020105000420")


def rsa_verify(n, e, digest, signature):
    """RSA PKCS#1 v1.5 with SHA-256 (RS256): whether signature signs digest for the public key (n, e)."""
    size = (n.bit_length() + 7) // 8
    if len(signature) != size or n.bit_length() < 2048:
        return False
    m = pow(int.from_bytes(signature, "big"), e, n).to_bytes(size, "big")
    expected = b"\x00\x01" + b"\xff" * (size - 3 - len(_SHA256_PREFIX) - len(digest)) + b"\x00" + _SHA256_PREFIX + digest
    return hmac.compare_digest(m, expected)


def private_key_from_pem(text):
    """The private number d from a P-256 key in a PEM file (PKCS#8 "PRIVATE KEY", as Apple's .p8 push keys are, or
    SEC1 "EC PRIVATE KEY")."""
    import base64
    body = "".join(line for line in text.strip().splitlines() if line and not line.startswith("-----"))
    der = base64.b64decode(body)

    def parse(data, pos):
        tag, length, pos = data[pos], data[pos + 1], pos + 2
        if length & 0x80:
            count = length & 0x7F
            length, pos = int.from_bytes(data[pos:pos + count], "big"), pos + count
        return tag, data[pos:pos + length], pos + length

    def children(data):
        pos, out = 0, []
        while pos < len(data):
            tag, value, pos = parse(data, pos)
            out.append((tag, value))
        return out

    tag, top, _ = parse(der, 0)
    parts = children(top)
    if len(parts) >= 3 and parts[1][0] == 0x30 and parts[2][0] == 0x04:      # PKCS#8: version, algorithm, key
        parts = children(parse(parts[2][1], 0)[1])                          # the SEC1 ECPrivateKey inside
    secret = next(value for tag, value in parts if tag == 0x04)              # SEC1: version, OCTET STRING d, ...
    d = int.from_bytes(secret, "big")
    if not 1 <= d < N:
        raise ValueError("not a P-256 private key")
    return d
