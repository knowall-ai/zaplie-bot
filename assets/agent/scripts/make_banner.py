#!/usr/bin/env python3
"""Build the 1280x640 repo cover (CoverImage.png) from the Zaplie hero image.

The hero is scaled to the cover height with Zaplie kept on the right, and the empty dark
background is extended to the left. The text is overlaid straight on the image, exactly where
it sits on the previous cover (taken from CoverImage.psd, with ZAPLIE in place of ZAPP.IE):
Calibri Bold, rendered with Carlito Bold (metrically identical to Calibri). Each element is
fitted to the previous cover's ink box, and --check verifies that against a reference cover.

usage (from the repo root):
  python3 assets/agent/scripts/make_banner.py [--check REFERENCE.png]
To check against the previous cover, extract it from git first:
  git show f2046d4e:CoverImage.png > /tmp/old-cover.png
  python3 assets/agent/scripts/make_banner.py --check /tmp/old-cover.png
The font is Carlito Bold (SIL Open Font License, package fonts-crosextra-carlito); set
CARLITO_BOLD to its path if it isn't in a standard location.
"""
import argparse, glob, os, sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERO = "assets/agent/images/zaplie-hero.jpg"
OUT = "CoverImage.png"
W, H = 1280, 640

# Ink boxes (left, top, right, bottom; inclusive) of each text element on the previous cover.
TEXT = [
    ("ZAPLIE COPILOT", (179, 568, 719, 620), 0),
    (":", (734, 576, 743, 611), 0),
    ("INCENTIVIZING", (757, 568, 1135, 602), 25),              # tracking 25/1000 em, as in the PSD
    ("TEAMMATES | COPILOTS | CUSTOMERS", (755, 604, 1137, 621), 0),
]


def find_font():
    path = os.environ.get("CARLITO_BOLD")
    candidates = ([path] if path else []) + glob.glob(os.path.expanduser("~/.local/share/fonts/Carlito-Bold.ttf")) \
        + glob.glob("/usr/share/fonts/**/Carlito-Bold.ttf", recursive=True)
    for c in candidates:
        if c and os.path.exists(c):
            return c
    sys.exit("Carlito-Bold.ttf not found: install fonts-crosextra-carlito or set CARLITO_BOLD")


def render(text, box, tracking, font_path):
    """White text whose ink exactly fills box, as an RGBA image to paste at (box[0], box[1])."""
    size = 400                                                   # render large, then scale down
    font = ImageFont.truetype(font_path, size)
    extra = tracking / 1000 * size
    width = sum(font.getlength(ch) for ch in text) + extra * len(text) + size
    mask = Image.new("L", (int(width), size * 2), 0)
    d = ImageDraw.Draw(mask)
    for i, ch in enumerate(text):                                # kerned position of each character
        x = size / 4 + font.getlength(text[:i]) + extra * i
        d.text((x, size / 2), ch, font=font, fill=255)
    mask = mask.crop(mask.getbbox())
    w, h = box[2] - box[0] + 1, box[3] - box[1] + 1
    mask = mask.resize((w, h), Image.LANCZOS)
    layer = Image.new("RGBA", (w, h), (255, 255, 255, 0))
    layer.putalpha(mask)
    return layer


def build():
    hero = Image.open(HERO).convert("RGB")
    scaled = hero.resize((round(hero.width * H / hero.height), H), Image.LANCZOS)
    left_w = W - scaled.width
    canvas = Image.new("RGB", (W, H))
    canvas.paste(scaled, (left_w, 0))
    # Extend the empty left edge: mirror the hero's first 200 px outward, blurred, and fade the seam.
    strip = scaled.crop((0, 0, 200, H)).transpose(Image.FLIP_LEFT_RIGHT)
    ext = Image.new("RGB", (left_w, H))
    for x in range(left_w - 200, -200, -200):
        ext.paste(strip if (left_w - 200 - x) // 200 % 2 == 0 else strip.transpose(Image.FLIP_LEFT_RIGHT), (x, 0))
    ext = ext.filter(ImageFilter.GaussianBlur(30))
    canvas.paste(ext, (0, 0))
    fade = 120
    grad = Image.linear_gradient("L").rotate(-90, expand=True).resize((fade, H))   # 0 -> 255 left to right
    seam = scaled.crop((0, 0, fade, H))
    canvas.paste(Image.composite(seam, seam.filter(ImageFilter.GaussianBlur(30)), grad), (left_w, 0))

    canvas = canvas.convert("RGBA")
    font_path = find_font()
    for text, box, tracking in TEXT:
        canvas.alpha_composite(render(text, box, tracking, font_path), (box[0], box[1]))
    return canvas.convert("RGB")


def check(img, reference):
    """Check that every text element sits exactly where it does on a reference cover:
    each element's left, top, right and bottom ink edges must be within 1 px."""
    ref = Image.open(reference).convert("L")
    new = img.convert("L")
    ok = True
    for text, (x0, y0, x1, y1), _ in TEXT:
        crop = (x0 - 6, y0 - 6, x1 + 7, y1 + 7)
        edges = []
        for im in (new, ref):
            mask = im.point(lambda v: 255 if v > 200 else 0)
            for other, obox, _ in TEXT:                          # ignore neighbouring elements
                if other != text:
                    mask.paste(0, (obox[0], obox[1], obox[2] + 1, obox[3] + 1))
            box = mask.crop(crop).getbbox()
            edges.append((box[0] + crop[0], box[1] + crop[1], box[2] + crop[0] - 1, box[3] + crop[1] - 1))
        worst = max(abs(p - q) for p, q in zip(*edges))
        ok &= worst <= 1
        print(f"  {text!r}: edges {edges[0]} vs reference {edges[1]} (worst {worst} px)")
    return ok


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", help="reference cover to compare the text against")
    ap.add_argument("--out", default=OUT)
    args = ap.parse_args()
    img = build()
    img.save(args.out)
    print("wrote", args.out, img.size)
    if args.check and not check(img, args.check):
        sys.exit("text does not line up with the reference")
