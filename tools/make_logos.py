"""Writes the logo options into downloads/logos as SVG files, plus sheet.html that shows them side by side.

Fourth round, on the user's idea: an eclipse combined with the stone onyx. Mostly white on black.
Every option is drawn on the same 512 x 512 rounded black tile the app icon uses, so any of them can
replace server/public/icon.svg and desktop/icon.svg directly.
"""
import math
import sys
from pathlib import Path

WHITE = "#ffffff"
BLACK = "#000000"
C = 256   # centre of the tile

TILE = '<rect width="512" height="512" rx="118" fill="%s"/>' % BLACK
CLIP = '<clipPath id="tile"><rect width="512" height="512" rx="118"/></clipPath>'


def svg(body, defs=""):
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">'
            + ("<defs>%s</defs>" % defs if defs else "") + TILE + body + "</svg>\n")


def octagon(cx, cy, r, turn=22.5):
    """Corner points of an eight-sided cut. turn=22.5 gives a flat top, turn=0 a pointed one."""
    return [(cx + r * math.cos(math.radians(turn + 45 * k)), cy + r * math.sin(math.radians(turn + 45 * k))) for k in range(8)]


def points(pts):
    return " ".join("%.1f,%.1f" % p for p in pts)


def polygon(pts, fill, extra=""):
    return '<polygon points="%s" fill="%s"%s/>' % (points(pts), fill, extra)


def facets(outer, inner, fills, gap=10):
    """The ring of eight sloping faces between the edge of a cut stone and its flat top."""
    out = ""
    for k in range(8):
        j = (k + 1) % 8
        out += polygon([outer[k], outer[j], inner[j], inner[k]], fills[k],
                       ' stroke="%s" stroke-width="%d" stroke-linejoin="round"' % (BLACK, gap))
    return out


def onyx_ring():
    """An eclipse ring with a cut stone where its bright bead would be: the 'diamond ring' of an eclipse."""
    ring = '<circle cx="244" cy="268" r="150" fill="none" stroke="%s" stroke-width="28"/>' % WHITE
    sx, sy = 244 + 150 * math.cos(math.radians(-45)), 268 + 150 * math.sin(math.radians(-45))
    seat = polygon(octagon(sx, sy, 84), BLACK)
    stone = facets(octagon(sx, sy, 68), octagon(sx, sy, 34), [WHITE] * 8, 6) + polygon(octagon(sx, sy, 34), WHITE,
        ' stroke="%s" stroke-width="6" stroke-linejoin="round"' % BLACK)
    return svg(ring + seat + stone)


def cut_crescent():
    """The current ring and bead, re-cut with the flat edges of a gemstone."""
    sun = polygon(octagon(C, C, 196), WHITE, ' stroke="%s" stroke-width="8" stroke-linejoin="round"' % WHITE)
    moon = polygon(octagon(C + 30, C - 30, 128), BLACK)
    bx, by = C + 181 * math.cos(math.radians(-45)), C + 181 * math.sin(math.radians(-45))
    bead = polygon(octagon(bx, by, 40), BLACK) + polygon(octagon(bx, by, 28), WHITE)
    return svg(sun + moon + bead)


def lit_facets():
    """A cut onyx whose lit faces form the crescent of an eclipse."""
    # faces listed clockwise starting from the right-hand one
    light = [.10, .10, .26, .70, 1, 1, .70, .26]
    fills = ["rgb(%d,%d,%d)" % ((round(18 + (255 - 18) * v),) * 3) for v in light]
    return svg(facets(octagon(C, C, 204), octagon(C, C, 112), fills) + polygon(octagon(C, C, 112), "#060607",
        ' stroke="%s" stroke-width="10" stroke-linejoin="round"' % BLACK))


