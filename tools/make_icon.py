"""Makes the app icons from desktop/icon.svg: desktop/icon.ico for Windows (Umbryx.exe and the taskbar) and
desktop/icon.icns for the Mac (the Dock and Finder).

The SVG is drawn once at 1024 pixels by Microsoft Edge, which is on every Windows PC, and then scaled down
to each size the system asks for. Mac icons leave a margin round the artwork (it fills 824 of 1024 pixels),
so they line up with the other icons in the Dock. Needs the Pillow package for the scaling.

    python tools/make_icon.py
"""
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

EDGE = [r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"]
SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
MAC_ART = 824   # of 1024: Apple's icon grid


def draw(edge, source, work):
    page = Path(work) / "icon.html"
    shot = Path(work) / "icon.png"
    page.write_text('<!doctype html><style>html,body{margin:0;background:transparent}img{display:block}</style>'
                    '<img src="%s" width="1024" height="1024">' % source.as_uri(), "utf-8")
    subprocess.run([edge, "--headless", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
                    "--user-data-dir=" + str(Path(work) / "profile"), "--force-device-scale-factor=1",
                    "--default-background-color=00000000", "--window-size=1024,1024",
                    "--screenshot=" + str(shot), page.as_uri()],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
    art = Image.open(shot).convert("RGBA")
    art.load()
    return art


if __name__ == "__main__":
    project = Path(__file__).resolve().parent.parent
    source = project / "desktop" / "icon.svg"
    edge = next((p for p in EDGE if Path(p).exists()), None)
    if not edge:
        sys.exit("Microsoft Edge was not found, so the icon could not be drawn.")
    with tempfile.TemporaryDirectory() as work:
        art = draw(edge, source, work)

    windows = project / "desktop" / "icon.ico"
    art.save(windows, format="ICO", sizes=[(s, s) for s in SIZES])
    print("wrote %s (%d sizes); corner alpha %d" % (windows.name, len(SIZES), art.getpixel((2, 2))[3]))

    mac = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    margin = (1024 - MAC_ART) // 2
    mac.paste(art.resize((MAC_ART, MAC_ART), Image.LANCZOS), (margin, margin))
    target = project / "desktop" / "icon.icns"
    mac.save(target, format="ICNS")
    print("wrote %s; artwork %d px of 1024, corner alpha %d" % (target.name, MAC_ART, mac.getpixel((2, 2))[3]))
