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
| `images/zaplie-electrified-subtle.jpg` | Subtle electrified hair (the usual): the crest glows brighter with a gentle shimmer. |
| `images/zaplie-electrified.jpg` | Full electrified hair (rare, big moments): crest luminous and buzzing. Usually it is subtler. |
| `prompts/images.md` | The exact prompts and commands behind `images/`. |
| `prompts/video-*.txt` | The prompts for the videos. |
| `prompts/music-funk-bed.txt` | The Lyria prompt for the funk music bed. |
| `scripts/omni_video.py` | Generates or extends a Gemini Omni video. |
| `scripts/lyria_music.py` | Generates a music clip with Lyria. |
| `scripts/make_banner.py` | Builds the repo cover (`CoverImage.png`, 1280×640) from the hero image: title band, Mulish text and LNbits badge. |
| `references/lnbits-badge.png` | The "Powered by LNbits" badge used on the cover. |
| `audio/zaplie-funk-bed.mp3` | 30 s of continuous 80s funk (Lyria, instrumental), for laying under videos. |
| `video/zaplie-funk.mp4` | 10 s: dancing on a disco floor, zapping bulbs (no dialogue). |
| `video/zaplie-club.mp4` | 20 s: robot club, with his voice and catchphrases. |
| `video/zaplie-explainer.mp4` | 20 s: he explains the power of the zap (gratitude, rewards, proof of work, real value, big or small). Approved look; music added separately. |
| `video/zaplie-explainer-preview.gif` | A 6 s animated preview of the explainer, used in the README. |

### What future videos should change

The videos stay in the repo for now, but they don't fully match the current look:

- **Nameplate:** all three show a brass ZAPLIE nameplate on his chest. It has
  been dropped from the look, so new videos and images should leave it off.
- **Hair:** the explainer's hair charges up more wildly at the end than the
  subtle level allows, and the club video's crest blazes. New videos should use
  the subtle level and save the full one for big moments.
- **Mohawk:** the funk and club videos come from an earlier draft with a
  narrower mohawk. The explainer uses the approved look in
  `references/zaplie-identity.jpg`.

## Making a video

Make the video **without music**, then lay the music under it. Video models drop
music in and out under speech; a separately generated track can't. The scripts
read the Gemini key from `~/.config/google/gemini_api_key` and never print it.

1. Generate a 10 s clip whose prompt asks for no music (see
   `prompts/video-explainer-part1.txt`), and check its stills before going on.
2. Extend it with the interaction id the first run printed:

```sh
S=assets/agent/scripts/omni_video.py
P=assets/agent/prompts
python3 -I $S --prompt-file $P/video-explainer-part1.txt \
  --ref assets/agent/references/zaplie-identity.jpg --out part1.mp4 | tee part1.log
ID=$(grep -o 'interaction: [^ ]*' part1.log | cut -d' ' -f2)
python3 -I $S --prompt-file $P/video-explainer-part2-extend.txt \
  --ref assets/agent/references/zaplie-identity.jpg \
  --previous "$ID" --out video.mp4   # returns the full 20 s
```

3. Reuse `audio/zaplie-funk-bed.mp3`, or make a new bed with
   `python3 -I assets/agent/scripts/lyria_music.py lyria-3-clip-preview "$(cat $P/music-funk-bed.txt)" bed.mp3`.
4. Mix it under his voice. The music is turned down 7 dB, dips further while he
   speaks, and fades out over the last 1.5 s (change `20.01` and `st=18.5` for
   other lengths). The picture is copied untouched:

```sh
ffmpeg -i video.mp4 -i assets/agent/audio/zaplie-funk-bed.mp3 -filter_complex \
  "[1:a]aresample=48000,atrim=0:20.01,asetpts=PTS-STARTPTS,afade=t=in:d=0.3,afade=t=out:st=18.5:d=1.5,volume=-7dB[m];\
   [0:a]aresample=48000,asplit=2[v][key];\
   [m][key]sidechaincompress=threshold=0.03:ratio=4:attack=20:release=350[md];\
   [v][md]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]" \
  -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -movflags +faststart final.mp4
```

