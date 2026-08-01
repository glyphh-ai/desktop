#!/usr/bin/env python3
"""Generate fonts/GlyphhBraille.ttf — the 256 braille patterns (U+2800-28FF)
as plain filled squares on a 2x4 dot grid, metrics matched to the bundled
JetBrains Mono (600/1000 em advance).

Why this exists: the app ships LATIN-SUBSET webfonts (JetBrainsMono-latin),
so braille has no glyphs anywhere in the terminal's font chain and the CLI's
braille cat rendered as tofu. Rather than depend on whatever braille-capable
font a machine happens to have, we ship these ~256 trivially-drawn glyphs and
scope them to U+2800-28FF via @font-face unicode-range.

Run (any venv with fonttools):  python scripts/gen-braille-font.py
Output is committed — this script only reruns if the metrics ever change.
"""
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

UPM = 1000
ADV = 600          # JetBrains Mono advance at upm 1000
ASCENT = 800
DESCENT = -200
DOT = 150          # dot square side
# Dot centers sit at exact quarter (x) and eighth (y) positions of the cell
# so the lattice is CONTINUOUS across neighbouring cells — art that spans a
# cell boundary (dot pitch must match: 300 x, 250 y, inside and across)
# otherwise tears into "floating" dots at every cell seam.
XS = [150, 450]
YS = [675, 425, 175, -75]
# braille bit -> (col, row): dots 1-3 left col rows 0-2, 4-6 right col rows
# 0-2, 7 left row 3, 8 right row 3
BITS = [(0, 0), (0, 1), (0, 2), (1, 0), (1, 1), (1, 2), (0, 3), (1, 3)]


def draw(pattern: int):
    pen = TTGlyphPen(None)
    for bit, (cx, cy) in enumerate(BITS):
        if not (pattern >> bit) & 1:
            continue
        x, y = XS[cx] - DOT // 2, YS[cy] - DOT // 2
        pen.moveTo((x, y))
        pen.lineTo((x + DOT, y))
        pen.lineTo((x + DOT, y + DOT))
        pen.lineTo((x, y + DOT))
        pen.closePath()
    return pen.glyph()


def main() -> None:
    names = [".notdef"] + [f"braille{n:02X}" for n in range(256)]
    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder(names)
    fb.setupCharacterMap({0x2800 + n: f"braille{n:02X}" for n in range(256)})
    fb.setupGlyf({".notdef": TTGlyphPen(None).glyph(),
                  **{f"braille{n:02X}": draw(n) for n in range(256)}})
    fb.setupHorizontalMetrics({g: (ADV, 0) for g in names})
    fb.setupHorizontalHeader(ascent=ASCENT, descent=DESCENT)
    fb.setupOS2(sTypoAscender=ASCENT, sTypoDescender=DESCENT, usWinAscent=ASCENT, usWinDescent=-DESCENT)
    fb.setupNameTable({"familyName": "Glyphh Braille", "styleName": "Regular",
                       "fullName": "Glyphh Braille", "psName": "GlyphhBraille"})
    fb.setupPost()
    fb.save("src/renderer/fonts/GlyphhBraille.ttf")
    print("wrote src/renderer/fonts/GlyphhBraille.ttf")


if __name__ == "__main__":
    main()
