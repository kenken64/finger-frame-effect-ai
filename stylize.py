#!/usr/bin/env python3
"""Restyle a video through OpenRouter using FLUX Video Edit.

The whole clip is regenerated per the prompt while motion and framing are
preserved, so the result stays aligned with the original footage and
composite.py can use the finger frame as a window over it. Output duration
and size follow the source clip, so no duration/size parameters are sent.
Seedance 2.0 was the previous model but its input moderation rejects any
video containing a real person, which breaks this app's core use case.

Usage:
    export OPENROUTER_API_KEY=...   # https://openrouter.ai/keys
    python stylize.py finger-effect-raw.mp4 -o stylized.mp4

Docs: https://openrouter.ai/docs/guides/overview/multimodal/video-generation
"""

import argparse
import mimetypes
import os
import sys
import time

import requests
import cv2

API_BASE = "https://openrouter.ai/api/v1"
MODEL = "black-forest-labs/flux-video-edit"
# BFL content filter: 0 strictest, 6 most permissive (default 2). Raised so
# ordinary footage of yourself passes. Forwarded only when routed to BFL.
SAFETY_TOLERANCE = 4
DEFAULT_PROMPT = (
    "Transform the person into a 3D animated movie character (stylized CGI "
    "animation look, expressive big eyes, soft lighting). This is a strict "
    "pixel-aligned edit of the source video: keep the same pose, motion, "
    "timing, clothing colors, and background. The camera must not change — "
    "no zoom, no crop, no recentering, and no change to the field of view. "
    "The person's face and body must stay at exactly the same position and "
    "size in the frame as the source: eyes, nose, and mouth must remain at "
    "the same screen coordinates in every frame. Match the facial "
    "expression exactly, frame by frame: preserve the exact degree of "
    "mouth openness at every moment — if the mouth is slightly open and "
    "still, keep it slightly open and still; do not close it, and do not "
    "add talking or any mouth movement that is not in the source. Mirror "
    "blinks, gaze direction, and eyebrow position at the same moments as "
    "the source. Change only the visual style, nothing about the geometry, "
    "composition, or performance."
)


def check_duration(path):
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    frames = cap.get(cv2.CAP_PROP_FRAME_COUNT)
    cap.release()
    duration = frames / fps if fps else 0
    if not 4 <= duration <= 15:
        sys.exit(f"Use a 4–15 second clip (got {duration:.1f}s)")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("video", nargs="?", default="finger-effect-raw.mp4")
    ap.add_argument("-o", "--output", default="stylized.mp4")
    ap.add_argument("-p", "--prompt", default=DEFAULT_PROMPT)
    args = ap.parse_args()

    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        sys.exit("Set OPENROUTER_API_KEY first — https://openrouter.ai/keys")
    if not os.path.exists(args.video):
        sys.exit(f"Input video not found: {args.video}")

    mime = mimetypes.guess_type(args.video)[0] or "video/mp4"
    check_duration(args.video)
    print("Uploading a temporary HTTPS copy …")
    with open(args.video, "rb") as source:
        upload = requests.post(
            "https://uguu.se/upload.php",
            files={"files[]": (os.path.basename(args.video), source, mime)},
            timeout=120,
        )
    upload.raise_for_status()
    video_url = upload.json()["files"][0]["url"]

    headers = {"Authorization": f"Bearer {key}"}
    print(f"Generating with {MODEL} (typically a few minutes) …")
    response = requests.post(
        f"{API_BASE}/videos",
        headers=headers,
        json={
            "model": MODEL,
            "prompt": args.prompt,
            "input_references": [
                {"type": "video_url", "video_url": {"url": video_url}}
            ],
            "provider": {
                "options": {
                    "black-forest-labs": {"safety_tolerance": SAFETY_TOLERANCE}
                }
            },
        },
        timeout=120,
    )
    response.raise_for_status()
    job = response.json()

    poll_url = job.get("polling_url") or f"/api/v1/videos/{job['id']}"
    if poll_url.startswith("/"):
        poll_url = "https://openrouter.ai" + poll_url
    waited = 0
    while job.get("status", "").lower() in (
        "pending", "in_progress", "processing", "running", "queued"
    ) and waited < 900:
        time.sleep(5)
        waited += 5
        poll = requests.get(poll_url, headers=headers, timeout=30)
        poll.raise_for_status()
        job = poll.json()
        print(f"  … {waited}s ({job.get('status', 'working')})")

    if job.get("status") != "completed":
        sys.exit(f"Generation failed: {job.get('error') or job.get('status')}")

    urls = job.get("unsigned_urls") or []
    content_url = urls[0] if urls else f"{API_BASE}/videos/{job['id']}/content"
    print("Downloading result …")
    result = requests.get(content_url, headers=headers, timeout=120)
    result.raise_for_status()
    with open(args.output, "wb") as out:
        out.write(result.content)

    print(f"Done: {args.output}")


if __name__ == "__main__":
    main()
