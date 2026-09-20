#!/usr/bin/env python3
"""Serve the app and proxy temporary video uploads to an HTTPS file host."""

import json
import os
import re
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import requests


MAX_UPLOAD = 16 * 1024 * 1024


class AppHandler(SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path == "/api/openrouter/videos":
            self.proxy_openrouter("POST", "videos")
            return
        if self.path != "/api/upload":
            self.send_error(404)
            return

        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_UPLOAD:
            self.send_error(413, "Upload must be between 1 byte and 16 MB")
            return

        filename = os.path.basename(self.headers.get("X-Filename", "input.mp4"))
        mime = self.headers.get("Content-Type", "video/mp4").split(";", 1)[0]
        data = self.rfile.read(length)
        try:
            response = requests.post(
                "https://uguu.se/upload.php",
                files={"files[]": (filename, data, mime)},
                timeout=120,
            )
            response.raise_for_status()
            result = response.json()
            url = result["files"][0]["url"]
        except (requests.RequestException, KeyError, IndexError, ValueError) as exc:
            self.send_error(502, f"Temporary upload failed: {exc}")
            return

        payload = json.dumps({"url": url}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        match = re.fullmatch(r"/api/openrouter/videos/([\w-]+)(/content)?", self.path)
        if match:
            suffix = "/content" if match.group(2) else ""
            self.proxy_openrouter("GET", f"videos/{match.group(1)}{suffix}")
            return
        super().do_GET()

    def proxy_openrouter(self, method, path):
        key = self.headers.get("X-OpenRouter-Key")
        if not key:
            self.send_error(401, "Missing OpenRouter key")
            return
        headers = {"Authorization": f"Bearer {key}"}
        data = None
        if method == "POST":
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 1024 * 1024:
                self.send_error(413, "Invalid request size")
                return
            data = self.rfile.read(length)
            headers["Content-Type"] = "application/json"
        try:
            response = requests.request(
                method,
                f"https://openrouter.ai/api/v1/{path}",
                headers=headers,
                data=data,
                timeout=120,
            )
        except requests.RequestException as exc:
            self.send_error(502, f"OpenRouter request failed: {exc}")
            return

        self.send_response(response.status_code)
        self.send_header("Content-Type", response.headers.get("Content-Type", "application/octet-stream"))
        self.send_header("Content-Length", str(len(response.content)))
        self.end_headers()
        self.wfile.write(response.content)


if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8124"))
    print(f"Serving Finger Frame AI at http://{host}:{port}/")
    ThreadingHTTPServer((host, port), AppHandler).serve_forever()
