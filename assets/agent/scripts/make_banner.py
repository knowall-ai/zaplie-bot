#!/usr/bin/env python3
"""Build the 1280x640 repo banner (CoverImage.png) from the Zaplie hero image.

Zaplie is mirrored to stand on the left (his chest bolt is flipped back the right way), the
background is extended to 2:1, and the cover's overlay is added: the title band, the three text
lines in Mulish (Muli's current name) at the positions of the previous cover, and the
"Powered by LNbits" badge.

usage (from the repo root): python3 assets/agent/scripts/make_banner.py [FONTS_DIR]
Fonts: Mulish Bold and Bold Italic (SIL Open Font License), e.g.
  curl -sfLo mulish-700.ttf https://cdn.jsdelivr.net/fontsource/fonts/mulish@latest/latin-700-normal.ttf
  curl -sfLo mulish-700-italic.ttf https://cdn.jsdelivr.net/fontsource/fonts/mulish@latest/latin-700-italic.ttf
"""
import sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERO = "assets/agent/images/zaplie-hero.jpg"
BADGE = "assets/agent/references/lnbits-badge.png"
FONTS = sys.argv[1] if len(sys.argv) > 1 else "."
OUT = "CoverImage.png"
W, H, BAND_TOP = 1280, 640, 512
ORANGE = (247, 147, 26)

# 1. Mirror the hero so he stands on the left; put the chest bolt back the right way round.
hero = Image.open(HERO).convert("RGB")
mirrored = hero.transpose(Image.FLIP_LEFT_RIGHT)
x0, y0, x1, y1 = 994, 688, 1138, 859                       # chest bolt plus margin, original coords
patch = hero.crop((x0, y0, x1, y1))
mask = Image.new("L", patch.size, 0)
ImageDraw.Draw(mask).ellipse((14, 10, patch.width - 14, patch.height - 10), fill=255)
mask = mask.filter(ImageFilter.GaussianBlur(9))
mirrored.paste(patch, (hero.width - x1, y0), mask)

# 2. Scale to the banner height and extend the dark background to the right.
scaled = mirrored.resize((round(hero.width * H / hero.height), H), Image.LANCZOS)
canvas = Image.new("RGB", (W, H))
canvas.paste(scaled, (0, 0))
sw = scaled.width
strip = scaled.crop((sw - 200, 0, sw, H)).transpose(Image.FLIP_LEFT_RIGHT)
ext = Image.new("RGB", (W - sw, H))
ext.paste(strip, (0, 0)); ext.paste(strip.transpose(Image.FLIP_LEFT_RIGHT), (200, 0))
ext = ext.filter(ImageFilter.GaussianBlur(30))
canvas.paste(ext, (sw, 0))
fade = 120                                                          # crossfade the seam
grad = Image.linear_gradient("L").rotate(90, expand=True).resize((fade, H))   # 255 -> 0 left to right
left = scaled.crop((sw - fade, 0, sw, H))
right = Image.new("RGB", (fade, H)); right.paste(ext.crop((0, 0, 1, H)).resize((fade, H)))
canvas.paste(Image.composite(left, Image.blend(left.filter(ImageFilter.GaussianBlur(30)), right, 0.5), grad), (sw - fade, 0))

# 3. The dark title band along the bottom.
band = Image.new("RGBA", (W, H - BAND_TOP), (36, 25, 15, 232))
canvas = canvas.convert("RGBA")
canvas.alpha_composite(band, (0, BAND_TOP))

# 4. Text, fitted to the ink boxes measured on the previous cover (x, y, width, height).
draw = ImageDraw.Draw(canvas)
LINES = [
    ("ZAPLIE COPILOT:", (44, 559, 516, 45), (255, 255, 255), ["mulish-700-italic"]),
    ("INCENTIVIZING", (583, 567, 293, 29), ORANGE, ["mulish-700-italic"]),
    ("TEAMMATES | COPILOTS | CUSTOMERS", (581, 610, 460, 22), (255, 255, 255), ["mulish-700"]),
]
for text, (tx, ty, tw, th), colour, candidates in LINES:
    best = None
    for name in candidates:
        size = 40.0
        for _ in range(6):                                          # converge on the target width
            font = ImageFont.truetype(f"{FONTS}/{name}.ttf", round(size))
            l, t, r, b = draw.textbbox((0, 0), text, font=font)
            size *= tw / (r - l)
        font = ImageFont.truetype(f"{FONTS}/{name}.ttf", round(size))
        l, t, r, b = draw.textbbox((0, 0), text, font=font)
        err = abs((b - t) - th) + abs((r - l) - tw)
        if best is None or err < best[0]:
            best = (err, name, font, l, t, r - l, b - t)
    err, name, font, l, t, w, h = best
    draw.text((tx - l, ty - t), text, font=font, fill=colour)
    print(f"{text!r}: {name} size {font.size} ink {w}x{h} (target {tw}x{th})")

# 5. The "Powered by LNbits" badge, top right (the panel carries its own rounded corners).
canvas.alpha_composite(Image.open(BADGE).convert("RGBA"), (990, 24))

canvas.convert("RGB").save(OUT)
print("wrote", OUT, canvas.size)
