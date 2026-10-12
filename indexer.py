"""Indexer: watches ./inbox for new camera JPEGs and indexes them.

For each finished JPEG:
  1. photo ID = first 12 hex chars of sha1("filename|DateTimeOriginal")
  2. web copy (long edge 2000 px) and thumbnail (long edge 400 px) in data/
  3. face detection + ArcFace embeddings on the web copy (tiled for small faces)
  4. rows into SQLite; original moved to data/originals/

Polls the folder instead of using filesystem events: simpler, survives
restarts, and naturally catches up on anything that arrived while it was off.
A file is only taken once its size has been stable for STABLE_SECONDS, so a
half-written FTP upload is never read.

Run:  .venv/bin/python indexer.py            (watch forever)
      .venv/bin/python indexer.py --once     (process what's there, then exit)
"""
import argparse
import hashlib
import json
import logging
import os
import shutil
import time
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps

import db

BASE = Path(__file__).resolve().parent
INBOX = BASE / "inbox"
GUEST_INBOX = INBOX / "guest"   # written by the API's /api/upload (+ a .json sidecar each)
DATA = BASE / "data"
WEB_DIR = DATA / "web"
THUMB_DIR = DATA / "thumb"
MID_DIR = DATA / "mid"
FULL_DIR = DATA / "full"      # high-quality copy for the Save button
ORIG_DIR = DATA / "originals"
FAILED_DIR = DATA / "failed"

WEB_LONG_EDGE = 2000
FULL_LONG_EDGE = 3000         # measured: 3000 px @ q92 ≈ 1.3 MB, SSIM 0.98
FULL_QUALITY = 92
THUMB_LONG_EDGE = 400
MID_LONG_EDGE = 900           # gallery tiles on sharp screens (thumb is too soft, web too heavy)
JPEG_QUALITY = 85
POLL_SECONDS = 1.0
STABLE_SECONDS = 1.5
MIN_DET_SCORE = 0.5
MIN_FACE_PX = 24          # ignore faces smaller than this (in web-copy pixels)
TILE_GRID = 2             # 2x2 tiles on top of the whole-image pass
TILE_OVERLAP = 0.2
DET_SIZE = 640
EXTENSIONS = {".jpg", ".jpeg"}
VIDEO_EXT = {".mp4", ".webm", ".mov"}     # guest boomerang clips (guest inbox only)
VIDEO_DIR = DATA / "video"
VTHUMB_DIR = DATA / "vthumb"
BOOM_SKIP_S = 0.08      # drop the first frames (the shutter-press shake)
BOOM_MAX_S = 1.7        # forward part length before speeding up
BOOM_SPEED = 1.4        # boomerangs read best a little faster than real time
BOOM_LOOPS = 3          # full clip repeats the bounce so it still loops when saved to a phone


# --------------------------------------------------------------------- faces
def _providers():
    """CoreML (Apple chip) on the Mac, plain CPU elsewhere (e.g. Raspberry Pi)."""
    import onnxruntime as ort
    have = ort.get_available_providers()
    return [p for p in ("CoreMLExecutionProvider", "CPUExecutionProvider") if p in have]


def _lean_onnx_sessions():
    """CPU boxes (the Pi): stop ONNX Runtime from keeping big scratch-memory pools.
    Saves ~100 MB per process at the same speed (measured on the Pi 5: within noise)."""
    import onnxruntime as ort
    if getattr(ort.InferenceSession, "_event_lean", False) or "CoreMLExecutionProvider" in ort.get_available_providers():
        return
    orig = ort.InferenceSession.__init__

    def init(self, path, sess_options=None, *a, **k):
        if sess_options is None:
            sess_options = ort.SessionOptions()
        sess_options.enable_cpu_mem_arena = False
        sess_options.enable_mem_pattern = False
        orig(self, path, sess_options, *a, **k)
    ort.InferenceSession.__init__ = init
    ort.InferenceSession._event_lean = True


