import {
  HandLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

const WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

const OPENROUTER_BASE = "/api/openrouter";
const OPENROUTER_MODEL = "black-forest-labs/flux-video-edit";
// BFL content filter: 0 is strictest, 6 most permissive (default 2). Raised
// so ordinary footage of yourself passes; only forwarded when the job is
// routed to the black-forest-labs provider.
const FLUX_SAFETY_TOLERANCE = 4;
const STYLES = {
  movie3d:
    "Transform the person into a 3D animated movie character (stylized CGI " +
    "animation look, expressive big eyes, soft lighting).",
  anime:
    "Redraw the video as a hand-drawn anime with clean line art, cel " +
    "shading, and vibrant colors.",
  clay: "Transform the scene into claymation stop-motion with visible clay texture.",
  watercolor:
    "Repaint the video as a soft watercolor painting with loose brushwork.",
};
const PROMPT_SUFFIX =
  " This is a strict pixel-aligned edit of the source video: keep the same " +
  "pose, motion, timing, clothing colors, and background. The camera must " +
  "not change — no zoom, no crop, no recentering, and no change to the " +
  "field of view. The person's face and body must stay at exactly the same " +
  "position and size in the frame as the source: eyes, nose, and mouth must " +
  "remain at the same screen coordinates in every frame. Match the facial " +
  "expression exactly, frame by frame: preserve the exact degree of mouth " +
  "openness at every moment — if the mouth is slightly open and still, keep " +
  "it slightly open and still; do not close it, and do not add talking or " +
  "any mouth movement that is not in the source. Mirror blinks, gaze " +
  "direction, and eyebrow position at the same moments as the source. " +
  "Change only the visual style, nothing about the geometry, composition, " +
  "or performance.";

const WRIST = 0, THUMB_TIP = 4, INDEX_TIP = 8, MIDDLE_MCP = 9;

// Tracking constants — same audited pipeline as the live web app.
const MAX_LOST_FRAMES = 25;
const JUMP_CONFIRM_FRAMES = 2;

const orig = document.getElementById("orig");
const sty = document.getElementById("sty");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");
const stage = document.getElementById("stage");
const drop = document.getElementById("drop");
const btnGenerate = document.getElementById("btn-generate");
const btnPlaceholder = document.getElementById("btn-placeholder");
const btnPlay = document.getElementById("btn-play");
const btnExport = document.getElementById("btn-export");

let landmarker = null;
let videoFile = null;
let haveAI = false;        // stylized video generated through OpenRouter
let usePlaceholder = false; // hue-shift stand-in for keyless testing
let corners = null;
let presence = 0;
let frameActive = false;
let lostFrames = 0;
let jumpFrames = 0;
let recorder = null;
let exporting = false;

function status(msg) {
  statusEl.textContent = msg;
  // Messages ending in an ellipsis are in-progress — show the spinner.
  statusEl.classList.toggle("working", /…\s*$/.test(msg));
}

// ---- key + style panel ----
const keyInput = document.getElementById("openrouter-key");
const keyRemember = document.getElementById("openrouter-remember");
const styleSelect = document.getElementById("style-select");
const styleCustom = document.getElementById("style-custom");

keyInput.value =
  localStorage.getItem("openrouter-key") || sessionStorage.getItem("openrouter-key") || "";
keyRemember.checked = !!localStorage.getItem("openrouter-key");
styleSelect.value = localStorage.getItem("ai-style") || "movie3d";
styleCustom.value = localStorage.getItem("ai-style-custom") || "";
styleCustom.classList.toggle("hidden", styleSelect.value !== "custom");
styleSelect.addEventListener("change", () => {
  styleCustom.classList.toggle("hidden", styleSelect.value !== "custom");
  localStorage.setItem("ai-style", styleSelect.value);
});
styleCustom.addEventListener("change", () =>
  localStorage.setItem("ai-style-custom", styleCustom.value)
);
// Header values are Latin-1 only, so a key pasted with invisible Unicode
// (zero-width spaces, BOM, non-breaking spaces) makes fetch() throw.
function cleanKey(raw) {
  return raw.replace(/[\s\u200b-\u200d\ufeff]/g, "");
}
function saveKey() {
  const key = cleanKey(keyInput.value);
  keyInput.value = key;
  localStorage.removeItem("openrouter-key");
  sessionStorage.removeItem("openrouter-key");
  if (key) (keyRemember.checked ? localStorage : sessionStorage).setItem("openrouter-key", key);
  return key;
}
function prompt() {
  const style =
    styleSelect.value === "custom" && styleCustom.value.trim()
      ? styleCustom.value.trim()
      : STYLES[styleSelect.value] || STYLES.movie3d;
  return style + PROMPT_SUFFIX;
}

// ---- video loading ----
document.getElementById("file").addEventListener("change", (e) => {
  if (e.target.files[0]) loadVideo(e.target.files[0]);
});
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  if (e.dataTransfer.files[0]) loadVideo(e.dataTransfer.files[0]);
});

