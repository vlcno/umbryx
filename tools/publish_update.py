"""Offers a new version of the desktop app to everyone, through the Umbryx server.

The apps check their servers every few hours. When one finds a newer version it downloads it in the
background, checks it, and shows a green button in the column of servers that restarts Umbryx on the new
version. This tool puts a version on the server for them to find:

  1. Raise "version" in desktop/package.json and build the Windows app as usual (desktop/build.bat).
  2. python tools/publish_update.py --notes "What changed"

What is sent is the app's own code (resources/app.asar from the build, the same file for Windows and Mac),
a few hundred KB. When the build uses a different Electron version from the one already out, the apps
need the whole app instead, so give the two download zips as well:

     python tools/publish_update.py --windows downloads/Umbryx-Windows.zip --mac downloads/Umbryx-Mac.zip

Every version is described by a small file (its number, and the size and fingerprint of each package)
signed with the update key, which never leaves this computer. The server only stores, and the apps only
install, what that key signed, so nobody else can push an update to them, not even someone who takes over
the server. Keep a copy of the key somewhere safe: without it no further updates can be published, and
anyone who has it can publish them.

    --server URL   where to publish (default: the address in server-address.txt, port 3443)
    --key FILE     the private key (default: %USERPROFILE%\\umbryx-build\\update-signing-key.pem)
    --app FILE     the app's code (default: the last Windows build's resources\\app.asar)
    --notes TEXT   a line about what changed (shown when someone asks the app to check for updates)
    --dry-run      check everything and print the description, but send nothing
    --force        publish even though the Electron version changed and no zips were given
"""
import argparse
import base64
import hashlib
import http.client
import json
import os
import re
import ssl
import struct
import sys
import time
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

PROJECT = Path(__file__).resolve().parent.parent
BUILD = Path(os.environ.get("USERPROFILE", str(Path.home()))) / "umbryx-build"
DIST = BUILD / "dist" / "Umbryx-win32-x64"
FULL = {"win32-x64": ("windows", "Umbryx/Umbryx.exe", "Umbryx/resources/app.asar"),
        "darwin-arm64": ("mac", "Umbryx.app/Contents/MacOS/Umbryx", "Umbryx.app/Contents/Resources/app.asar")}

# ---------- Ed25519 signing (RFC 8032; Python's standard library has none) ----------

P = 2 ** 255 - 19
Q = 2 ** 252 + 27742317777372353535851937790883648493
D = -121665 * pow(121666, P - 2, P) % P


def _add(a, b):
    x = (a[1] - a[0]) * (b[1] - b[0]) % P
    y = (a[1] + a[0]) * (b[1] + b[0]) % P
    c = 2 * a[3] * b[3] * D % P
    d = 2 * a[2] * b[2] % P
    e, f, g, h = y - x, d - c, d + c, y + x
    return (e * f % P, g * h % P, f * g % P, e * h % P)


def _mul(s, point):
    result = (0, 1, 1, 0)
    while s > 0:
        if s & 1:
            result = _add(result, point)
        point = _add(point, point)
        s >>= 1
    return result


def _compress(point):
    z = pow(point[2], P - 2, P)
    x, y = point[0] * z % P, point[1] * z % P
    return int.to_bytes(y | ((x & 1) << 255), 32, "little")


