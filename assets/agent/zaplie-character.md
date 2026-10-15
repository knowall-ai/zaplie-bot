# Zaplie character and voice sheet

Reusable prompt blocks for generating Zaplie images and videos. Paste the blocks
**verbatim**: the video model (Gemini Omni, `gemini-omni-1.1-flash`) has no voice
setting and no voice or audio reference, so identical wording is the only thing
that keeps the voice and look consistent between clips.

## What's in this kit

| Path | What it is |
|---|---|
| `references/zaplie-identity.jpg` | The approved look (design M1). Pass it as an image reference. |
| `references/zaplie-voice-sample.m4a` | 10 s of the approved voice (with music under it), for tools that accept a voice sample. |
| `references/original-zappie.jpg` | The original Zappie, where the orange hair and wire veins come from. |
| `references/family-style-timmie.jpg` | The KnowAll agent family style (Timmie). |
| `designs/zaplie-designs-grid.jpg` | Every design explored, with M1 marked as approved. |
| `prompts/images.md` | The exact image prompts and commands behind the grid. |
| `prompts/video-*.txt` | The prompts for both videos. |
| `scripts/omni_video.py` | Generates or extends a Gemini Omni video. |
| `video/zaplie-funk.mp4` | 10 s: dancing on a disco floor, zapping bulbs (no dialogue). |
| `video/zaplie-club.mp4` | 20 s: robot club, with his voice and catchphrases. |

## Making a video

The script reads the Gemini key from `~/.config/google/gemini_api_key` and never
prints it. Generate a 10 s clip, then extend it with the interaction id the first
run prints:

```sh
S=assets/agent/scripts/omni_video.py
P=assets/agent/prompts
python3 -I $S --prompt-file $P/video-club-part1.txt \
  --ref assets/agent/references/zaplie-identity.jpg --out part1.mp4
python3 -I $S --prompt-file $P/video-club-part2-extend.txt \
  --ref assets/agent/references/zaplie-identity.jpg \
  --previous <interaction id> --out club.mp4   # returns the full 20 s
```

## Character block

> Zaplie, a dark gunmetal robot with a rounded dome head, a wide dark visor with
> two big round glowing orange eyes and no mouth, round headphone-style ear discs,
> a tall fiery glowing orange mohawk of wire strands, an orange lightning-bolt zap
> icon on his chest and a brass nameplate reading ZAPLIE. There is exactly ONE
> Zaplie; he never splits, duplicates or changes design.

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
