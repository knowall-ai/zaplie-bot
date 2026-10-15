# Zaplie image prompts

The exact prompts behind `../images/`. They were generated with the `gen-image`
skill from [knowall-ai/claude-plugins](https://github.com/knowall-ai/claude-plugins)
(`skills/gen-image/generate.py`, OpenAI `gpt-image-2`, `--quality high`), with
`references/zaplie-identity.jpg` as the only reference. Each image costs money on
the OpenAI account, so keep `--n` small.

```sh
GEN=~/GitHub/claude-plugins/skills/gen-image/generate.py
python3 "$GEN" --model gpt-image-2 \
  --ref assets/agent/references/zaplie-identity.jpg \
  --size 1024x1024 --background opaque --quality high \
  --out zaplie-profile.png --prompt "$CHAR <shot line> $NO"
```

Use `--size 1536x1024` for the hero, and `1024x1024` for everything else.

`$CHAR`:

> EXACTLY the robot in the reference image, Zaplie: very dark scratched gunmetal with a cool blue-grey sheen, a smooth rounded dome head, a wide pill-shaped dark glass visor with two big round glowing Bitcoin orange (#F7931A) eyes, NO mouth (the metal below the visor is smooth and blank), big round headphone ear discs, a full bushy crest of fiery glowing orange wire strands running front to back on top of his head, an embossed glowing orange lightning-bolt zap icon on his chest above a brass nameplate reading exactly ZAPLIE. Same design, proportions and materials as the reference; there is exactly one Zaplie. Photoreal cinematic render, worn realistic metal, never plastic.

`$NO`:

> No other text, no logos, no Bitcoin symbol, no coins, no weapons, no hat.

`$ZAP` (inside the shot lines):

> bright Bitcoin orange (#F7931A) lightning with a white-hot core

Shot lines:

- **Hero:** Wide 3:2 website hero banner. Zaplie seen from the chest up, large and close on the RIGHT half of the frame, turning slightly toward the left and holding out a crackling ball of `$ZAP` in an open palm, a few small orange sparks drifting into the empty space. The LEFT half is empty and very dark so a headline can sit over it. Background: very dark charcoal with a soft warm orange glow behind him and a gentle vignette.
- **Profile:** Profile picture: a centred head-and-shoulders portrait looking straight at the viewer, friendly, eyes bright. The head and mohawk fill most of the frame with a little space above the hair, the chest zap icon visible at the bottom edge so it crops well into a circle. Background: plain dark charcoal with a soft warm orange glow behind his head.
- **Zapping:** Action shot: Zaplie playfully firing a crackling bolt of `$ZAP` from his outstretched fingertips toward the left of the frame, his other hand on his hip, mohawk glowing brighter, little sparks bouncing off the edges, eyes squinted into happy crescents. Waist-up, three-quarter view. Background: plain dark charcoal with orange light from the zap.
- **Gift:** Zaplie holding a solid glowing lightning bolt made of `$ZAP` out toward the viewer with both hands like a gift, leaning in slightly, eyes squinted into happy crescents, warm orange light from the bolt on his metal. Waist-up, facing the viewer. Background: plain dark charcoal with a soft warm glow.
- **Celebrate:** Zaplie celebrating: both arms thrown up in the air in triumph, a shower of small `$ZAP` sparks and confetti-like orange sparks bursting around him, mohawk flaring, eyes squinted into joyful crescents. Waist-up, facing the viewer. Background: plain dark charcoal with a warm orange glow.
- **Wave:** Zaplie giving a friendly hello wave with one raised hand, head tilted slightly, eyes squinted into happy crescents, a single tiny orange spark at his fingertips. Waist-up, facing the viewer. Background: plain dark charcoal with a soft warm orange glow.

## New shots

Keep `$CHAR` and `$NO` unchanged and write a new shot line: the pose, the props
and a plain background. Plain dark backgrounds keep the set consistent and read
well at small sizes.