async function loadVideo(file) {
  videoFile = file;
  haveAI = false;
  usePlaceholder = false;
  btnPlay.disabled = true;
  btnExport.disabled = true;
  orig.src = URL.createObjectURL(file);
  await new Promise((res) => (orig.onloadedmetadata = res));
  canvas.width = orig.videoWidth;
  canvas.height = orig.videoHeight;
  stage.style.display = "flex";
  drop.classList.add("compact");
  drawPoster();
  status(
    `Loaded ${file.name} (${orig.videoWidth}×${orig.videoHeight}, ` +
    `${orig.duration.toFixed(1)}s). Generate the AI video, or test with the placeholder.`
  );
  if (!landmarker) initLandmarker();
}

function drawPoster() {
  orig.currentTime = 0.01;
  orig.onseeked = () => {
    ctx.drawImage(orig, 0, 0, canvas.width, canvas.height);
    orig.onseeked = null;
  };
}

async function initLandmarker() {
  status("Loading hand tracker…");
  const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
  landmarker = await HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
    runningMode: "VIDEO",
    numHands: 2,
    minHandDetectionConfidence: 0.3,
    minHandPresenceConfidence: 0.3,
    minTrackingConfidence: 0.3,
  });
  status("Hand tracker ready.");
}

// Dev hook: render one frame at time t (seconds) without realtime playback —
// lets automated tests drive the pipeline in environments that suspend media.
window.__step = (t) =>
  new Promise((resolve) => {
    orig.onseeked = () => {
      orig.onseeked = null;
      ctx.drawImage(orig, 0, 0, canvas.width, canvas.height);
      const res = landmarker.detectForVideo(orig, performance.now());
      updateTracker(res.landmarks || []);
      if (corners && presence > 0.01) {
        drawWindow(corners);
        drawOutline(corners, t);
      }
      resolve({
        presence: +presence.toFixed(2),
        corners: corners
          ? corners.map((p) => [Math.round(p.x), Math.round(p.y)])
          : null,
      });
    };
    orig.currentTime = t;
  });

// Dev convenience: ?src=file.mov loads a local file from the dev server.
const srcParam = new URLSearchParams(location.search).get("src");
if (srcParam) {
  fetch(srcParam)
    .then((r) => r.blob())
    .then((b) => loadVideo(new File([b], srcParam, { type: "video/quicktime" })));
}

