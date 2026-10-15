# Zaplie image prompts

The exact prompts behind `../designs/zaplie-designs-grid.jpg`. They were generated
with the `gen-image` skill from
[knowall-ai/claude-plugins](https://github.com/knowall-ai/claude-plugins)
(`skills/gen-image/generate.py`, OpenAI `gpt-image-2`, 1024×1024, `--quality high`).
Each image costs money on the OpenAI account, so keep `--n` small.

```sh
GEN=~/GitHub/claude-plugins/skills/gen-image/generate.py
REFS=assets/agent/references
```

## Step 1: designs (W1–W6)

References: `family-style-timmie.jpg` (the KnowAll agent family look) and
`original-zappie.jpg` (the original Zappie's orange hair and wire veins).

```sh
python3 "$GEN" --model gpt-image-2 \
  --ref $REFS/family-style-timmie.jpg --ref $REFS/original-zappie.jpg \
  --size 1024x1024 --background opaque --quality high \
  --out w1.png --prompt "$BASE DESIGN: <one of the design lines below>"
```

`$BASE`:

> A robot agent in the same family and portrait style as the first reference (worn photoreal metal, a dark glass visor with two big round glowing eyes and no mouth, a small engraved brass nameplate on the chest reading exactly ZAPLIE), but a clearly DIFFERENT individual design as described below. Metal: very dark gunmetal, almost black with a cool blue-grey sheen, scratched and worn with subtle edge wear, not brown, not bronze, not teal. Eyes: hot Bitcoin orange (#F7931A), happy and expressive. Hair: vivid saturated glowing fiery orange like the bright orange hair of the second reference (the original Zappie), made of fine frayed wires so it still feels robotic. No hat. Background: plain, dark charcoal studio backdrop with a soft warm orange glow and vignette, no objects, no scenery. Square close-up portrait, head and shoulders, photoreal cinematic render, readable as a 48px avatar. No other text, no logos, no Bitcoin symbol, no coins, no weapons.

`$BOLT` (used by W3, W4 and W5):

> He holds a solid glowing lightning bolt in hot Bitcoin orange (#F7931A) with a white-hot core, casting orange light on his dark metal.

Design lines:

- **W1:** a smooth rounded dome head, a wide pill-shaped visor, big round headphone ear discs, a tall stiff spiky orange mohawk running front to back. An embossed glowing Bitcoin orange lightning-bolt zap icon on the centre of the chest above the nameplate. Facing the viewer, cheerful.
- **W2:** a tall slim egg-shaped head, a narrow horizontal visor band with two small round eyes, small flush ear vents instead of ear discs, a long swept-back orange quiff that flows backwards like a flame in wind, slender neck. Three-quarter view, confident and charming.
- **W3:** a sturdy boxy square-jawed head with rounded corners, a rounded-rectangle visor, short stubby bolt-shaped antenna ears, a short bristly orange flat-top crew cut, broad heavy shoulders and thick neck pistons. `$BOLT` Holding the bolt resting on his shoulder like a tool. Facing the viewer, friendly and dependable.
- **W4:** a round bubble head with a large circular fishbowl visor covering the whole face, the two orange eyes floating inside, compact cylindrical ear caps, wild punk liberty spikes of orange hair standing straight up in separate sharp spikes. `$BOLT` Holding the bolt up proudly beside his head. Playful and mischievous.
- **W5:** a sleek aerodynamic racing-helmet shaped head, a wraparound visor, ear fins swept back, orange hair streaming backwards in long flame-like strands as if moving at speed, a narrow athletic build. `$BOLT` Holding the bolt out toward the viewer as a gift. Energetic and fast.
- **W6:** closest to the original Zappie: a rounded head with shaved metal sides and a tall thick crest of curly, fluffy, fiery orange curls on top exactly like the original's hair, a wide visor, ear discs with black cables and connectors trailing down the neck, thin glowing orange circuit lines on the cheek plates like the original's veins. Head tilted back in a big joyful laugh, eyes squeezed into happy crescents.

## Step 2: mohawk versions (M1, M3, M4, M6)

The reference is the W image being edited. M1 is the approved design and was
made from W1.

```sh
python3 "$GEN" --model gpt-image-2 --ref w1.png \
  --size 1024x1024 --background opaque --quality high \
  --out m1.png --prompt "$MOHAWK"
```

`$MOHAWK`:

> Keep EXACTLY the same robot design, very dark gunmetal metal, orange eyes, ZAPLIE nameplate, pose, props, framing and plain dark background as the first reference. Change ONLY the hair: make it a classic punk MOHAWK — a single tall, narrow, stiff ridge of vivid glowing fiery Bitcoin-orange hair running in a straight line from the forehead over the crown to the back of the head, only a few centimetres wide, standing straight up in sharp gelled spikes, with the sides of the head completely bare shaved metal. The hair strands are fine frayed glowing wires. Clearly readable as a mohawk silhouette even at 48px. No hat, no other text, no logos.

## New images of the approved Zaplie

Pass `references/zaplie-identity.jpg` as the first reference and start the prompt
with the character block from `../zaplie-character.md`, then describe the pose,
props and setting. Keep the background plain for avatars.