class FaceEngine:
    def __init__(self):
        _lean_onnx_sessions()
        from insightface.app import FaceAnalysis

        self.app = FaceAnalysis(
            name="buffalo_l",
            allowed_modules=["detection", "recognition"],
            providers=_providers(),
        )
        self.app.prepare(ctx_id=0, det_size=(DET_SIZE, DET_SIZE))
        self.detector = self.app.models["detection"]
        self.recognizer = self.app.models["recognition"]

    def _detect(self, img):
        bboxes, kpss = self.detector.detect(img, max_num=0, metric="default")
        return bboxes, kpss

    def analyse(self, img_bgr: np.ndarray) -> list[dict]:
        """Detect on the whole image plus overlapping tiles, merge, embed."""
        h, w = img_bgr.shape[:2]
        all_boxes, all_kps = [], []

        boxes, kps = self._detect(img_bgr)
        all_boxes.append(boxes)
        all_kps.append(kps)

        if TILE_GRID > 1:
            tw = int(w / TILE_GRID * (1 + TILE_OVERLAP))
            th = int(h / TILE_GRID * (1 + TILE_OVERLAP))
            xs = np.linspace(0, w - tw, TILE_GRID).astype(int)
            ys = np.linspace(0, h - th, TILE_GRID).astype(int)
            for y0 in ys:
                for x0 in xs:
                    tile = img_bgr[y0:y0 + th, x0:x0 + tw]
                    b, k = self._detect(tile)
                    if len(b):
                        b = b.copy()
                        b[:, [0, 2]] += x0
                        b[:, [1, 3]] += y0
                        k = k.copy()
                        k[:, :, 0] += x0
                        k[:, :, 1] += y0
                        all_boxes.append(b)
                        all_kps.append(k)

        boxes = np.concatenate([b for b in all_boxes if len(b)] or [np.zeros((0, 5))])
        if not len(boxes):
            return []
        kpss = np.concatenate([k for b, k in zip(all_boxes, all_kps) if len(b)])

        keep = _nms(boxes, iou_thresh=0.4)
        faces = []
        for i in keep:
            x1, y1, x2, y2, score = boxes[i]
            if score < MIN_DET_SCORE or min(x2 - x1, y2 - y1) < MIN_FACE_PX:
                continue
            from insightface.utils import face_align

            aligned = face_align.norm_crop(img_bgr, landmark=kpss[i], image_size=112)
            emb = self.recognizer.get_feat(aligned).flatten()
            emb = emb / (np.linalg.norm(emb) + 1e-9)
            faces.append({
                "bbox": [float(x1), float(y1), float(x2), float(y2)],
                "det_score": float(score),
                "embedding": emb.astype(np.float32),
            })
        return faces

    def embed_largest(self, img_bgr: np.ndarray, det_size: int | None = None) -> np.ndarray | None:
        """Embedding of the largest confident face (for selfies), or None.
        det_size: smaller detector input for close-up selfies (320 is ~4x faster than
        640 on the Pi and finds a face that fills the frame just as well)."""
        from insightface.utils import face_align

        if det_size:
            boxes, kpss = self.detector.detect(img_bgr, input_size=(det_size, det_size), max_num=0, metric="default")
        else:
            boxes, kpss = self._detect(img_bgr)
        if not len(boxes):
            return None
        areas = (boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1])
        areas[boxes[:, 4] < MIN_DET_SCORE] = -1
        i = int(areas.argmax())
        if areas[i] < 0:
            return None
        aligned = face_align.norm_crop(img_bgr, landmark=kpss[i], image_size=112)
        emb = self.recognizer.get_feat(aligned).flatten()
        return (emb / (np.linalg.norm(emb) + 1e-9)).astype(np.float32)


def _nms(boxes: np.ndarray, iou_thresh: float) -> list[int]:
    x1, y1, x2, y2, s = boxes.T
    areas = (x2 - x1) * (y2 - y1)
    order = s.argsort()[::-1]
    keep = []
    while order.size:
        i = order[0]
        keep.append(int(i))
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        inter = np.maximum(0, xx2 - xx1) * np.maximum(0, yy2 - yy1)
        # also drop a box mostly contained in a kept one (tile edge fragments)
        contain = inter / np.minimum(areas[i], areas[order[1:]])
        iou = inter / (areas[i] + areas[order[1:]] - inter)
        order = order[1:][(iou <= iou_thresh) & (contain <= 0.7)]
    return keep