def _base():
    y = 4 * pow(5, P - 2, P) % P
    x2 = (y * y - 1) * pow(D * y * y + 1, P - 2, P) % P
    x = pow(x2, (P + 3) // 8, P)
    if (x * x - x2) % P:
        x = x * pow(2, (P - 1) // 4, P) % P
    if x & 1:
        x = P - x
    return (x, y, 1, x * y % P)


BASE = _base()


def _hash(data):
    return int.from_bytes(hashlib.sha512(data).digest(), "little")


def public_key(seed):
    a = (int.from_bytes(hashlib.sha512(seed).digest()[:32], "little") & ((1 << 254) - 8)) | (1 << 254)
    return _compress(_mul(a, BASE))


def sign(seed, message):
    h = hashlib.sha512(seed).digest()
    a = (int.from_bytes(h[:32], "little") & ((1 << 254) - 8)) | (1 << 254)
    public = _compress(_mul(a, BASE))
    r = _hash(h[32:] + message) % Q
    big_r = _compress(_mul(r, BASE))
    s = (r + _hash(big_r + public + message) % Q * a) % Q
    return big_r + int.to_bytes(s, 32, "little")


def read_key(path):
    """The 32-byte seed from the PKCS#8 PEM file Node.js wrote."""
    der = base64.b64decode("".join(l for l in Path(path).read_text("ascii").splitlines() if not l.startswith("-----")))
    prefix = bytes.fromhex("302e020100300506032b657004220420")
    if len(der) != 48 or not der.startswith(prefix):
        sys.exit("%s is not an Ed25519 private key." % path)
    return der[len(prefix):]


# ---------- what is being published ----------

def asar_version(data):
    """The version in package.json inside an app.asar (Electron's archive: a JSON index, then the files)."""
    header_size = struct.unpack_from("<I", data, 4)[0]
    length = struct.unpack_from("<I", data, 12)[0]
    index = json.loads(data[16:16 + length])
    entry = index["files"]["package.json"]
    start = 8 + header_size + int(entry["offset"])
    return json.loads(data[start:start + entry["size"]])["version"]


def describe(data, name):
    return {"file": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def describe_file(path, name):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return {"file": name, "size": Path(path).stat().st_size, "sha256": digest.hexdigest()}


def check_zip(path, kind, version):
    exe, asar = FULL[kind][1:]
    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())
        if exe not in names or asar not in names:
            sys.exit("%s does not look like the %s download (no %s)." % (path, FULL[kind][0], exe))
        inside = asar_version(z.read(asar))
    if inside != version:
        sys.exit("%s holds version %s, not %s. Build it again." % (path, inside, version))


# ---------- talking to the server ----------

def server_address(given):
    text = given
    if not text:
        for line in (PROJECT / "server-address.txt").read_text("utf-8").splitlines():
            if line.strip() and not line.strip().startswith("#"):
                text = line.strip()
                break
    if not text:
        sys.exit("Say where to publish: --server https://YOUR-SERVER:3443")
    if not re.match(r"^https?://", text):
        text = "https://" + text
    url = urlsplit(text)
    port = url.port or (3443 if url.scheme == "https" and not re.search(r":\d+$", url.netloc) else 443 if url.scheme == "https" else 80)
    return url.scheme, url.hostname, port


def connection(server):
    scheme, host, port = server
    if scheme == "http":
        return http.client.HTTPConnection(host, port, timeout=60)
    # A home server's certificate is self-made, so it is not checked: nothing secret is sent, and what is
    # sent is signed, so a server pretending to be this one could learn nothing and change nothing.
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    return http.client.HTTPSConnection(host, port, timeout=60, context=context)


def current_version(server):
    conn = connection(server)
    try:
        conn.request("GET", "/updates/latest.json")
        reply = conn.getresponse()
        body = reply.read()
    except OSError as err:
        sys.exit("Could not reach the server at %s:%d (%s)." % (server[1], server[2], err))
    finally:
        conn.close()
    if reply.status == 404:
        return None   # nothing published there yet
    saved = json.loads(body)
    return json.loads(saved["manifest"])


def put(server, name, headers, source=None, size=0):
    conn = connection(server)
    try:
        conn.putrequest("PUT", "/updates/" + name)
        for key, value in dict(headers, **{"Content-Length": str(size)}).items():
            conn.putheader(key, value)
        conn.endheaders()
        sent, shown, started = 0, -1, time.time()
        try:
            if source:
                with open(source, "rb") as f:
                    for chunk in iter(lambda: f.read(1 << 18), b""):
                        conn.send(chunk)
                        sent += len(chunk)
                        percent = sent * 100 // size
                        if percent // 10 != shown // 10 or sent == size:
                            shown = percent
                            print("\r  %-34s %3d%%  %.1f of %.1f MB" % (name, percent, sent / 1048576, size / 1048576), end="", flush=True)
                print("  (%.0f s)" % (time.time() - started))
        except OSError:
            print()   # the server stopped listening: its answer says why
        reply = conn.getresponse()
        body = reply.read()
    finally:
        conn.close()
    if reply.status == 405:
        sys.exit("The server does not take updates yet. Update the server first.")
    if reply.status != 200:
        try:
            problem = json.loads(body)["error"]
        except (ValueError, KeyError, TypeError):
            problem = body.decode("utf-8", "replace")[:200]
        sys.exit("The server refused %s: %s" % (name, problem))
    return json.loads(body)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--server")
    parser.add_argument("--key", default=str(BUILD / "update-signing-key.pem"))
    parser.add_argument("--app", default=str(DIST / "resources" / "app.asar"))
    parser.add_argument("--windows")
    parser.add_argument("--mac")
    parser.add_argument("--notes", default="")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    seed = read_key(args.key)
    public = base64.b64encode(public_key(seed)).decode("ascii")
    for place in (PROJECT / "desktop" / "main.js", PROJECT / "server" / "server.py"):
        if public not in place.read_text("utf-8"):
            sys.exit("%s does not hold this key's public half (%s), so it would refuse the update." % (place.name, public))

    # The version is the one inside the built app, which is what the apps will report once updated.
    asar = Path(args.app).read_bytes()
    version = asar_version(asar)
    source_version = json.loads((PROJECT / "desktop" / "package.json").read_text("utf-8"))["version"]
    if version != source_version and Path(args.app) == DIST / "resources" / "app.asar":
        sys.exit("The last build is version %s, but desktop/package.json says %s. Build the app again first." % (version, source_version))
    electron = (Path(args.app).parent.parent / "version").read_text("ascii").strip().lstrip("v")

    server = server_address(args.server)
    print("Publishing version %s (Electron %s) to %s:%d" % (version, electron, server[1], server[2]))
    current = current_version(server)
    if current:
        print("  on offer there now: %s (Electron %s)" % (current["version"], current.get("electron", "?")))
        if tuple(map(int, current["version"].split("."))) >= tuple(map(int, version.split("."))):
            sys.exit("Raise the version in desktop/package.json above %s, then build again." % current["version"])

    packages = {"app": describe(asar, "umbryx-%s-app.asar" % version)}
    files = {packages["app"]["file"]: args.app}
    for kind, given in (("win32-x64", args.windows), ("darwin-arm64", args.mac)):
        if given:
            check_zip(given, kind, version)
            packages[kind] = describe_file(given, "umbryx-%s-%s.zip" % (version, FULL[kind][0]))
            files[packages[kind]["file"]] = given
        elif current and current.get("electron") == electron and kind in current["packages"]:
            packages[kind] = current["packages"][kind]   # still right for anyone on an older Electron; already there
    if current and current.get("electron") != electron and len(packages) < 3 and not args.force:
        sys.exit("The Electron version changed (%s to %s), so apps need the whole app: give --windows and --mac too."
                 % (current.get("electron"), electron))

    manifest = json.dumps({
        "product": "umbryx-desktop",
        "version": version,
        "electron": electron,
        "published": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "notes": args.notes,
        "packages": packages,
    }, indent=1).encode("utf-8")
    signature = sign(seed, manifest)
    headers = {"X-Update-Manifest": base64.b64encode(manifest).decode("ascii"),
               "X-Update-Signature": base64.b64encode(signature).decode("ascii")}
    print(manifest.decode("utf-8"))
    if args.dry_run:
        print("Dry run: nothing was sent.")
        return

    for name, source in files.items():
        put(server, name, headers, source, Path(source).stat().st_size)
    put(server, "latest.json", headers)
    print("Version %s is on offer. Open apps (1.4.3 on) get it within seconds and show the green arrow; older ones"
          " within an hour, or straight away from the app menu: Check for updates." % version)


if __name__ == "__main__":
    main()