def stone_and_corona(glow="#ffffff", core="#ffffff", rim="#ffffff"):
    """A black cut stone passing in front of the sun."""
    defs = (CLIP +
            '<radialGradient id="glow" cx="50%%" cy="50%%" r="50%%">'
            '<stop offset=".50" stop-color="%s"/><stop offset=".60" stop-color="%s" stop-opacity=".8"/>'
            '<stop offset=".76" stop-color="%s" stop-opacity=".28"/><stop offset="1" stop-color="%s" stop-opacity="0"/></radialGradient>'
            '<radialGradient id="flare" cx="50%%" cy="50%%" r="50%%">'
            '<stop offset="0" stop-color="#ffffff"/><stop offset=".3" stop-color="%s" stop-opacity=".9"/>'
            '<stop offset="1" stop-color="%s" stop-opacity="0"/></radialGradient>' % (core, glow, glow, glow, core, glow))
    outer, inner = octagon(C, C, 134, 0), octagon(C, C, 70, 0)
    dark = ["#141417", "#1d1d21", "#111113", "#0b0b0d", "#08080a", "#0b0b0d", "#17171a", "#222227"]
    stone = facets(outer, inner, dark, 4) + polygon(inner, "#050506", ' stroke="%s" stroke-width="4" stroke-linejoin="round"' % BLACK)
    edge = polygon(outer, "none", ' stroke="%s" stroke-width="5" stroke-linejoin="round"' % rim)
    bx, by = outer[7]
    return svg('<g clip-path="url(#tile)"><circle cx="256" cy="256" r="244" fill="url(#glow)"/>%s%s'
               '<circle cx="%.1f" cy="%.1f" r="60" fill="url(#flare)"/><circle cx="%.1f" cy="%.1f" r="12" fill="#fff"/></g>'
               % (stone, edge, bx, by, bx, by), defs)


def eclipse_table():
    """A white cut stone. Its flat top holds the eclipse."""
    stone = facets(octagon(C, C, 204), octagon(C, C, 118), [WHITE] * 8, 9)
    ring = '<circle cx="256" cy="256" r="58" fill="none" stroke="%s" stroke-width="15"/>' % WHITE
    bx, by = C + 58 * math.cos(math.radians(-45)), C + 58 * math.sin(math.radians(-45))
    bead = '<circle cx="%.1f" cy="%.1f" r="22" fill="%s"/><circle cx="%.1f" cy="%.1f" r="15" fill="%s"/>' % (bx, by, BLACK, bx, by, WHITE)
    return svg(stone + ring + bead)


def rays():
    """A black stone with the sun's rays spilling round every edge."""
    burst = ""
    for k in range(16):
        a = math.radians(22.5 * k)
        r0, r1 = 162, (232 if k % 2 == 0 else 200)
        burst += '<path d="M%.1f %.1fL%.1f %.1f"/>' % (C + r0 * math.cos(a), C + r0 * math.sin(a), C + r1 * math.cos(a), C + r1 * math.sin(a))
    outer, inner = octagon(C, C, 132), octagon(C, C, 66)
    lines = "".join('<path d="M%.1f %.1fL%.1f %.1f"/>' % (outer[k] + inner[k]) for k in range(8))
    return svg('<g fill="none" stroke="%s" stroke-width="16" stroke-linecap="round">%s</g>' % (WHITE, burst)
               + polygon(outer, "#050506", ' stroke="%s" stroke-width="12" stroke-linejoin="round"' % WHITE)
               + '<g fill="none" stroke="#3a3a40" stroke-width="5" stroke-linecap="round">%s</g>' % lines
               + polygon(inner, "none", ' stroke="#3a3a40" stroke-width="5" stroke-linejoin="round"'))


def polished():
    """A round polished onyx: the rim is the eclipse, the shine on it is the crescent."""
    defs = '<mask id="shine"><rect width="512" height="512" fill="#000"/><circle cx="256" cy="256" r="132" fill="#fff"/><circle cx="286" cy="226" r="132" fill="#000"/></mask>'
    return svg('<circle cx="256" cy="256" r="178" fill="none" stroke="%s" stroke-width="22"/>'
               '<rect width="512" height="512" fill="%s" mask="url(#shine)"/>' % (WHITE, WHITE), defs)