# --------------------------------------------------------------------- photos
def exif_capture_time(img: Image.Image) -> str | None:
    exif = img.getexif()
    sub = exif.get_ifd(0x8769)  # Exif IFD
    value = sub.get(36867) or exif.get(306)  # DateTimeOriginal, else DateTime
    return str(value) if value else None


def make_photo_id(filename: str, captured_at: str | None, path: Path) -> str:
    key = f"{filename}|{captured_at}" if captured_at else f"{filename}|mtime{path.stat().st_mtime_ns}"
    return hashlib.sha1(key.encode()).hexdigest()[:12]


def resized(img: Image.Image, long_edge: int) -> Image.Image:
    copy = img.copy()
    copy.thumbnail((long_edge, long_edge), Image.LANCZOS)
    return copy


def _ffmpeg(*args):
    import subprocess
    r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *args], capture_output=True, text=True, timeout=900)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg: {r.stderr.strip()[-400:]}")


def _face_score(engine, img: Image.Image) -> float:
    """Sum of confident face-detection scores (for working out which way is up)."""
    small = resized(img, 960)
    bboxes, _ = engine._detect(cv2.cvtColor(np.asarray(small), cv2.COLOR_RGB2BGR))
    return float(sum(b[4] for b in bboxes if b[4] >= 0.6))


def video_rotation(engine, frames: list) -> int:
    """Some phones/apps upload clips whose pixels are stored sideways with no rotation
    tag. Try each frame upright and turned 90 degrees both ways; keep the turn where
    faces are found clearly better. Returns 0, 90 (clockwise) or 270."""
    if engine is None or not frames:
        return 0
    score = {0: 0.0, 90: 0.0, 270: 0.0}
    for f in frames:
        score[0] += _face_score(engine, f)
        score[90] += _face_score(engine, f.rotate(-90, expand=True))
        score[270] += _face_score(engine, f.rotate(90, expand=True))
    best = max((90, 270), key=score.get)
    if score[best] >= 1.5 and score[best] > 2 * score[0]:
        logging.info("video looks sideways (faces upright %.1f / cw %.1f / ccw %.1f) - rotating %d",
                     score[0], score[90], score[270], best)
        return best
    return 0


def make_video(src: Path, photo_id: str, engine=None) -> list:
    """A guest's own video (up to 100 MB): keep it if every phone can already play it
    (H.264 MP4), else make a high-quality playable H.264/AAC copy (iPhone HEVC .mov).
    Sideways clips (no rotation tag) are turned upright using the faces in them.
    Writes video/<id>.mp4 + a small muted gallery preview; returns frames for faces."""
    import subprocess
    import tempfile
    VIDEO_DIR.mkdir(parents=True, exist_ok=True)
    VTHUMB_DIR.mkdir(parents=True, exist_ok=True)
    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                            "stream=codec_name:format=duration,format_name", "-of", "json", str(src)],
                           capture_output=True, text=True)
    info = json.loads(probe.stdout or "{}")
    codec = (info.get("streams") or [{}])[0].get("codec_name")
    dur = float((info.get("format") or {}).get("duration") or 0) or 5.0
    frames = []
    with tempfile.TemporaryDirectory() as tmp:
        for i, f in enumerate((0.1, 0.35, 0.6, 0.85)):
            out = Path(tmp) / f"f{i}.jpg"
            try:
                _ffmpeg("-ss", f"{dur * f:.2f}", "-i", str(src), "-frames:v", "1", "-q:v", "2", str(out))
                with Image.open(out) as im:
                    frames.append(im.convert("RGB"))
            except Exception:
                pass
    rot = video_rotation(engine, frames)
    turn = {90: "transpose=1,", 270: "transpose=2,"}.get(rot, "")
    if rot:
        frames = [f.rotate(-rot, expand=True) for f in frames]
    dst = VIDEO_DIR / f"{photo_id}.mp4"
    size_mbps = src.stat().st_size * 8 / dur / 1e6
    if not rot and codec == "h264" and src.suffix.lower() == ".mp4" and size_mbps <= 6:
        shutil.copyfile(src, dst)           # already small and plays everywhere
    else:
        # Social-feed friendly: H.264 High, long edge <= 1920, CRF 23 with the slower
        # "medium" preset (~15% smaller than veryfast at the same quality), bitrate
        # capped at 6 Mbps for very busy scenes, AAC 128k, faststart for streaming.
        # On the Pi 5 this runs at roughly real time for 720p, ~2-3x for 1080p.
        _ffmpeg("-i", str(src), "-map", "0:v:0", "-map", "0:a:0?",
                "-vf", turn + "scale='if(gte(iw,ih),min(1920,iw),-2)':'if(gte(iw,ih),-2,min(1920,ih))'",
                "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-profile:v", "high",
                "-maxrate", "6M", "-bufsize", "12M", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(dst))
    _ffmpeg("-i", str(src), "-vf", turn + "scale='if(gte(iw,ih),480,270)':-2", "-an", "-t", "6",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            str(VTHUMB_DIR / f"{photo_id}.mp4"))
    return frames


