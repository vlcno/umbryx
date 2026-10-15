"""Builds the Mac app (Umbryx.app, zipped) from Electron's macOS release and the Windows build, on Windows.

The usual packaging tool cannot make a Mac app on Windows: a Mac app contains links between its folders,
which Windows does not create on disk. This works zip to zip instead, so the links stay links:

  - Electron.app becomes Umbryx.app: its name, bundle id, version, icon, and why it wants the
    microphone and camera are set in Info.plist
  - its program, Contents/MacOS/Electron, becomes Contents/MacOS/Umbryx. That matters beyond the name:
    Electron takes a program called "Electron" for a development copy (app.isPackaged is false), and a
    development copy does not update itself
  - Electron's sample app is left out, and the app's code goes in as Contents/Resources/app.asar: the very
    file the Windows build made (resources/app.asar), so an update to the app's code is one file for both
  - server-address.txt goes in Contents/Resources, where the app looks for it on a Mac

The result is not signed by Apple. On the Mac it gets a local signature with `codesign --sign -`
(see the README); the app then opens like any other.

    python tools/make_mac_app.py electron-v44.7.0-darwin-arm64.zip downloads/Umbryx-Mac.zip

Build the Windows app first (desktop/build.bat): its app.asar is taken from umbryx-build/dist in your user folder.

Electron's macOS zips are on https://github.com/electron/electron/releases (use the version the Windows
app is built with, from desktop/package.json, and check it against that release's SHASUMS256.txt).
"""
import json
import os
import plistlib
import stat
import struct
import sys
import zipfile
from pathlib import Path

SKIP = {"Electron.app/Contents/Resources/default_app.asar", "version"}
WINDOWS_ASAR = Path(os.environ.get("USERPROFILE", str(Path.home()))) / "umbryx-build" / "dist" / "Umbryx-win32-x64" / "resources" / "app.asar"


def asar_version(data):
    """The version in package.json inside an app.asar (Electron's archive: a JSON index, then the files)."""
    header_size = struct.unpack_from("<I", data, 4)[0]
    length = struct.unpack_from("<I", data, 12)[0]
    entry = json.loads(data[16:16 + length])["files"]["package.json"]
    start = 8 + header_size + int(entry["offset"])
    return json.loads(data[start:start + entry["size"]])["version"]


def main(electron_zip, target):
    project = Path(__file__).resolve().parent.parent
    desktop = project / "desktop"
    package = json.loads((desktop / "package.json").read_text("utf-8"))
    version = package["version"]
    asar = WINDOWS_ASAR.read_bytes()
    if asar_version(asar) != version:
        sys.exit("The Windows build holds version %s, not %s. Run desktop/build.bat first." % (asar_version(asar), version))

    with zipfile.ZipFile(electron_zip) as source, zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as out:
        for info in source.infolist():
            if info.filename in SKIP:
                continue
            name = info.filename.replace("Electron.app/", "Umbryx.app/", 1)
            if info.filename == "Electron.app/Contents/MacOS/Electron":
                name = "Umbryx.app/Contents/MacOS/Umbryx"
            data = source.read(info)
            if info.filename == "Electron.app/Contents/Info.plist":
                plist = plistlib.loads(data)
                plist.update({
                    "CFBundleExecutable": "Umbryx",
                    "CFBundleName": "Umbryx",
                    "CFBundleDisplayName": "Umbryx",
                    "CFBundleIdentifier": "com.umbryx.app",
                    "CFBundleShortVersionString": version,
                    "CFBundleVersion": version,
                    "LSApplicationCategoryType": "public.app-category.social-networking",
                    "NSMicrophoneUsageDescription": "Umbryx uses the microphone for voice channels and calls.",
                    "NSCameraUsageDescription": "Umbryx uses the camera when you turn it on in a voice channel or call.",
                })
                plist.pop("ElectronAsarIntegrity", None)   # it described the sample app, which is not included
                data = plistlib.dumps(plist)
            elif info.filename == "Electron.app/Contents/Resources/electron.icns":
                data = (desktop / "icon.icns").read_bytes()
            copy = zipfile.ZipInfo(name, date_time=info.date_time)
            copy.external_attr = info.external_attr       # Unix permissions, and whether the entry is a link
            copy.create_system = 3
            copy.compress_type = zipfile.ZIP_STORED if info.filename.endswith("/") else zipfile.ZIP_DEFLATED
            out.writestr(copy, data)

        resources = "Umbryx.app/Contents/Resources/"

        def add(name, data):
            entry = zipfile.ZipInfo(resources + name, date_time=(2026, 1, 1, 0, 0, 0))
            entry.external_attr = (stat.S_IFREG | 0o644) << 16
            entry.create_system = 3
            entry.compress_type = zipfile.ZIP_DEFLATED
            out.writestr(entry, data)

        add("app.asar", asar)
        address = project / "server-address.txt"
        if address.exists():
            add("server-address.txt", address.read_bytes())

    with zipfile.ZipFile(target) as check:
        infos = check.infolist()
        links = sum(stat.S_ISLNK(i.external_attr >> 16) for i in infos)
        plist = plistlib.loads(check.read("Umbryx.app/Contents/Info.plist"))
        assert check.testzip() is None
        assert not any(i.filename.startswith("Electron.app/") for i in infos)
        assert asar_version(check.read("Umbryx.app/Contents/Resources/app.asar")) == version
        program = check.getinfo("Umbryx.app/Contents/MacOS/" + plist["CFBundleExecutable"])
        assert plist["CFBundleExecutable"] == "Umbryx" and program.external_attr >> 16 & 0o111   # still runnable
    print("%s: %d entries, %d links kept, %.1f MB; %s %s (%s)" % (Path(target).name, len(infos), links,
          Path(target).stat().st_size / 1048576, plist["CFBundleName"], plist["CFBundleShortVersionString"], plist["CFBundleIdentifier"]))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
