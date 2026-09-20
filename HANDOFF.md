# Coding Agent Handoff

Updated: 2026-09-20 (Asia/Singapore)

## Goal

Migrate the recorded-video restyling flow from Gemini Omni Flash to OpenRouter,
using ByteDance Seedance 2.0 at 480p. Preserve the existing MediaPipe finger-frame
tracking, compositing, preview, and export behavior.

## Current state

- The browser app uses OpenRouter model `black-forest-labs/flux-video-edit`.
- FLUX Video Edit derives output duration/size from the source clip, so no
  `duration`/`size` parameters are sent; `safety_tolerance` is forwarded via
  `provider.options["black-forest-labs"]`.
- Input clips are limited to 4–15 seconds (app-level rule kept from Seedance;
  also bounds cost at 3¢ per output second).
- Input clips over 15 MB are downscaled and re-encoded in the browser at 4 Mbps.
- OpenRouter requires `input_references[].video_url.url` to be a public HTTPS URL;
  it rejects base64/data URLs for video-generation references.
- `server.py` serves the static app and proxies temporary uploads to `uguu.se`.
- `server.py` also proxies OpenRouter submission, polling, and content downloads to
  prevent browser CORS failures.
- The OpenRouter key remains browser-supplied and is forwarded to the local backend
  in the `X-OpenRouter-Key` header. It is not committed to the repository.
- The Python CLI in `stylize.py` uses the same OpenRouter/FLUX Video Edit flow
  and uploads its input directly to `uguu.se`.

## Important security note

An OpenRouter API key was pasted into the conversation. It was **not** written to
repository files or shell commands, but it should be revoked and replaced before
continued use.

Input video is temporarily sent to `uguu.se` to obtain a raw HTTPS URL and is then
processed by OpenRouter/provider infrastructure. The UI and README disclose this.
Do not use sensitive footage unless this data flow is acceptable. A production
version should replace the anonymous temporary host with controlled object storage
and signed, expiring URLs.

## Run the app

Do not use `python -m http.server`; it cannot handle `/api/upload` or the OpenRouter
proxy endpoints.

```powershell
cd D:\Projects\finger-frame-effect-ai
python server.py
```

Open:

```text
http://127.0.0.1:8124/
```

During the latest development session, the old static server remained on port 8124,
so the backend server was temporarily run on port 8125:

```powershell
$env:PORT = "8125"
python server.py
```

and opened at `http://127.0.0.1:8125/`. Ensure only the backend server is used.

## Request flow

1. User selects a 4–15 second video.
2. If the file exceeds 15 MB, `app.js` recompresses it to 480p in the browser.
3. Browser sends the processed bytes to `POST /api/upload`.
4. `server.py` uploads them to `https://uguu.se/upload.php` and returns a raw HTTPS
   video URL.
5. Browser sends the Seedance request to `POST /api/openrouter/videos`.
6. `server.py` forwards it to `https://openrouter.ai/api/v1/videos`.
7. Browser polls `/api/openrouter/videos/{job_id}`.
8. Browser downloads `/api/openrouter/videos/{job_id}/content` through the proxy.
9. Existing MediaPipe tracking and canvas compositing render/export the effect.

## Files changed

- `app.js`
  - Replaced Gemini constants and Interactions API calls.
  - Added OpenRouter async job submission and polling.
  - Added 480p aspect-ratio size selection.
  - Added browser-side compression for files over 15 MB.
  - Added temporary upload and same-origin OpenRouter proxy calls.
- `server.py`
  - New threaded local app server.
  - Implements `POST /api/upload`.
  - Implements OpenRouter submit, poll, and content proxy endpoints.
- `index.html`
  - OpenRouter key fields and Seedance copy.
  - 480p/duration/compression disclosures.
  - Temporary `uguu.se` upload disclosure.
- `stylize.py`
  - Replaced Google GenAI client with OpenRouter requests.
  - Uses temporary HTTPS input upload.
- `requirements.txt`
  - Replaced `google-genai` with `requests`.
- `README.md`
  - Updated model, key, upload, privacy, and server instructions.

## Validation already performed

- `node --check app.js` passes.
- `python -m py_compile server.py stylize.py` passes.
- `git diff --check` passes apart from informational LF-to-CRLF warnings.
- The local server returns HTTP 200.
- `POST /api/upload` was tested with the repository's public `examples/final.mp4`.
- The returned temporary URL was verified as HTTP 200 with `Content-Type: video/mp4`.
- OpenRouter's `/videos` endpoint CORS preflight was checked, but final download is
  still routed through the local server to avoid storage-origin CORS failures.
- No paid OpenRouter generation was intentionally triggered by the coding agent.

## Latest observed errors and fixes

### Real-person input blocked (Seedance)

```text
400: InputVideoSensitiveContentDetected.PrivacyInformation:
The request failed because the input video 'content[1]' may contain real person.
```

Cause: ByteDance's Seedance 2.0 input moderation rejects any video containing a
real person. This is a provider policy, not fixable by prompt, size, or upload
changes. Seedance 2.0-mini/-fast/2.5 share the same ByteDance moderation.

Fix: switched the app and CLI to `black-forest-labs/flux-video-edit`, a
video-edit model that accepts real people; billed 3¢ per output second with
output duration/size derived from the source. `safety_tolerance` (0–6, raised
to 4) is passed through `provider.options`.

### Invalid reference URL

```text
400: Invalid reference URL: input_references[0].video_url.url:
Only HTTPS URLs are allowed
```

Cause: the first implementation used a base64 data URL.

Fix: temporary upload now provides a raw public HTTPS video URL.

### Failed to fetch on port 8124

```text
:8124/api/upload net::ERR_CONNECTION_RESET
TypeError: Failed to fetch
```

Cause: port 8124 was still running the original `python -m http.server`, which does
not implement `POST /api/upload`.

Fix: use `server.py`, most recently at `http://127.0.0.1:8125/`.

## Next steps

1. Stop the obsolete static server on port 8124 and restart `server.py` on 8124, or
   continue consistently on 8125.
2. Hard-refresh the correct URL and verify the browser loads the latest `app.js`.
3. Use a rotated OpenRouter key and a non-sensitive 4–15 second test clip.
4. Observe the status immediately before any failure to identify whether it occurs
   during temporary upload, OpenRouter submission, polling, or content download.
5. Inspect the local server console for the corresponding HTTP request/status.
6. Confirm one complete paid generation and verify output duration/alignment with
   the original before treating the migration as finished.
7. Consider persisting the last completed job ID so a download failure can be
   retried without paying for a second generation.
8. For deployment beyond localhost, replace `uguu.se` with owned storage and deploy
   the proxy backend; GitHub Pages alone cannot run `server.py`.

## Working tree

The migration is currently uncommitted. Preserve unrelated user changes and inspect
with:

```powershell
git status --short
git diff -- README.md app.js index.html requirements.txt stylize.py server.py HANDOFF.md
```