def make_boomerang(src: Path, photo_id: str, mirror: bool = False, plain: bool = False) -> list:
    """Clip -> boomerang: trim the start, speed up, play forward then backward.
    Writes video/<id>.mp4 (bounces BOOM_LOOPS times, for the viewer and saving)
    and vthumb/<id>.mp4 (one bounce, small, loops in the gallery). Returns a few
    candidate frames; the caller keeps the one with the most / clearest faces."""
    import tempfile
    VIDEO_DIR.mkdir(parents=True, exist_ok=True)
    VTHUMB_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        cycle = Path(tmp) / "cycle.mp4"
        # portrait clips 720 px wide, landscape 1280 px wide; ffmpeg applies the phone's rotation
        scale = "scale='if(gte(iw,ih),min(1280,iw),min(720,iw))':-2:flags=lanczos"
        flip = "hflip," if mirror else ""      # front camera: keep it as the guest saw it
        graph = (f"[0:v]trim=start={BOOM_SKIP_S}:duration={BOOM_MAX_S},setpts=PTS-STARTPTS,fps=30,{flip}{scale},"
                 f"setpts=PTS/{BOOM_SPEED},split[a][b];"
                 "[b]reverse,trim=start_frame=1,setpts=PTS-STARTPTS[r];"   # skip the repeated turn frame
                 "[a][r]concat=n=2:v=1:a=0,format=yuv420p[v]")
        if plain:      # someone else's finished video (photobooth): keep the original file untouched
            shutil.copyfile(src, VIDEO_DIR / f"{photo_id}.mp4")
            _ffmpeg("-i", str(src), "-vf", "scale='if(gte(iw,ih),480,270)':-2", "-an", "-t", "6",
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-movflags", "+faststart",
                    str(VTHUMB_DIR / f"{photo_id}.mp4"))          # small preview for the gallery tile
            frames = []
            for i, t in enumerate((0.5, 1.5, 2.5, 3.5)):
                out = Path(tmp) / f"f{i}.jpg"
                try:
                    _ffmpeg("-ss", f"{t:.2f}", "-i", str(src), "-frames:v", "1", "-q:v", "2", str(out))
                    with Image.open(out) as im:
                        frames.append(im.convert("RGB"))
                except Exception:
                    pass
            return frames
        _ffmpeg("-i", str(src), "-filter_complex", graph, "-map", "[v]", "-an",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-movflags", "+faststart", str(cycle))
        _ffmpeg("-stream_loop", str(BOOM_LOOPS - 1), "-i", str(cycle), "-c", "copy", "-movflags", "+faststart",
                str(VIDEO_DIR / f"{photo_id}.mp4"))
        _ffmpeg("-i", str(cycle), "-vf", "scale='if(gte(iw,ih),480,270)':-2", "-an",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-movflags", "+faststart",
                str(VTHUMB_DIR / f"{photo_id}.mp4"))
        frames = []
        fwd = (BOOM_MAX_S - BOOM_SKIP_S) / BOOM_SPEED          # length of the forward half
        for i, t in enumerate((0.15, 0.4, 0.65, 0.9)):
            out = Path(tmp) / f"f{i}.jpg"
            try:
                _ffmpeg("-ss", f"{fwd * t:.2f}", "-i", str(cycle), "-frames:v", "1", "-q:v", "2", str(out))
                with Image.open(out) as im:
                    frames.append(im.convert("RGB"))
            except Exception:
                pass
        return frames


def index_boomerang(path: Path, engine, conn) -> None:
    t0 = time.perf_counter()
    sidecar = path.with_suffix(".json")
    meta = json.loads(sidecar.read_text()) if sidecar.exists() else {}
    photo_id = "g" + hashlib.sha1(path.read_bytes()).hexdigest()[:11]   # same id the phone computes
    if db.photo_exists(conn, photo_id):
        logging.info("skip %s: already indexed as %s", path.name, photo_id)
        _move(path, ORIG_DIR / f"{photo_id}_{path.name}")
        sidecar.unlink(missing_ok=True)
        return
    # Look for faces in several moments of the clip and keep the best frame as the
    # poster: most faces, then clearest (someone may blink or turn in one frame).
    best = None
    is_video = meta.get("kind") == "video"
    clips = make_video(path, photo_id, engine) if is_video else make_boomerang(path, photo_id, bool(meta.get("mirror")), bool(meta.get("plain")))
    for img in clips:
        w = resized(img, WEB_LONG_EDGE)
        fs = engine.analyse(cv2.cvtColor(np.asarray(w), cv2.COLOR_RGB2BGR))
        score = (len(fs), sum(f["det_score"] for f in fs))
        if best is None or score > best[0]:
            best = (score, img, w, fs)
    if best is None:
        raise RuntimeError("no frames from boomerang")
    _, img, web, faces = best
    thumb = resized(img, THUMB_LONG_EDGE)
    web.save(DATA / f"web/{photo_id}.jpg", "JPEG", quality=JPEG_QUALITY, optimize=True)
    thumb.save(DATA / f"thumb/{photo_id}.jpg", "JPEG", quality=80, optimize=True)
    save_mid(img, photo_id)
    ms = int((time.perf_counter() - t0) * 1000)
    db.save_photo(conn, {
        "id": photo_id, "filename": path.name, "captured_at": meta.get("taken"),
        "source": "guest", "status": "visible", "media": "video" if is_video else "boomerang",
        "web_key": f"web/{photo_id}.jpg", "thumb_key": f"thumb/{photo_id}.jpg",
        "width": web.width, "height": web.height, "face_count": len(faces), "index_ms": ms,
        "uploader_id": meta.get("uploader_id"), "uploader_name": meta.get("name"), "batch": meta.get("batch"),
    }, faces)
    _move(path, ORIG_DIR / f"{photo_id}_{path.name}")
    sidecar.unlink(missing_ok=True)
    logging.info("boomerang %s -> %s  faces=%d  %d ms", path.name, photo_id, len(faces), ms)


def index_file(path: Path, engine: FaceEngine, conn) -> None:
    if path.suffix.lower() in VIDEO_EXT:
        return index_boomerang(path, engine, conn)
    t0 = time.perf_counter()
    is_guest = path.parent == GUEST_INBOX
    meta = {}
    sidecar = path.with_suffix(".json")
    if is_guest and sidecar.exists():
        meta = json.loads(sidecar.read_text())
    with Image.open(path) as raw:
        # imported photos (e.g. the photobooth vendor) carry their time from the file name
        captured_at = meta.get("taken_override") or exif_capture_time(raw) or meta.get("taken")
        img = ImageOps.exif_transpose(raw).convert("RGB")
    if is_guest:
        # Guest filenames mean nothing; identical bytes = same photo uploaded twice.
        photo_id = "g" + hashlib.sha1(path.read_bytes()).hexdigest()[:11]
    else:
        photo_id = make_photo_id(path.name, captured_at, path)

    if db.photo_exists(conn, photo_id):
        logging.info("skip %s: already indexed as %s", path.name, photo_id)
        _move(path, ORIG_DIR / f"{photo_id}_{path.name}")
        sidecar.unlink(missing_ok=True)
        return

    web = resized(img, WEB_LONG_EDGE)
    thumb = resized(img, THUMB_LONG_EDGE)
    web_key = f"web/{photo_id}.jpg"
    thumb_key = f"thumb/{photo_id}.jpg"
    web.save(DATA / web_key, "JPEG", quality=JPEG_QUALITY, optimize=True)
    thumb.save(DATA / thumb_key, "JPEG", quality=80, optimize=True)
    save_mid(img, photo_id)
    save_full(path, img, photo_id, already_sized=is_guest)

    bgr = cv2.cvtColor(np.asarray(web), cv2.COLOR_RGB2BGR)
    faces = engine.analyse(bgr)

    ms = int((time.perf_counter() - t0) * 1000)
    db.save_photo(conn, {
        "id": photo_id, "filename": path.name, "captured_at": captured_at,
        "source": "guest" if is_guest else "camera", "status": "visible",
        "web_key": web_key, "thumb_key": thumb_key, "width": web.width, "height": web.height,
        "face_count": len(faces), "index_ms": ms,
        "uploader_id": meta.get("uploader_id"), "uploader_name": meta.get("name"), "batch": meta.get("batch"),
    }, faces)
    _move(path, ORIG_DIR / f"{photo_id}_{path.name}")
    sidecar.unlink(missing_ok=True)
    logging.info("indexed %s -> %s  faces=%d  %d ms", path.name, photo_id, len(faces), ms)


def strip_location(jpeg: bytes):
    """The same JPEG with its GPS location removed and nothing else touched:
    the picture data is copied byte for byte (no re-compression). Returns None
    if the file isn't a JPEG we can safely rewrite."""
    if jpeg[:2] != b"\xff\xd8":
        return None
    out, i, n = [b"\xff\xd8"], 2, len(jpeg)
    while i + 4 <= n:
        if jpeg[i] != 0xFF:
            return None
        marker = jpeg[i + 1]
        if marker == 0xDA:                      # start of scan: the rest is picture data
            out.append(jpeg[i:])
            return b"".join(out)
        if marker in (0x01,) or 0xD0 <= marker <= 0xD7:
            out.append(jpeg[i:i + 2]); i += 2
            continue
        seg_len = int.from_bytes(jpeg[i + 2:i + 4], "big")
        seg = jpeg[i:i + 2 + seg_len]
        payload = seg[4:]
        if marker == 0xE1 and payload.startswith(b"Exif\x00\x00"):
            exif = Image.Exif()
            exif.load(payload)
            exif.get_ifd(0x8769)                # keep camera settings / capture time
            gps = exif.get_ifd(0x8825) if 0x8825 in exif else {}
            if any(t in gps for t in (2, 4)):   # real coordinates (an empty GPS block is left as it is)
                del exif[0x8825]                # GPS
                data = exif.tobytes()
                if len(data) + 2 > 0xFFFF:
                    return None
                seg = b"\xff\xe1" + (len(data) + 2).to_bytes(2, "big") + data
        elif marker == 0xE1 and b"GPS" in payload and b"http://ns.adobe.com/xap" in payload[:40]:
            seg = b""                           # XMP copy of the location
        out.append(seg)
        i += 2 + seg_len
    return None


def save_mid(img: Image.Image, photo_id: str) -> None:
    MID_DIR.mkdir(parents=True, exist_ok=True)
    resized(img, MID_LONG_EDGE).save(MID_DIR / f"{photo_id}.jpg", "JPEG", quality=82, optimize=True, progressive=True)


def save_full(path: Path, img: Image.Image, photo_id: str, already_sized: bool = False) -> None:
    """Full-quality copy, served by the Save button.
    Guest uploads: the original file the guest picked, kept as-is (only the GPS
    location is removed). Anything that isn't a plain JPEG becomes a 3000 px JPEG."""
    dst = FULL_DIR / f"{photo_id}.jpg"
    if already_sized:
        try:
            orig = strip_location(path.read_bytes())
        except Exception:
            orig = None
        if orig:
            dst.write_bytes(orig)
            cap_full(dst)
            return
    full = resized(img, FULL_LONG_EDGE)
    full.save(dst, "JPEG", quality=FULL_QUALITY, optimize=True, subsampling=0)
    cap_full(dst)


FULL_CAP_BYTES = 5_000_000     # Save downloads bigger than this get re-saved...
FULL_TARGET_BYTES = 4_000_000  # ...at full resolution, just under this


def cap_full(dst: Path) -> bool:
    """Shrink a too-big Save download (mainly 16 MP camera shots, ~9 MB) to about
    4 MB without touching its resolution, EXIF or colour profile. Steps the JPEG
    quality down only as far as needed (q88 at 5000 px is visually identical)."""
    if not dst.exists() or dst.stat().st_size <= FULL_CAP_BYTES:
        return False
    with Image.open(dst) as im:
        im.load()
        exif, icc = im.info.get("exif"), im.info.get("icc_profile")
        img = im.convert("RGB")
    tmp = dst.with_suffix(".cap.jpg")
    for q in (92, 90, 88, 86, 84, 82):
        kw = {"exif": exif} if exif else {}
        if icc:
            kw["icc_profile"] = icc
        img.save(tmp, "JPEG", quality=q, optimize=True, progressive=True, **kw)
        if tmp.stat().st_size <= FULL_TARGET_BYTES:
            break
    tmp.replace(dst)
    return True


def _move(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dst))


