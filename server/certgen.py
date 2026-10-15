"""Self-signed TLS certificates using only the Python standard library.

Browsers only allow microphone and screen capture on secure pages, so the
server needs HTTPS for everyone who is not on the host machine itself. This
module builds an RSA-2048 key and an X.509 v3 certificate by hand so that no
third-party packages are needed.
"""
import base64
import datetime as dt
import hashlib
import ipaddress
import secrets

_E = 65537
# DigestInfo header for SHA-256 (RFC 8017, section 9.2).
_SHA256_PREFIX = bytes.fromhex("3031300d060960864801650304020105000420")
_RSA_ENCRYPTION = "1.2.840.113549.1.1.1"
_SHA256_WITH_RSA = "1.2.840.113549.1.1.11"


def _sieve(limit):
    flags = bytearray([1]) * limit
    flags[0:2] = b"\x00\x00"
    for i in range(2, int(limit ** 0.5) + 1):
        if flags[i]:
            flags[i * i::i] = bytearray(len(flags[i * i::i]))
    return [i for i, f in enumerate(flags) if f]


_SMALL_PRIMES = _sieve(2000)


def _probable_prime(n, rounds=24):
    """Miller-Rabin with random bases."""
    if n < 2:
        return False
    for p in _SMALL_PRIMES:
        if n % p == 0:
            return n == p
    d, r = n - 1, 0
    while d % 2 == 0:
        d //= 2
        r += 1
    for _ in range(rounds):
        x = pow(secrets.randbelow(n - 3) + 2, d, n)
        if x in (1, n - 1):
            continue
        for _ in range(r - 1):
            x = pow(x, 2, n)
            if x == n - 1:
                break
        else:
            return False
    return True


def _prime(bits):
    while True:
        # Top two bits set so the product of two primes has exactly 2*bits bits.
        n = secrets.randbits(bits) | (0b11 << (bits - 2)) | 1
        if n % _E != 1 and _probable_prime(n):
            return n


# --- minimal DER encoder -------------------------------------------------

def _tlv(tag, content):
    n = len(content)
    if n < 0x80:
        length = bytes([n])
    else:
        raw = n.to_bytes((n.bit_length() + 7) // 8, "big")
        length = bytes([0x80 | len(raw)]) + raw
    return bytes([tag]) + length + content


def _int(n):
    return _tlv(0x02, n.to_bytes(n.bit_length() // 8 + 1, "big"))


def _seq(*items):
    return _tlv(0x30, b"".join(items))


def _oid(dotted):
    arcs = [int(x) for x in dotted.split(".")]
    out = bytearray([40 * arcs[0] + arcs[1]])
    for arc in arcs[2:]:
        chunk = [arc & 0x7F]
        arc >>= 7
        while arc:
            chunk.append(0x80 | (arc & 0x7F))
            arc >>= 7
        out += bytes(reversed(chunk))
    return _tlv(0x06, bytes(out))


def _time(when):
    # X.509 uses UTCTime through 2049 and GeneralizedTime afterwards.
    if when.year < 2050:
        return _tlv(0x17, when.strftime("%y%m%d%H%M%SZ").encode())
    return _tlv(0x18, when.strftime("%Y%m%d%H%M%SZ").encode())


def _extension(oid, value, critical=False):
    parts = [_oid(oid)]
    if critical:
        parts.append(b"\x01\x01\xff")
    parts.append(_tlv(0x04, value))
    return _seq(*parts)


def _pem(label, der):
    body = base64.encodebytes(der).decode().replace("\n", "")
    lines = [body[i:i + 64] for i in range(0, len(body), 64)]
    return "-----BEGIN %s-----\n%s\n-----END %s-----\n" % (label, "\n".join(lines), label)


def generate(common_name, dns_names=(), ip_addresses=(), days=820):
    """Return (certificate_pem, private_key_pem, expiry_unix_time)."""
    p, q = _prime(1024), _prime(1024)
    while p == q:
        q = _prime(1024)
    n = p * q
    lam = (p - 1) * (q - 1)
    d = pow(_E, -1, lam)

    algorithm = _seq(_oid(_SHA256_WITH_RSA), b"\x05\x00")
    name = _seq(_tlv(0x31, _seq(_oid("2.5.4.3"), _tlv(0x0C, common_name.encode("utf-8")))))
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    not_before = now - dt.timedelta(days=1)
    not_after = now + dt.timedelta(days=days)

    public_key = _seq(
        _seq(_oid(_RSA_ENCRYPTION), b"\x05\x00"),
        _tlv(0x03, b"\x00" + _seq(_int(n), _int(_E))),
    )

    alt_names = []
    for host in dns_names:
        try:
            alt_names.append(_tlv(0x82, host.encode("ascii")))
        except UnicodeEncodeError:
            continue
    for ip in ip_addresses:
        alt_names.append(_tlv(0x87, ipaddress.ip_address(ip).packed))

    extensions = _seq(
        _extension("2.5.29.19", _seq(), critical=True),                    # basicConstraints: not a CA
        _extension("2.5.29.15", b"\x03\x02\x05\xa0", critical=True),       # keyUsage: signature + key encipherment
        _extension("2.5.29.37", _seq(_oid("1.3.6.1.5.5.7.3.1"))),          # extKeyUsage: serverAuth
        _extension("2.5.29.17", _seq(*alt_names)),                         # subjectAltName
    )

    tbs = _seq(
        _tlv(0xA0, _int(2)),                       # version 3
        _int(secrets.randbits(120) | (1 << 119)),  # serial
        algorithm,
        name,                                      # issuer (self)
        _seq(_time(not_before), _time(not_after)),
        name,                                      # subject
        public_key,
        _tlv(0xA3, extensions),
    )

    k = (n.bit_length() + 7) // 8
    digest = hashlib.sha256(tbs).digest()
    padded = b"\x00\x01" + b"\xff" * (k - len(_SHA256_PREFIX) - len(digest) - 3) + b"\x00" + _SHA256_PREFIX + digest
    signature = pow(int.from_bytes(padded, "big"), d, n).to_bytes(k, "big")

    certificate = _seq(tbs, algorithm, _tlv(0x03, b"\x00" + signature))
    private_key = _seq(
        _int(0), _int(n), _int(_E), _int(d), _int(p), _int(q),
        _int(d % (p - 1)), _int(d % (q - 1)), _int(pow(q, -1, p)),
    )
    return _pem("CERTIFICATE", certificate), _pem("RSA PRIVATE KEY", private_key), int(not_after.timestamp())