1080p and 4k videos are too big to return inline, so the script asks the API to
host them and downloads the file when it is ready (`--delivery uri`).

## Character block

> Zaplie: very dark scratched gunmetal with a cool blue-grey sheen, a smooth
> rounded dome head, a wide pill-shaped dark glass visor with two big round
> glowing Bitcoin orange (#F7931A) eyes, NO mouth (the metal below the visor is
> smooth and blank), big round headphone ear discs, a full bushy crest of fiery
> glowing orange wire strands running front to back on top of his head, an
> embossed glowing orange lightning-bolt zap icon on his chest, and NO
> nameplate: no plate, text or letters anywhere on him. There is exactly ONE
> Zaplie; he never splits, duplicates or changes design.

## Electrified hair

His crest reacts to his energy at two levels. Add a level to the shot, not to the
character block.

**Subtle (the usual).** Use it when he's excited or zapping. `images/zaplie-electrified-subtle.jpg` shows it:

> His hair crest charges up with electricity: its glow builds to a more luminous
> Bitcoin orange (#F7931A), and thin, fine, crackling orange arcs flicker and
> dance between the wire strands, with tiny sparks fizzing at the tips (in
> video, a soft electric crackle and buzz). It is clearly electricity, not just
> a light switching on, but toned down: the arcs are small and stay INSIDE the
> crest; nothing flies off his head, no big zigzag bolts, no haze cloud, and the
> crest keeps its normal shape and size.

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

The visor is sacred: it only ever shows his two round orange eyes. In still
images he has no mouth. In videos where he talks, a simple mouth on the metal
**below** the visor is fine; video models add one whenever a character speaks.

> His face is a dark glass visor with exactly TWO separate round glowing orange
> eyes and nothing else. Each eye is a SOLID, evenly glowing orange disc with no
> pupil, no iris, no dark centre and no ring. The eyes are only ever solid round
> discs or squinted happy arcs, never wider, never with pupils, always two
> separate orange eyes on dark glass, even when he is surprised or excited. The
> visor never turns into a screen, never shows a drawn or cartoon face, never
> merges the eyes into a bar. Nothing but the two eyes ever appears inside the
> visor. While he talks, a simple mouth may move on the smooth metal BELOW the
> visor; it never appears inside the visor glass. NO robot in the scene has a
> screen face.

## Music block

> An upbeat, original 1980s funk groove: slap bass, wah-wah guitar, punchy brass
> stabs, a drum machine with handclaps.

## Lessons

- Get the face right in the FIRST clip: extensions continue whatever the opening
  establishes. Check the stills of the first 10 s before paying to extend.
- Whenever he talks on camera, the model gives him a mouth, however the prompt
  is worded. Banning it outright made things worse: the eyes changed shape, and
  once a mouth appeared inside the visor. So allow a mouth below the visor and
  protect the visor instead.
- Don't describe his eyes as pulsing "like a sound meter": the model turned them
  into equaliser bars. Say each eye is a solid, evenly glowing disc with no pupil
  or ring, and don't let the eyes "widen": wide or surprised eyes came out as
  cartoon eyeballs with dark pupils.
- Keep robots with screen faces (TV heads) out of any shot where he speaks: he
  once blended into one. Make other robots look clearly different from him, or they come out as
  copies: the explainer's are smaller, hairless, with white eyes and no ear
  discs or nameplate.
- Even with the subtle wording, the charge-up still flared quite wildly at its
  peak in the explainer. Next time, ask for it to build more slowly and stay
  smaller.
- Subtle hair needs both halves of the description: asking only for "no bolts"
  made it just light up, and asking only for "arcs" sent bolts flying off his head.
- Ask for an original groove, not a named song.
- Music generated inside the video dropped out under his lines in three takes,
  even when the prompt said it must play continuously. Generate the video
  without music and mix in a Lyria track instead. To check a soundtrack, measure
  the bass (below 150 Hz), which his voice barely touches: a music dropout shows
  as a sudden fall of 15 dB or more.
- Omni costs about $0.10 per second at 720p. A 10 s extension also re-reads the
  earlier clip, so it costs about $1.10.
