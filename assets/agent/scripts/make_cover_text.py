#!/usr/bin/env python3
"""Create the cover's text as a transparent 1280x640 layer (step 1 of 2; make_banner.py adds it
to the picture).

Layout, all white and upright (no italics), in the Photoshop cover's font (Calibri Bold):

    ZAPLIE : INCENTIVIZING
             TEAMMATES | AGENTS | CUSTOMERS

- ZAPLIE and the colon keep the previous cover's size (80 px), left edge and baseline.
- The top of INCENTIVIZING lines up with the top of ZAPLIE.
- The bottom (baseline) of the small line lines up with the bottom of ZAPLIE.
- INCENTIVIZING and the small line share the same left edge, and INCENTIVIZING is stretched
  to exactly the small line's width.
The script checks those rules on the finished layer and stops if any is off by more than 1 px.

Font: Calibri Bold if found (set CALIBRI_BOLD, or put calibrib.ttf in ~/.local/share/fonts),
otherwise Carlito Bold, which has the same metrics (package fonts-crosextra-carlito).

usage (from the repo root): python3 assets/agent/scripts/make_cover_text.py [OUT.png]
"""
import glob, os, sys
from PIL import Image, ImageDraw, ImageFont

OUT = sys.argv[1] if len(sys.argv) > 1 else "assets/agent/references/cover-text.png"
W, H = 1280, 640
S = 4                                    # work at 4x for sub-pixel accuracy, then scale down

# From the Photoshop cover (CoverImage.psd and the previous CoverImage.png), in 1x pixels.
TITLE_LEFT, BASELINE = 44, 620           # left ink edge (left-aligned margin) and baseline of the big title
TITLE_PX = 80                            # title and colon size (320 pt at 25% scale)
SMALL_PX = 24 * 0.9838                   # small line size (24 pt at 98.4% scale)
TRACKING = 25 / 1000                     # INCENTIVIZING letter spacing, in em
COLON_GAP, STACK_GAP = 15, 13            # ink gaps: title to colon, colon to the stacked lines
COLON_RAISE = 9                          # the colon's bottom sits this far above the baseline
LINE_GAP = 5                             # gap between INCENTIVIZING and the small line's capitals

TITLE, SMALL, STACK_TOP = "ZAPLIE", "TEAMMATES | AGENTS | CUSTOMERS", "INCENTIVIZING"


def find_font():
    names = ["calibrib.ttf", "Calibri Bold.ttf", "Calibri-Bold.ttf", "Carlito-Bold.ttf"]
    if os.environ.get("CALIBRI_BOLD"):
        return os.environ["CALIBRI_BOLD"]
    dirs = [os.path.expanduser("~/.local/share/fonts"), os.path.expanduser("~/.fonts"), "/usr/share/fonts", "/usr/local/share/fonts"]
    for name in names:
        for d in dirs:
            hits = glob.glob(os.path.join(d, "**", name), recursive=True)
            if hits:
                return hits[0]
    sys.exit("No Calibri Bold or Carlito Bold font found (install fonts-crosextra-carlito)")


def ink(text, px, font_path, tracking=0.0):
    """Render text at 4x; return its cropped mask and the ink box relative to the baseline origin."""
    font = ImageFont.truetype(font_path, round(px * S))
    size = font.size
    extra = tracking * size
    width = int(sum(font.getlength(ch) for ch in text) + extra * len(text) + size * 2)
    mask = Image.new("L", (width, size * 3), 0)
    d = ImageDraw.Draw(mask)
    ox, oy = size // 2, size * 2                                     # origin: left end of the baseline
    for i, ch in enumerate(text):
        d.text((ox + font.getlength(text[:i]) + extra * i, oy), ch, font=font, fill=255, anchor="ls")
    l, t, r, b = mask.getbbox()
    return mask.crop((l, t, r, b)), (l - ox, t - oy, r - ox, b - oy)  # box relative to baseline origin


def main():
    font_path = find_font()
    print("font:", font_path)
    layer = Image.new("L", (W * S, H * S), 0)
    base = BASELINE * S
    boxes = {}

    # Title: left ink edge at TITLE_LEFT, sitting on the baseline.
    m, (l, t, r, b) = ink(TITLE, TITLE_PX, font_path)
    x = TITLE_LEFT * S
    layer.paste(m, (x, base + t), m)
    boxes["title"] = (x, base + t, x + m.width, base + b)

    # Colon: after the title, raised so its bottom sits COLON_RAISE above the baseline.
    m, _ = ink(":", TITLE_PX, font_path)
    cx, cb = boxes["title"][2] + COLON_GAP * S, base - COLON_RAISE * S
    layer.paste(m, (cx, cb - m.height), m)
    boxes["colon"] = (cx, cb - m.height, cx + m.width, cb)

    # Small line: left edge after the colon, on the title's baseline.
    sx = boxes["colon"][2] + STACK_GAP * S
    m, (l, t, r, b) = ink(SMALL, SMALL_PX, font_path)
    caps, (cl, ct, cr, cbx) = ink("TEAMMATES", SMALL_PX, font_path)   # cap height without the bars
    layer.paste(m, (sx, base + t), m)
    boxes["small"] = (sx, base + t, sx + m.width, base + b)
    small_caps_top = base + ct

    # INCENTIVIZING: same left edge and width as the small line, top level with the title's top.
    top = boxes["title"][1]
    bottom = small_caps_top - LINE_GAP * S
    m, _ = ink(STACK_TOP, TITLE_PX, font_path, TRACKING)
    m = m.resize((boxes["small"][2] - sx, bottom - top), Image.LANCZOS)
    layer.paste(m, (sx, top), m)
    boxes["incent"] = (sx, top, sx + m.width, bottom)

    out = Image.new("RGBA", (W, H), (255, 255, 255, 0))
    out.putalpha(layer.resize((W, H), Image.LANCZOS))

    # Check the alignment rules (in 1x pixels).
    px = {k: tuple(v / S for v in box) for k, box in boxes.items()}
    rules = {
        "INCENTIVIZING top = ZAPLIE top": (px["incent"][1], px["title"][1]),
        "small line baseline = ZAPLIE bottom": (BASELINE, px["title"][3]),
        "INCENTIVIZING left = small line left": (px["incent"][0], px["small"][0]),
        "INCENTIVIZING width = small line width": (px["incent"][2] - px["incent"][0], px["small"][2] - px["small"][0]),
    }
    ok = True
    for name, (a, b) in rules.items():
        good = abs(a - b) <= 1
        ok &= good
        print(f"  {'ok ' if good else 'BAD'} {name}: {a:.2f} vs {b:.2f}")
    for k, v in px.items():
        print(f"  {k:6} box {tuple(round(c, 1) for c in v)}")
    if not ok:
        sys.exit("alignment rule broken")
    out.save(OUT)
    print("wrote", OUT)


if __name__ == "__main__":
    main()
