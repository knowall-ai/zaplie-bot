#!/usr/bin/env python3
"""Build the app icons from the Zaplie profile image.

Teams app package (appPackage/):
  outline.png  32x32 white lightning bolt on transparent (Teams requires white + transparent)
  color.png is not written here: the Teams colour icon is the head-and-shoulders crop chosen
  in PR 506, and the production bot's fallback iconUrl points at it, so a re-run must not
  replace it.
Tab app (tabs/public/):
  favicon.ico  16/24/32/64 px, logo192.png, logo512.png: Zaplie's head

usage (from the repo root):
  python3 assets/agent/scripts/make_icons.py
"""
from PIL import Image, ImageDraw

PROFILE = "assets/agent/images/zaplie-profile.jpg"
HEAD_BOX = (90, 0, 850, 760)    # square crop: whole head, hair, eyes and the top of the bolt
# Bolt in a 32x32 grid, matching the chest emblem's slant.
BOLT = [(19, 2), (7, 18), (15, 18), (12, 30), (25, 13), (17, 13), (21, 2)]
SS = 16                          # supersampling factor for a smooth outline bolt


def head(size):
    """Return Zaplie's head cropped square from the profile image at size x size."""
    return Image.open(PROFILE).convert("RGB").crop(HEAD_BOX).resize((size, size), Image.LANCZOS)


def outline():
    """Return the 32x32 Teams outline icon: a white bolt, anti-aliased by drawing it large and scaling down."""
    big = Image.new("L", (32 * SS, 32 * SS), 0)
    ImageDraw.Draw(big).polygon([(x * SS, y * SS) for x, y in BOLT], fill=255)
    icon = Image.new("RGBA", (32, 32), (255, 255, 255, 0))
    icon.putalpha(big.resize((32, 32), Image.LANCZOS))
    return icon


def main():
    """Build and save every icon."""
    outline().save("appPackage/outline.png")
    head(192).save("tabs/public/logo192.png")
    head(512).save("tabs/public/logo512.png")
    head(256).save("tabs/public/favicon.ico", sizes=[(16, 16), (24, 24), (32, 32), (64, 64)])


if __name__ == "__main__":
    main()
