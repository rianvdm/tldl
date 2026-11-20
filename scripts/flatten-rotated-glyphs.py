"""Flatten composite glyphs whose components are rotated or skewed.

satori's font parser drew Fraunces SemiBold's "+" wrong: the glyph is a minus
plus a minus rotated 90 degrees, and the rotated copy landed below and to the
right of the bar. Plain offsets, scales and mirrors render correctly, and so did
the symmetric reflections the italics use for "\\". Rather than track which
rotations and skews satori gets right, this rewrites every composite glyph with
a rotated or skewed component as plain outlines, which changes nothing visible
for the ones that already rendered correctly, and leaves every other glyph
untouched.

Usage (Python 3, fontTools):
    python3 -m venv /tmp/ft && /tmp/ft/bin/pip install fonttools
    /tmp/ft/bin/python scripts/flatten-rotated-glyphs.py src/assets/fonts/*.ttf

Rerun it after refreshing any vendored font; it prints each glyph it flattens
and is a no-op on a font that has none left.
"""

import sys

from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont


def is_rotated_or_skewed(component) -> bool:
    transform = getattr(component, "transform", None)
    return transform is not None and (transform[0][1] != 0 or transform[1][0] != 0)


def flatten(path: str) -> None:
    font = TTFont(path)
    glyf = font["glyf"]
    glyph_set = font.getGlyphSet()
    flattened = []
    for name in font.getGlyphOrder():
        glyph = glyf[name]
        if not glyph.isComposite() or not any(is_rotated_or_skewed(c) for c in glyph.components):
            continue
        recording = DecomposingRecordingPen(glyph_set)
        glyph_set[name].draw(recording)
        pen = TTGlyphPen(None)
        recording.replay(pen)
        glyf[name] = pen.glyph()
        flattened.append(name)
    if flattened:
        font.save(path)
    print(f"{path}: flattened {', '.join(flattened) or 'nothing'}")


if __name__ == "__main__":
    for font_path in sys.argv[1:]:
        flatten(font_path)
