#!/usr/bin/env python3
"""Generate one video with Gemini Omni (Interactions API) from reference images.

usage: omni_video.py --prompt-file p.txt --ref a.png [--ref b.png] --out clip.mp4
       [--resolution 720p] [--aspect 16:9]
The key is read from ~/.config/google/gemini_api_key and never printed.
"""
import argparse, base64, json, mimetypes, sys, urllib.request, urllib.error
from pathlib import Path

API = "https://generativelanguage.googleapis.com/v1beta/interactions"
MODEL = "gemini-omni-1.1-flash"

ap = argparse.ArgumentParser()
ap.add_argument("--prompt-file", type=Path, required=True)
ap.add_argument("--ref", type=Path, action="append", default=[])
ap.add_argument("--out", type=Path, required=True)
ap.add_argument("--resolution", default="720p")
ap.add_argument("--aspect", default="16:9")
ap.add_argument("--previous", help="interaction id to extend/edit")
args = ap.parse_args()

key = (Path.home() / ".config/google/gemini_api_key").read_text().strip()
parts = [{"type": "image",
          "mime_type": mimetypes.guess_type(r)[0] or "image/png",
          "data": base64.b64encode(r.read_bytes()).decode()} for r in args.ref]
parts.append({"type": "text", "text": args.prompt_file.read_text()})
body = {"model": MODEL, "input": parts,
        "response_format": {"type": "video", "aspect_ratio": args.aspect,
                            "resolution": args.resolution}}
if args.previous:
    body["previous_interaction_id"] = args.previous

req = urllib.request.Request(API, data=json.dumps(body).encode(), method="POST",
                             headers={"Content-Type": "application/json",
                                      "x-goog-api-key": key})
try:
    with urllib.request.urlopen(req, timeout=900) as r:
        resp = json.load(r)
except urllib.error.HTTPError as e:
    sys.exit(f"HTTP {e.code}: {e.read().decode()[:2000]}")

videos = [c for s in resp.get("steps", []) for c in (s.get("content") or [])
          if isinstance(c, dict) and c.get("type") == "video"]
if not videos:
    # Save the reply minus any large blobs, for debugging.
    Path(str(args.out) + ".response.json").write_text(json.dumps(resp, indent=2)[:20000])
    sys.exit("No video in response; see .response.json")
v = videos[0]
if v.get("data"):
    args.out.write_bytes(base64.b64decode(v["data"]))
elif v.get("uri"):
    dl = urllib.request.Request(v["uri"] + ("&" if "?" in v["uri"] else "?") + "alt=media",
                                headers={"x-goog-api-key": key})
    with urllib.request.urlopen(dl, timeout=300) as r:
        args.out.write_bytes(r.read())
print(args.out, "interaction:", resp.get("id"), "usage:", json.dumps(resp.get("usage", {})))
