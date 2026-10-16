#!/usr/bin/env python3
"""Build the 1280x640 repo cover (CoverImage.png) from the Zaplie hero image (step 2 of 2).

The hero is scaled to the cover height with Zaplie kept on the right, the empty dark
background is extended to the left, the white KnowAll AI logo goes top left (same 44 px
margin as the text), and the text layer made by make_cover_text.py is overlaid straight on
the image.

usage (from the repo root):
  python3 assets/agent/scripts/make_cover_text.py
  python3 assets/agent/scripts/make_banner.py
"""
from PIL import Image, ImageFilter

HERO = "assets/agent/images/zaplie-hero.jpg"
TEXT = "assets/agent/references/cover-text.png"
LOGO = "assets/agent/references/knowall-logo.png"      # official logo, dark on transparent
LOGO_POS, LOGO_HEIGHT = (44, 44), 96
OUT = "CoverImage.png"
W, H = 1280, 640


def background():
    """Return the 1280x640 backdrop: the hero on the right, its left edge mirrored and blurred to fill the rest."""
    hero = Image.open(HERO).convert("RGB")
    scaled = hero.resize((round(hero.width * H / hero.height), H), Image.LANCZOS)
    left_w = W - scaled.width
    canvas = Image.new("RGB", (W, H))
    canvas.paste(scaled, (left_w, 0))
    # Extend the empty left edge: mirror the hero's first 200 px outward, blur it, fade the seam.
    strip = scaled.crop((0, 0, 200, H)).transpose(Image.FLIP_LEFT_RIGHT)
    ext = Image.new("RGB", (left_w, H))
    for i, x in enumerate(range(left_w - 200, -200, -200)):
        ext.paste(strip if i % 2 == 0 else strip.transpose(Image.FLIP_LEFT_RIGHT), (x, 0))
    canvas.paste(ext.filter(ImageFilter.GaussianBlur(30)), (0, 0))
    fade = 120
    grad = Image.linear_gradient("L").rotate(90, expand=True).resize((fade, H))    # 0 -> 255 left to right: blurred -> sharp
    seam = scaled.crop((0, 0, fade, H))
    canvas.paste(Image.composite(seam, seam.filter(ImageFilter.GaussianBlur(30)), grad), (left_w, 0))
    return canvas


if __name__ == "__main__":
    cover = background().convert("RGBA")
    logo = Image.open(LOGO).convert("RGBA")
    logo = logo.crop(logo.getchannel("A").getbbox())                  # trim transparent padding
    white = Image.new("RGBA", logo.size, (255, 255, 255, 0))
    white.putalpha(logo.getchannel("A"))                              # white logo, same shape
    white = white.resize((round(logo.width * LOGO_HEIGHT / logo.height), LOGO_HEIGHT), Image.LANCZOS)
    cover.alpha_composite(white, LOGO_POS)
    cover.alpha_composite(Image.open(TEXT).convert("RGBA"))
    cover.convert("RGB").save(OUT)
    print("wrote", OUT, cover.size)
