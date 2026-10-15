# Zaplie character and voice sheet

Reusable prompt blocks for generating Zaplie images and videos. Paste the blocks
**verbatim**: the video model (Gemini Omni, `gemini-omni-1.1-flash`) has no voice
setting and no voice or audio reference, so identical wording is the only thing
that keeps the voice and look consistent between clips.

## What's in this kit

| Path | What it is |
|---|---|
| `references/zaplie-identity.jpg` | The approved look. Pass it as an image reference. |
| `references/zaplie-voice-sample.m4a` | 10 s of the approved voice (with music under it), for tools that accept a voice sample. |
| `images/zaplie-hero.jpg` | Wide 3:2 hero, space on the left for a headline. |
| `images/zaplie-profile.jpg` | Square profile picture; crops well into a circle. |
| `images/zaplie-zapping.jpg` | Firing a zap from his fingertips. |
| `images/zaplie-gift.jpg` | Handing over a glowing orange bolt. |
| `images/zaplie-celebrate.jpg` | Arms up in a shower of sparks. |
| `images/zaplie-wave.jpg` | A friendly hello wave. |
| `images/zaplie-electrified.jpg` | Full electrified hair (rare, big moments): crest luminous and buzzing. Usually it is subtler. |
| `prompts/images.md` | The exact prompts and commands behind `images/`. |
| `prompts/video-*.txt` | The prompts for both videos. |
| `scripts/omni_video.py` | Generates or extends a Gemini Omni video. |
| `video/zaplie-funk.mp4` | 10 s: dancing on a disco floor, zapping bulbs (no dialogue). |
| `video/zaplie-club.mp4` | 20 s: robot club, with his voice and catchphrases. |

The videos were made from an earlier draft with a narrower mohawk; the approved
look has the fuller crest in `references/zaplie-identity.jpg`.

## Making a video

The script reads the Gemini key from `~/.config/google/gemini_api_key` and never
prints it. Generate a 10 s clip, then extend it with the interaction id the first
run prints:

```sh
S=assets/agent/scripts/omni_video.py
P=assets/agent/prompts
python3 -I $S --prompt-file $P/video-club-part1.txt \
  --ref assets/agent/references/zaplie-identity.jpg --out part1.mp4 | tee part1.log
ID=$(grep -o 'interaction: [^ ]*' part1.log | cut -d' ' -f2)
python3 -I $S --prompt-file $P/video-club-part2-extend.txt \
  --ref assets/agent/references/zaplie-identity.jpg \
  --previous "$ID" --out club.mp4   # returns the full 20 s
```

1080p and 4k videos are too big to return inline, so the script asks the API to
host them and downloads the file when it is ready (`--delivery uri`).

## Character block

> Zaplie: very dark scratched gunmetal with a cool blue-grey sheen, a smooth
> rounded dome head, a wide pill-shaped dark glass visor with two big round
> glowing Bitcoin orange (#F7931A) eyes, NO mouth (the metal below the visor is
> smooth and blank), big round headphone ear discs, a full bushy crest of fiery
> glowing orange wire strands running front to back on top of his head, an
> embossed glowing orange lightning-bolt zap icon on his chest above a brass
> nameplate reading exactly ZAPLIE. There is exactly ONE Zaplie; he never splits,
> duplicates or changes design.

## Electrified hair

His crest reacts to his energy at two levels. Add a level to the shot, not to the
character block.

**Subtle (the usual).** Use it when he's excited or zapping:

> His crest of orange wire hair glows a little brighter, with a few faint
> flickering orange arcs between the strands and the odd spark at the tips.

**Full electrified (rare).** Save it for big moments, such as a huge zap, a
celebration or a finale. `images/zaplie-electrified.jpg` shows it:

> His crest of wire hair goes intensely LUMINOUS, glowing bright neon Bitcoin
> orange (#F7931A) from root to tip as if lit from inside, and BUZZES with
> electricity: dense crackling orange arcs jumping between the strands, small
> electric forks leaping off the tips, a fine glowing haze and a few flying
> sparks. It still reads as his bushy crest, not fire, and its orange light
> spills onto his dome, ear discs and visor rim.

## Voice block

> He has a funny, high-energy, slightly squeaky, crackly robot voice with a smooth
> late-night-radio-DJ swagger.

When extending a clip, also add:

> He keeps exactly the same funny, squeaky, crackly robot voice with radio-DJ
> swagger as in the first 10 seconds.

Catchphrases: "Let's get zappy tonight, baby!", "Who ordered a little extra
voltage? Bzzt!", "Zap for you! Everybody gets a zap!", "Zaplie out! Bzzt!"

## Face rules (put these FIRST in any prompt where he talks)

> His face is a dark glass visor with exactly TWO separate round glowing orange
> eyes and nothing else. The eyes can squint into happy arcs or widen, but always
> stay two separate orange eyes on dark glass. The visor never turns into a
> screen, never shows a drawn or cartoon face, never merges the eyes into a bar.
> He has NO mouth: the metal below his visor is smooth, blank gunmetal in every
> frame, even while he talks. His voice comes from his round ear discs, which
> pulse orange on each word. NO robot anywhere in the scene has a mouth or a
> screen face.

## Music block

> An upbeat, original 1980s funk groove: slap bass, wah-wah guitar, punchy brass
> stabs, a drum machine with handclaps.

## Lessons

- Get the face right in the FIRST clip. Extensions continue whatever the opening
  establishes: a faint smile line under the visor in the first 10 s came back in
  every extension, however strict the extension prompt was.
  `prompts/video-club-part1.txt` is saved exactly as used and let that line in;
  for a new video, put the face rules at the top of the first prompt.
- When he talks, the model tends to give him a mouth or merge his visor into a bar
  or a screen. Put the face rules first, and keep robots with screen faces
  (TV heads) out of any shot where he speaks: he once blended into one.
- Ask for an original groove, not a named song.
- Omni costs about $0.10 per second at 720p. A 10 s extension also re-reads the
  earlier clip, so it costs about $1.10.