// ---- AI generation (OpenRouter / FLUX Video Edit, BYOK) ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openRouterFetch(key, path, init = {}) {
  if (/^https?:/.test(path)) path = new URL(path).pathname.replace(/^\/api\/v1\//, "");
  const url = `${OPENROUTER_BASE}/${path.replace(/^\//, "")}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "X-OpenRouter-Key": key,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json())?.error?.message || detail;
    } catch {}
    throw new Error(`${res.status}: ${detail.slice(0, 500)}`);
  }
  return res.json();
}

function isPending(job) {
  const s = (job.status || "").toLowerCase();
  return ["pending", "in_progress", "processing", "running", "queued"].some((k) =>
    s.includes(k)
  );
}

async function compressVideo(file) {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.src = URL.createObjectURL(file);
  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = () => reject(new Error("could not read the video for compression"));
  });

  const [width, height] = outputSize(video.videoWidth, video.videoHeight)
    .split("x").map(Number);
  const work = document.createElement("canvas");
  work.width = width;
  work.height = height;
  const workCtx = work.getContext("2d");
  const stream = work.captureStream(30);
  const mimeType = [
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ].find((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType) throw new Error("this browser cannot compress video");

  // 4 Mbps keeps a 15-second clip comfortably below the 15 MB upload limit.
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 4_000_000,
  });
  const chunks = [];
  recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
  const complete = new Promise((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
    recorder.onerror = () => reject(recorder.error || new Error("video compression failed"));
  });

  let drawing = true;
  const draw = () => {
    if (!drawing) return;
    workCtx.drawImage(video, 0, 0, width, height);
    requestAnimationFrame(draw);
  };
  recorder.start(1000);
  draw();
  await video.play();
  await new Promise((resolve) => {
    video.onended = resolve;
  });
  drawing = false;
  recorder.stop();
  const blob = await complete;
  stream.getTracks().forEach((track) => track.stop());
  URL.revokeObjectURL(video.src);
  const extension = mimeType.startsWith("video/mp4") ? "mp4" : "webm";
  return new File([blob], `openrouter-input.${extension}`, { type: mimeType });
}

async function uploadTemporaryVideo(file) {
  const response = await fetch("/api/upload", {
    method: "POST",
    headers: {
      "Content-Type": file.type || "video/mp4",
      // Percent-encoded because header values must be Latin-1; the server
      // decodes it, so names with CJK, accents, or emoji survive the trip.
      "X-Filename": encodeURIComponent(file.name || "input.mp4"),
    },
    body: file,
  });
  if (!response.ok) throw new Error(`temporary upload failed: ${response.status}`);
  const result = await response.json();
  if (!result?.url) throw new Error("temporary upload returned no URL");
  return result.url;
}

function outputSize(width, height) {
  const sizes = [
    [480, 480], [480, 640], [480, 854], [640, 480],
    [854, 480], [1120, 480],
  ];
  const ratio = width / height;
  return sizes.reduce((best, size) =>
    Math.abs(size[0] / size[1] - ratio) < Math.abs(best[0] / best[1] - ratio)
      ? size : best
  ).join("x");
}

btnGenerate.addEventListener("click", async () => {
  const key = saveKey();
  if (!key) {
    status("Add your OpenRouter key above first (or use the placeholder).");
    keyInput.focus();
    return;
  }
  if (!/^[\x20-\x7e]+$/.test(key)) {
    status("⚠️ That OpenRouter key has characters it cannot send — retype it.");
    keyInput.focus();
    return;
  }
  if (!videoFile) return;
  btnGenerate.disabled = true;
  try {
    if (orig.duration < 4 || orig.duration > 15) {
      status("⚠️ Use a clip between 4 and 15 seconds.");
      return;
    }
    let uploadFile = videoFile;
    if (uploadFile.size > 15 * 1024 * 1024) {
      status("Video exceeds 15 MB — compressing to 480p…");
      uploadFile = await compressVideo(uploadFile);
      if (uploadFile.size > 15 * 1024 * 1024) {
        throw new Error("compressed video is still over 15 MB; use a shorter clip");
      }
      status(`Compressed to ${(uploadFile.size / 1024 / 1024).toFixed(1)} MB. Encoding…`);
    } else {
      status("Encoding video…");
    }
    status("Uploading a temporary HTTPS copy for OpenRouter…");
    const videoUrl = await uploadTemporaryVideo(uploadFile);

    status("Submitting to OpenRouter — this can take a few minutes…");
    let job = await openRouterFetch(key, "videos", {
      method: "POST",
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        prompt: prompt(),
        input_references: [
          { type: "video_url", video_url: { url: videoUrl } },
        ],
        provider: {
          options: {
            "black-forest-labs": { safety_tolerance: FLUX_SAFETY_TOLERANCE },
          },
        },
      }),
    });
    console.log("OpenRouter job:", job);

    const pollUrl = job.polling_url || `videos/${job.id}`;
    let waited = 0;
    while (isPending(job) && waited < 900) {
      await sleep(5000);
      waited += 5;
      job = await openRouterFetch(key, pollUrl);
      status(`Generating… (${waited}s, status: ${job.status || "working"})`);
    }
    if (job.status !== "completed") {
      throw new Error(job.error?.message || job.error || `generation ${job.status || "timed out"}`);
    }

    status("Downloading result…");
    const res = await fetch(`${OPENROUTER_BASE}/videos/${job.id}/content`, {
      headers: { "X-OpenRouter-Key": key },
    });
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    const blob = await res.blob();

    sty.src = URL.createObjectURL(blob);
    await new Promise((res) => (sty.onloadedmetadata = res));
    haveAI = true;
    usePlaceholder = false;
    btnPlay.disabled = false;
    btnExport.disabled = false;
    status("AI video ready — preview or export.");
  } catch (err) {
    console.error(err);
    status("⚠️ Generation failed: " + (err.message || err));
  } finally {
    btnGenerate.disabled = false;
  }
});

btnPlaceholder.addEventListener("click", () => {
  if (!videoFile) return;
  usePlaceholder = true;
  haveAI = false;
  btnPlay.disabled = false;
  btnExport.disabled = false;
  status("Placeholder style active (hue shift) — preview or export, no key needed.");
});

// ---- tracking (ported from finger-frame-effect main.js) ----
function toPixel(lm) {
  return { x: lm.x * canvas.width, y: lm.y * canvas.height };
}
function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function lerpPt(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a / 2);
}

function computeQuad(hands) {
  if (hands.length !== 2) return null;
  const info = hands.map((lm) => ({
    index: toPixel(lm[INDEX_TIP]),
    thumb: toPixel(lm[THUMB_TIP]),
    wristX: toPixel(lm[WRIST]).x,
    scale: dist(toPixel(lm[WRIST]), toPixel(lm[MIDDLE_MCP])) + 1,
  }));
  const needed = frameActive ? 0.2 : 0.75;
  for (const hd of info) {
    if (dist(hd.thumb, hd.index) < hd.scale * needed) return null;
  }
  info.sort((a, b) => a.wristX - b.wristX);
  const [A, B] = info;
  const pts = [A.index, B.index, B.thumb, A.thumb];
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
  const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
  const hull = [...pts].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx)
  );
  const minArea = frameActive ? 0.0005 : 0.005;
  if (polygonArea(hull) < canvas.width * canvas.height * minArea) return null;
  return pts;
}

function updateTracker(hands) {
  const target = computeQuad(hands);
  if (target) {
    if (!corners) {
      lostFrames = 0;
      frameActive = true;
      jumpFrames = 0;
      corners = target;
      presence = Math.min(1, presence + 0.12);
    } else {
      const moved = target.reduce((s, p, i) => s + dist(p, corners[i]), 0) / 4;
      if (moved > canvas.width * 0.3 && ++jumpFrames < JUMP_CONFIRM_FRAMES) {
        if (++lostFrames > MAX_LOST_FRAMES) presence = Math.max(0, presence - 0.05);
      } else {
        lostFrames = 0;
        frameActive = true;
        jumpFrames = 0;
        const alpha = Math.min(0.85, Math.max(0.35, moved / (canvas.width * 0.05)));
        corners = corners.map((c, i) => lerpPt(c, target[i], alpha));
        presence = Math.min(1, presence + 0.12);
      }
    }
  } else if (corners && ++lostFrames <= MAX_LOST_FRAMES) {
    presence = Math.min(1, presence + 0.12);
  } else {
    presence = Math.max(0, presence - 0.05);
    if (presence === 0) {
      corners = null;
      frameActive = false;
      jumpFrames = 0;
    }
  }
}

// ---- rendering ----
function quadPath(q) {
  ctx.beginPath();
  ctx.moveTo(q[0].x, q[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(q[i].x, q[i].y);
  ctx.closePath();
}

function drawWindow(q) {
  ctx.save();
  quadPath(q);
  ctx.clip();
  ctx.globalAlpha = presence;
  if (haveAI) {
    ctx.drawImage(sty, 0, 0, canvas.width, canvas.height);
  } else {
    ctx.filter = "hue-rotate(140deg) saturate(1.7) contrast(1.15)";
    ctx.drawImage(orig, 0, 0, canvas.width, canvas.height);
    ctx.filter = "none";
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

function drawOutline(q, t) {
  ctx.save();
  ctx.globalAlpha = presence;
  quadPath(q);
  ctx.setLineDash([10, 8]);
  ctx.lineDashOffset = -t * 40;
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 6;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
  ctx.shadowBlur = 0;
  q.forEach((p, i) => {
    const r = 7 + Math.sin(t * 3 + i * 1.5) * 1.5;
    const halo = (t * 0.8 + i * 0.25) % 1;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + halo * 14, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,255,255,${0.5 * (1 - halo) * presence})`;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });
  ctx.restore();
}

