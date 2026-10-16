#!/usr/bin/env python3
"""Generate one video with Gemini Omni (Interactions API) from reference images.

usage: omni_video.py --prompt-file p.txt --ref a.png [--ref b.png] --out clip.mp4
       [--resolution 720p] [--aspect 16:9] [--previous ID] [--delivery inline|uri]
Large videos (1080p and 4k) use URI delivery by default: the API hosts the file and
the script waits until it is ACTIVE before downloading it.
The key is read from ~/.config/google/gemini_api_key and never printed.
"""
import argparse, base64, json, mimetypes, re, sys, time, urllib.request, urllib.error
from pathlib import Path
from urllib.parse import urlsplit

API_HOST = "generativelanguage.googleapis.com"
API = f"https://{API_HOST}/v1beta/interactions"
MODEL = "gemini-omni-1.1-flash"


class KeepKeyOnHost(urllib.request.HTTPRedirectHandler):
    """Follow redirects, but drop the API key when one leads to another host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        """Build the redirected request as usual, without the API key if the host changes."""
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None and urlsplit(newurl).netloc != urlsplit(req.full_url).netloc:
            new.remove_header("X-goog-api-key")
        return new


opener = urllib.request.build_opener(KeepKeyOnHost)

ap = argparse.ArgumentParser()
ap.add_argument("--prompt-file", type=Path, required=True)
ap.add_argument("--ref", type=Path, action="append", default=[])
ap.add_argument("--out", type=Path, required=True)
ap.add_argument("--resolution", default="720p")
ap.add_argument("--aspect", default="16:9")
ap.add_argument("--previous", help="interaction id to extend/edit")
ap.add_argument("--delivery", choices=("inline", "uri"),
                help="default: uri for 1080p and 4k, inline otherwise")
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
delivery = args.delivery or ("uri" if args.resolution in ("1080p", "4k") else "inline")
if delivery == "uri":
    body["response_format"]["delivery"] = "uri"

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
    uri = v["uri"]
    # Only send the key to the Gemini API itself.
    loc = urlsplit(uri)
    if loc.scheme != "https" or loc.hostname != API_HOST:
        sys.exit(f"Video URI is not on {API_HOST}; download it manually: {uri}")
    # The URI may be a download link (".../files/ID:download?alt=media"), which returns video
    # bytes, so poll the file's status endpoint instead until it is ACTIVE.
    m = re.search(r"/files/([A-Za-z0-9_-]+)", uri)
    if not m:
        sys.exit(f"Unrecognised video URI; download it manually: {uri}")
    status_url = f"https://generativelanguage.googleapis.com/v1beta/files/{m.group(1)}"
    for _ in range(60):
        with opener.open(urllib.request.Request(status_url, headers={"x-goog-api-key": key}),
                         timeout=60) as r:
            meta = json.load(r)
        state = (meta.get("file") or meta).get("state", "ACTIVE")
        if state == "ACTIVE":
            break
        if state == "FAILED":
            sys.exit(f"Hosted video failed to process: {uri}")
        time.sleep(5)
    else:
        sys.exit(f"Hosted video still not ACTIVE after 5 minutes; download it later: {uri}")
    download = uri if "alt=media" in uri else uri + ("&" if "?" in uri else "?") + "alt=media"
    dl = urllib.request.Request(download, headers={"x-goog-api-key": key})
    with opener.open(dl, timeout=300) as r:
        args.out.write_bytes(r.read())
print(args.out, "interaction:", resp.get("id"), "usage:", json.dumps(resp.get("usage", {})))
