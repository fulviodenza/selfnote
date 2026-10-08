"""Rasterise apps/ereader/assets/icon-refined.svg.

Only the primitives that file actually uses: absolute M/L/Q/Z paths, rounded
rects, and a horizontal mirror. Rendering it directly keeps the output exactly
1024x1024 with no browser DPI scaling to second-guess.
"""
import math, os, re, sys
sys.path.insert(0, os.path.dirname(__file__))
from _canvas import Canvas, rrect   # scanline filler; no rasteriser on macOS by default

SVG = os.path.join(os.path.dirname(__file__), "icon-refined.svg")
W = 1024

def hexc(h):
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))

def flatten(d, steps=24):
    """Path -> polygon. Absolute M/L/Q/Z only, which is all this file uses."""
    toks = re.findall(r"[MLQZz]|-?\d+\.?\d*", d)
    pts, i, cur = [], 0, (0.0, 0.0)
    while i < len(toks):
        t = toks[i]
        if t == "M":
            cur = (float(toks[i+1]), float(toks[i+2])); pts.append(cur); i += 3
        elif t == "L":
            cur = (float(toks[i+1]), float(toks[i+2])); pts.append(cur); i += 3
        elif t == "Q":
            cx, cy, x, y = map(float, toks[i+1:i+5])
            x0, y0 = cur
            for s in range(1, steps + 1):
                u = s / steps; v = 1 - u
                pts.append((v*v*x0 + 2*v*u*cx + u*u*x, v*v*y0 + 2*v*u*cy + u*u*y))
            cur = (x, y); i += 5
        else:
            i += 1
    return pts

def mirror(poly):
    return [(1024.0 - x, y) for (x, y) in poly]

def shift(poly, dx, dy):
    return [(x + dx, y + dy) for (x, y) in poly]

src = open(SVG).read()
paths = dict(re.findall(r'<path id="(\w+)" d="([^"]+)"', src))
cover, page = flatten(paths["cover"]), flatten(paths["page"])

C = {k: hexc(v) for k, v in {
    "bg": "#F7EFE4", "cover": "#C4552F", "page": "#FFFBF4",
    "shadow": "#EADBC6", "spine": "#E5A27A", "text": "#2A4365", "hl": "#F2C14E",
}.items()}

c = Canvas(W, C["bg"])

# shadow, both halves plus the gutter block, offset down 22
c.fill([shift(cover, 0, 22)], C["shadow"])
c.fill([shift(mirror(cover), 0, 22)], C["shadow"])
c.fill([rrect(496, 322, 32, 520, 0)], C["shadow"])

for poly in (cover, mirror(cover)):
    c.fill([poly], C["cover"])
for poly in (page, mirror(page)):
    c.fill([poly], C["page"])

c.fill([rrect(500, 306, 24, 514, 12)], C["spine"])

for y, w in ((384, 252), (456, 216), (528, 252), (600, 150)):
    c.fill([rrect(200, y, w, 24, 12)], C["text"])

c.fill([rrect(556, 442, 292, 52, 26)], C["hl"])
for y, w in ((384, 252), (456, 260), (528, 230), (600, 170)):
    c.fill([rrect(572, y, w, 24, 12)], C["text"])

here = os.path.dirname(__file__) or "."
for name, px in (("icon.png", 1024), ("splash-icon.png", 1024),
                 ("android-icon-foreground.png", 1024), ("favicon.png", 64)):
    c.png(os.path.join(here, name), px)
    print(f"  {name} @{px}")
