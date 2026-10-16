#!/usr/bin/env python3
"""Generate a music clip with Lyria via the Interactions API.

usage: lyria_music.py MODEL PROMPT OUT.mp3   (e.g. lyria-3-clip-preview: always 30 s)
The key is read from ~/.config/google/gemini_api_key and never printed.
"""
import base64, json, sys, urllib.request, urllib.error
from pathlib import Path
model, prompt, out = sys.argv[1], sys.argv[2], Path(sys.argv[3])
key = (Path.home() / ".config/google/gemini_api_key").read_text().strip()
req = urllib.request.Request("https://generativelanguage.googleapis.com/v1beta/interactions",
    data=json.dumps({"model": model, "input": prompt}).encode(), method="POST",
    headers={"Content-Type": "application/json", "x-goog-api-key": key})
try:
    with urllib.request.urlopen(req, timeout=600) as r:
        resp = json.load(r)
except urllib.error.HTTPError as e:
    sys.exit(f"HTTP {e.code}: {e.read().decode()[:1500]}")
blocks = [c for s in resp.get("steps", []) for c in (s.get("content") or []) if isinstance(c, dict) and c.get("type") == "audio"]
if not blocks:
    Path(str(out) + ".response.json").write_text(json.dumps(resp, indent=2)[:20000]); sys.exit("no audio; see response.json")
out.write_bytes(base64.b64decode(blocks[0]["data"]))
print(out, blocks[0].get("mime_type"), "usage:", json.dumps(resp.get("usage", {})))