OPTIONS = [
    ("onyx-ring", "Onyx ring", "the eclipse ring, with a cut stone as its bright bead", onyx_ring),
    ("cut-crescent", "Cut crescent", "the current logo, re-cut with gemstone edges", cut_crescent),
    ("lit-facets", "Lit facets", "a cut onyx whose lit faces form the crescent", lit_facets),
    ("corona", "Stone and corona", "a black cut stone passing in front of the sun", stone_and_corona),
    ("table", "Eclipse inside", "a white cut stone holding the eclipse in its top", eclipse_table),
    ("rays", "Rays", "light spilling round every edge of the stone", rays),
    ("polished", "Polished", "a round polished onyx; its shine is the crescent", polished),
    ("corona-warm", "Stone and corona, warm", "number 28 with the amber glow the app has now",
     lambda: stone_and_corona("#f2b24a", "#ffe9c2", "#ffe2ae")),
]
FIRST = 25   # the earlier rounds used numbers 1 to 24

SHEET = """<!doctype html>
<meta charset="utf-8">
<title>Umbryx logo options</title>
<style>
  body { margin: 0; padding: 34px 40px 30px; background: #000; color: #eceef2; font: 16px "Segoe UI", system-ui, sans-serif; }
  h1 { margin: 0 0 4px; font: 400 30px Corbel, "Segoe UI", sans-serif; letter-spacing: .4em; text-transform: uppercase; }
  p { margin: 0 0 26px; color: #9aa0ad; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; }
  .cell { display: grid; grid-template-columns: 190px 1fr; gap: 20px; align-items: center; padding: 18px; border: 1px solid #26262c; border-radius: 16px; background: #121215; }
  .cell img.big { width: 190px; height: 190px; display: block; }
  .n { font-size: 34px; font-weight: 700; color: #fff; line-height: 1; }
  .name { margin: 4px 0 2px; font-size: 17px; }
  .why { margin: 0 0 14px; color: #9aa0ad; font-size: 13px; line-height: 1.3; }
  .small { display: flex; align-items: center; gap: 12px; }
  .small img { display: block; }
  .word { margin-top: 14px; display: flex; align-items: center; gap: 10px; font: 400 15px Corbel, "Segoe UI", sans-serif; letter-spacing: .4em; text-transform: uppercase; }
</style>
<h1>Umbryx</h1>
<p>Logo options, fourth round: an eclipse combined with a cut onyx. Each is shown large, at taskbar sizes, and next to the name.</p>
<div class="grid">
%s
</div>
"""

CELL = """  <div class="cell">
    <img class="big" src="%(file)s" alt="">
    <div>
      <div class="n">%(n)s</div>
      <div class="name">%(name)s</div>
      <div class="why">%(why)s</div>
      <div class="small"><img src="%(file)s" width="64" height="64" alt=""><img src="%(file)s" width="40" height="40" alt=""><img src="%(file)s" width="24" height="24" alt=""><img src="%(file)s" width="16" height="16" alt=""></div>
      <div class="word"><img src="%(file)s" width="26" height="26" alt="">Umbryx</div>
    </div>
  </div>"""

if __name__ == "__main__":
    project = Path(__file__).resolve().parent.parent
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else project / "downloads" / "logos"
    out.mkdir(parents=True, exist_ok=True)
    current = (project / "server" / "public" / "icon.svg").read_text("utf-8")
    (out / "logo-current.svg").write_text(current, "utf-8")
    cells = []
    for n, (slug, name, why, draw) in enumerate(OPTIONS, FIRST):
        file = "logo-%d-%s.svg" % (n, slug)
        (out / file).write_text(draw(), "utf-8")
        cells.append(CELL % {"file": file, "n": n, "name": name, "why": why})
    cells.append(CELL % {"file": "logo-current.svg", "n": "Now", "name": "The current logo", "why": "for comparison"})
    (out / "sheet.html").write_text(SHEET % "\n".join(cells), "utf-8")
    print("wrote %d logos and sheet.html to %s" % (len(OPTIONS), out))
