"""Scanline polygon filler and PNG writer.

Library only: importing this must not draw anything. An earlier version carried
the drawing at module level, so importing it silently overwrote icon.png."""
import zlib, struct, math

W = 1024
SS = 4                      # vertical subsamples; x coverage is analytic
PAL = {
    "cream":  (0xfa, 0xf5, 0xef),
    "page":   (0xfd, 0xf9, 0xf3),
    "shade":  (0xf4, 0xe8, 0xd8),
    "terra":  (0xc4, 0x55, 0x2e),
    "navy":   (0x2b, 0x41, 0x62),
    "tan":    (0xe8, 0xa8, 0x7c),
    "amber":  (0xf2, 0xc9, 0x4c),
}

class Canvas:
    def __init__(self, w, bg):
        self.w = w
        self.buf = bytearray(bg * w * w)

    def fill(self, polys, color, alpha=1.0):
        """Scanline fill with SS vertical subsamples and fractional x coverage."""
        r, g, b = color
        edges = []
        for poly in polys:
            n = len(poly)
            for i in range(n):
                x0, y0 = poly[i]
                x1, y1 = poly[(i + 1) % n]
                if y0 != y1:
                    edges.append((x0, y0, x1, y1))
        if not edges:
            return
        ymin = max(0, int(min(min(e[1], e[3]) for e in edges)))
        ymax = min(self.w - 1, int(max(max(e[1], e[3]) for e in edges)) + 1)
        cov = [0.0] * self.w
        for py in range(ymin, ymax + 1):
            for i in range(self.w):
                cov[i] = 0.0
            hit = False
            for s in range(SS):
                sy = py + (s + 0.5) / SS
                xs = []
                for (x0, y0, x1, y1) in edges:
                    if (y0 <= sy < y1) or (y1 <= sy < y0):
                        xs.append(x0 + (sy - y0) * (x1 - x0) / (y1 - y0))
                if len(xs) < 2:
                    continue
                xs.sort()
                for k in range(0, len(xs) - 1, 2):
                    a, bx = xs[k], xs[k + 1]
                    if bx <= 0 or a >= self.w:
                        continue
                    a = max(a, 0.0); bx = min(bx, float(self.w))
                    ia, ib = int(a), int(bx)
                    hit = True
                    if ia == ib:
                        cov[ia] += (bx - a) / SS
                        continue
                    cov[ia] += (ia + 1 - a) / SS
                    for x in range(ia + 1, ib):
                        cov[x] += 1.0 / SS
                    if ib < self.w:
                        cov[ib] += (bx - ib) / SS
            if not hit:
                continue
            row = py * self.w * 3
            for x in range(self.w):
                c = cov[x]
                if c <= 0.001:
                    continue
                c = min(1.0, c) * alpha
                o = row + x * 3
                self.buf[o]     = int(self.buf[o]     + (r - self.buf[o])     * c)
                self.buf[o + 1] = int(self.buf[o + 1] + (g - self.buf[o + 1]) * c)
                self.buf[o + 2] = int(self.buf[o + 2] + (b - self.buf[o + 2]) * c)

    def png(self, path, size=None):
        src, w = self.buf, self.w
        if size and size != w:                      # box downsample
            out = bytearray(size * size * 3)
            f = w / size
            for y in range(size):
                y0, y1 = int(y * f), max(int(y * f) + 1, int((y + 1) * f))
                for x in range(size):
                    x0, x1 = int(x * f), max(int(x * f) + 1, int((x + 1) * f))
                    tr = tg = tb = n = 0
                    for yy in range(y0, y1):
                        base = yy * w * 3
                        for xx in range(x0, x1):
                            o = base + xx * 3
                            tr += src[o]; tg += src[o + 1]; tb += src[o + 2]; n += 1
                    o = (y * size + x) * 3
                    out[o] = tr // n; out[o + 1] = tg // n; out[o + 2] = tb // n
            src, w = out, size
        raw = bytearray()
        for y in range(w):
            raw.append(0)
            raw += src[y * w * 3:(y + 1) * w * 3]
        def chunk(t, d):
            c = struct.pack(">I", len(d)) + t + d
            return c + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
        png = (b"\x89PNG\r\n\x1a\n"
               + chunk(b"IHDR", struct.pack(">IIBBBBB", w, w, 8, 2, 0, 0, 0))
               + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
               + chunk(b"IEND", b""))
        open(path, "wb").write(png)
        return len(png)

def rrect(x, y, w, h, r, n=8):
    """Rounded rectangle as a polygon."""
    pts = []
    for cx, cy, a0 in ((x+w-r, y+r, -90), (x+w-r, y+h-r, 0), (x+r, y+h-r, 90), (x+r, y+r, 180)):
        for i in range(n + 1):
            a = math.radians(a0 + 90 * i / n)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts

def arc(cx, cy, r, a0, a1, n=10):
    pts = []
    for i in range(n + 1):
        a = math.radians(a0 + (a1 - a0) * i / n)
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts

def page(sign, inset=0.0):
    """One half of the open book. sign=-1 left, +1 right.

    The top edge rises towards the outer corner and the bottom edge sags, which
    is what makes it read as a splayed book rather than two rectangles. Corners
    are written out per side: deriving them from `sign` arithmetic is how the
    left page ended up with a diagonal slash through it.
    """
    cx = 512.0
    r = 34.0
    outer = cx + sign * (372 - inset)
    inner = cx + sign * (10 + inset * 0.2)
    top_i, top_o = 300 + inset, 262 + inset
    bot_i, bot_o = 772 - inset, 736 - inset
    corner_x = outer - sign * r
    N = 26

    pts = []
    for i in range(N + 1):                       # top edge: inner -> corner
        t = i / N
        pts.append((inner + (corner_x - inner) * t, top_i + (top_o - top_i) * (t ** 0.75)))
    if sign > 0:
        pts += arc(corner_x, top_o + r, r, -90, 0)
        pts += arc(corner_x, bot_o - r, r, 0, 90)
    else:
        pts += arc(corner_x, top_o + r, r, -90, -180)
        pts += arc(corner_x, bot_o - r, r, 180, 90)
    for i in range(N + 1):                       # bottom edge: corner -> inner
        t = i / N
        pts.append((corner_x + (inner - corner_x) * t,
                    bot_o + (bot_i - bot_o) * (1 - (1 - t) ** 0.75)))
    return pts