# --------------------------------------------------------------------- loop
def ready_files(seen_sizes: dict) -> list[Path]:
    """Files whose size hasn't changed for STABLE_SECONDS."""
    now = time.time()
    ready = []
    candidates = sorted(INBOX.iterdir()) + (sorted(GUEST_INBOX.iterdir()) if GUEST_INBOX.exists() else [])
    for p in candidates:
        ok_ext = EXTENSIONS | (VIDEO_EXT if p.parent == GUEST_INBOX else set())
        if p.suffix.lower() not in ok_ext or p.name.startswith("."):
            continue
        size = p.stat().st_size
        prev = seen_sizes.get(p)
        if prev is None or prev[0] != size:
            seen_sizes[p] = (size, now)
        elif now - prev[1] >= STABLE_SECONDS and size > 0:
            ready.append(p)
    for p in list(seen_sizes):
        if not p.exists():
            del seen_sizes[p]
    return ready


_published_once = False


def _first_pass(conn) -> bool:
    """Publish the photo list once at start-up (covers rows added by sync)."""
    global _published_once
    if _published_once:
        return False
    _published_once = True
    return True


def run(engine=None, gate=None, stop=None, once=False):
    """The indexing loop. Standalone it loads its own face model; inside the API process
    (EVENT_INDEXER_IN_API=1) it is handed the API's engine so only one copy is in memory.
    gate() blocks while something more urgent (selfie searches) is using the model."""
    for d in (INBOX, GUEST_INBOX, WEB_DIR, THUMB_DIR, FULL_DIR, ORIG_DIR, FAILED_DIR):
        d.mkdir(parents=True, exist_ok=True)
    if engine is None:
        logging.info("loading face model ...")
        engine = FaceEngine()
    conn = db.connect()
    import cloud
    import config

    cloud.ensure_schema(conn)
    logging.info("watching %s  (cloud sync %s)", INBOX, "ON" if config.CLOUD_ENABLED else "off")

    seen: dict = {}
    while not (stop and stop.is_set()):
        for path in ready_files(seen):
            if gate:
                gate()
            try:
                index_file(path, engine, conn)
            except Exception:
                logging.exception("failed on %s - moved to data/failed", path.name)
                if path.exists():
                    _move(path, FAILED_DIR / path.name)
            seen.pop(path, None)
        cloud.pull_incoming(GUEST_INBOX)               # guest uploads waiting in R2
        cloud.sync_once(conn, force_manifest=_first_pass(conn))
        if once and not any(
            p.suffix.lower() in EXTENSIONS for p in INBOX.iterdir()
        ):
            break
        time.sleep(POLL_SECONDS)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true", help="process inbox and exit")
    args = parser.parse_args()
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[logging.StreamHandler(), logging.FileHandler(BASE / "indexer.log")],
    )
    run(once=args.once)


if __name__ == "__main__":
    os.environ.setdefault("OMP_NUM_THREADS", "4")
    main()