let lastVideoTime = -1;
function loop() {
  if (!orig.paused && !orig.ended) requestAnimationFrame(loop);

  ctx.drawImage(orig, 0, 0, canvas.width, canvas.height);

  if (landmarker && orig.currentTime !== lastVideoTime) {
    lastVideoTime = orig.currentTime;
    const res = landmarker.detectForVideo(orig, performance.now());
    updateTracker(res.landmarks || []);
  }

  // Keep the stylized video in step with the original.
  if (haveAI && Math.abs(sty.currentTime - orig.currentTime) > 0.15) {
    sty.currentTime = orig.currentTime;
  }

  if (corners && presence > 0.01) {
    drawWindow(corners);
    drawOutline(corners, orig.currentTime);
  }
}

async function playThrough() {
  corners = null;
  presence = 0;
  frameActive = false;
  lostFrames = 0;
  jumpFrames = 0;
  orig.currentTime = 0;
  if (haveAI) {
    sty.currentTime = 0;
    sty.play();
  }
  await orig.play();
  requestAnimationFrame(loop);
}

btnPlay.addEventListener("click", () => {
  if (exporting) return;
  playThrough();
  status("Previewing…");
});

// ---- export (canvas capture -> webm download) ----
btnExport.addEventListener("click", async () => {
  if (exporting) return;
  exporting = true;
  btnExport.disabled = true;
  btnPlay.disabled = true;
  status("Exporting — playing the video through once…");

  const stream = canvas.captureStream(30);
  // Prefer MP4 where the browser can record it (Safari, newer Chrome);
  // fall back to WebM elsewhere.
  const mime = [
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm",
  ].find((m) => MediaRecorder.isTypeSupported(m)) || "video/webm";
  const isMp4 = mime.startsWith("video/mp4");
  recorder = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: 10_000_000,
  });
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    const ext = isMp4 ? "mp4" : "webm";
    const blob = new Blob(chunks, { type: isMp4 ? "video/mp4" : "video/webm" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `finger-frame-ai.${ext}`;
    a.click();
    status(
      `Exported finger-frame-ai.${ext}.` +
      (isMp4
        ? ""
        : " (This browser records WebM — convert with: ffmpeg -i finger-frame-ai.webm -c:v libx264 out.mp4)")
    );
    exporting = false;
    btnExport.disabled = false;
    btnPlay.disabled = false;
  };

  orig.onended = () => {
    orig.onended = null;
    recorder.stop();
  };
  recorder.start();
  await playThrough();
});
