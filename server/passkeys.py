"""Passkeys (WebAuthn) in plain Python: checking what a browser or phone sends when someone adds a passkey to their
account (registration) and when they sign in with one (assertion). Only what the server needs: the small CBOR
subset passkeys use, ES256 (P-256, every phone and browser) and RS256 (Windows Hello) keys, and the checks the
WebAuthn standard asks for. Attestation (proof of which device made the key) is not asked for, so not checked.

A passkey belongs to a "relying party" domain (rp_id): the server's passkey domain, such as vlcno.xyz, so the same
passkey works on umbryx.vlcno.xyz, us.vlcno.xyz and in the iPhone app."""
import base64
import hashlib
import json

import p256

ES256, RS256 = -7, -257
FLAG_UP, FLAG_UV, FLAG_AT = 0x01, 0x04, 0x40


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def unb64url(text):
    text = str(text or "")
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def cbor(data, pos=0):
    """One CBOR item from data at pos: (value, position after it). Definite lengths only, as passkeys send."""
    first = data[pos]
    major, info, pos = first >> 5, first & 0x1F, pos + 1
    if info < 24:
        arg = info
    elif info <= 27:
        size = 1 << (info - 24)
        arg, pos = int.from_bytes(data[pos:pos + size], "big"), pos + size
    else:
        raise ValueError("CBOR: indefinite lengths are not used by passkeys")
    if major == 0:
        return arg, pos
    if major == 1:
        return -1 - arg, pos
    if major in (2, 3):
        chunk = bytes(data[pos:pos + arg])
        if len(chunk) != arg:
            raise ValueError("CBOR: cut short")
        return (chunk if major == 2 else chunk.decode("utf-8")), pos + arg
    if major == 4:
        items = []
        for _ in range(arg):
            item, pos = cbor(data, pos)
            items.append(item)
        return items, pos
    if major == 5:
        out = {}
        for _ in range(arg):
            key, pos = cbor(data, pos)
            out[key], pos = cbor(data, pos)
        return out, pos
    if major == 6:
        return cbor(data, pos)     # a tag: its value
    if info in (20, 21, 22):
        return {20: False, 21: True, 22: None}[info], pos
    raise ValueError("CBOR: unexpected item")


def auth_data(data):
    """The authenticator data: which domain it is for (its SHA-256), the flags, the signature counter, and (when a
    passkey is made) the new credential's id and public key."""
    if len(data) < 37:
        raise ValueError("authenticator data too short")
    out = {"rp_hash": data[:32], "flags": data[32], "count": int.from_bytes(data[33:37], "big")}
    if out["flags"] & FLAG_AT:
        length = int.from_bytes(data[53:55], "big")
        out["cred_id"] = bytes(data[55:55 + length])
        key, end = cbor(data, 55 + length)
        out["cose"] = bytes(data[55 + length:end])
        out["key"] = key
    return out


def cose_key(key):
    """(alg, public key) from a COSE key: ES256 → (x, y) on P-256; RS256 → (n, e)."""
    if not isinstance(key, dict):
        raise ValueError("bad public key")
    if key.get(1) == 2 and key.get(3) == ES256 and key.get(-1) == 1:
        x, y = key.get(-2), key.get(-3)
        if not (isinstance(x, bytes) and isinstance(y, bytes) and len(x) == len(y) == 32):
            raise ValueError("bad P-256 key")
        point = (int.from_bytes(x, "big"), int.from_bytes(y, "big"))
        if not p256.on_curve(point):
            raise ValueError("P-256 key not on the curve")
        return ES256, point
    if key.get(1) == 3 and key.get(3) == RS256:
        n, e = key.get(-1), key.get(-2)
        if not (isinstance(n, bytes) and isinstance(e, bytes)):
            raise ValueError("bad RSA key")
        return RS256, (int.from_bytes(n, "big"), int.from_bytes(e, "big"))
    raise ValueError("this kind of passkey is not supported (only ES256 and RS256)")


def _client_data(raw, kind, challenge, origin_ok):
    try:
        client = json.loads(raw)
    except ValueError:
        raise ValueError("bad client data")
    if client.get("type") != kind:
        raise ValueError("wrong kind of passkey request")
    if not isinstance(client.get("challenge"), str) or client["challenge"] != challenge:
        raise ValueError("this passkey request has expired: try again")
    if not origin_ok(str(client.get("origin") or "")):
        raise ValueError("this passkey request came from somewhere else")
    if client.get("crossOrigin") is True:
        raise ValueError("passkeys from inside another site are not accepted")
    return client


def challenge_of(client_data_json):
    """The challenge a browser signed (to find which request it answers)."""
    try:
        value = json.loads(client_data_json).get("challenge")
    except (ValueError, AttributeError):
        return ""
    return value if isinstance(value, str) else ""


def verify_registration(client_data_json, attestation_object, challenge, rp_id, origin_ok, require_uv=False):
    """A new passkey (navigator.credentials.create): checks it answers this challenge, from an allowed page, for this
    domain, with the person present; returns what to keep: {"id", "key" (COSE, base64url), "alg", "count"}."""
    _client_data(client_data_json, "webauthn.create", challenge, origin_ok)
    attestation, _ = cbor(attestation_object)
    if not isinstance(attestation, dict) or not isinstance(attestation.get("authData"), bytes):
        raise ValueError("bad attestation")
    data = auth_data(attestation["authData"])
    if data["rp_hash"] != hashlib.sha256(rp_id.encode("utf-8")).digest():
        raise ValueError("this passkey was made for another site")
    if not data["flags"] & FLAG_UP or (require_uv and not data["flags"] & FLAG_UV):
        raise ValueError("the passkey was not confirmed on the device")
    if "cred_id" not in data or not 1 <= len(data["cred_id"]) <= 1023:
        raise ValueError("the passkey has no id")
    alg, _ = cose_key(data["key"])
    return {"id": b64url(data["cred_id"]), "key": b64url(data["cose"]), "alg": alg, "count": data["count"]}


def verify_assertion(stored, client_data_json, authenticator_data, signature, challenge, rp_id, origin_ok, require_uv=False):
    """A sign-in with a passkey (navigator.credentials.get) against a kept one (verify_registration's result):
    checks the challenge, page, domain, presence and signature; returns the new signature counter. A counter that
    goes backwards means a copied key and is refused (passkeys that sync, as Apple's and Google's, always send 0)."""
    _client_data(client_data_json, "webauthn.get", challenge, origin_ok)
    data = auth_data(authenticator_data)
    if data["rp_hash"] != hashlib.sha256(rp_id.encode("utf-8")).digest():
        raise ValueError("this passkey is for another site")
    if not data["flags"] & FLAG_UP or (require_uv and not data["flags"] & FLAG_UV):
        raise ValueError("the passkey was not confirmed on the device")
    alg, key = cose_key(cbor(unb64url(stored["key"]))[0])
    digest = hashlib.sha256(bytes(authenticator_data) + hashlib.sha256(client_data_json).digest()).digest()
    if alg == ES256:
        r, s = p256.der_signature(bytes(signature))
        good = p256.verify(key, digest, r, s)
    else:
        good = p256.rsa_verify(key[0], key[1], digest, bytes(signature))
    if not good:
        raise ValueError("the passkey's signature is not right")
    count, kept = data["count"], int(stored.get("count") or 0)
    if (count or kept) and count <= kept:
        raise ValueError("this passkey looks copied: sign in another way and remove it")
    return count
