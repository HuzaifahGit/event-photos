"""Polish lane: Lightroom Classic auto-edits camera RAWs and the edited JPEG
replaces the live photo under the same photo ID (faces stay as indexed).

Camera sends RAW+JPEG over FTP. The JPEG goes live within seconds (indexer);
this worker picks up the matching .ARW, asks the "EVENT Polish" Lightroom
plug-in to: import -> Adobe Auto tone -> AI Denoise if ISO >= DENOISE_ISO ->
export JPEG (long edge 5000 px, q 0.85, ~4-6 MB), then rebuilds the gallery
copies and re-uploads them (edit_v bumps so phones fetch the new version).

If Lightroom isn't running it is launched (hidden) and waited for.
Status file: data/polish_status.json
"""
import json
import logging
import itertools
import math
import shutil
import subprocess
import time
from pathlib import Path

from PIL import Image, ImageOps

import db
from indexer import DATA, FULL_DIR, FULL_LONG_EDGE, INBOX, ORIG_DIR, cap_full, resized, save_mid

BASE = Path(__file__).resolve().parent
RAW_DIR = DATA / "raw"
OUT_DIR = DATA / "polished"
STATUS = DATA / "polish_status.json"
RAW_EXT = {".arw", ".dng"}
DENOISE_ISO = None          # AI Denoise off: Adobe Auto only (fast, ~4-5 s/photo)
SOURCE = "jpeg"             # "jpeg": edit the camera JPEG (camera sends JPEG only); "raw": .ARW twins
EXPORT_LONG_EDGE = 5000
EXPORT_QUALITY = 0.88       # ~4-8 MB at 5000 px; capped below
MAX_FULL_BYTES = 9_500_000
PAIR_WAIT_S = 600          # wait up to 10 min for the JPEG twin to be indexed
LR_APP = "Adobe Lightroom Classic"

status = {"lr_ok": False, "lr_version": None, "current": None, "done": 0, "failed": 0,
          "waiting": 0, "avg_s": None, "last": [], "error": None, "updated": 0}


def save_status():
    status["updated"] = time.time()
    try:
        STATUS.write_text(json.dumps(status))
    except OSError:
        pass


# ------------------------------------------------------------ Lightroom link
# File-based jobs (see the plug-in's Bridge.lua): we drop jobs/<id>.job, the
# plug-in writes jobs/<id>.result. Its heartbeat.json proves it is alive.
STATE_DIR = Path.home() / "Library/Application Support/EventPolish"
JOBS_DIR = STATE_DIR / "jobs"
HEARTBEAT = STATE_DIR / "heartbeat.json"


def to_lua(v):
    if v is None:
        return "nil"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        if isinstance(v, float) and not math.isfinite(v):
            raise ValueError("non-finite")
        return repr(v)
    if isinstance(v, str):
        return '"' + "".join(chr(b) if 32 <= b < 127 and b not in (34, 92) else f"\\{b:03d}"
                             for b in v.encode()) + '"'
    if isinstance(v, dict):
        return "{" + ",".join(f"[{to_lua(str(k))}]={to_lua(x)}" for k, x in v.items()) + "}"
    raise TypeError(type(v))


def heartbeat():
    try:
        hb = json.loads(HEARTBEAT.read_text())
        return hb if time.time() - hb.get("t", 0) < 15 else None
    except Exception:
        return None


class Lightroom:
    def __init__(self):
        hb = heartbeat()
        if not hb:
            raise ConnectionError("EVENT Polish plug-in not running (no heartbeat)")
        self.version = hb.get("version")

    def call(self, cmd, timeout=420, **args):
        JOBS_DIR.mkdir(parents=True, exist_ok=True)
        jid = f"{time.time():.3f}_{next(_ids)}"
        tmp = JOBS_DIR / f"{jid}.tmp"
        tmp.write_text(to_lua({"cmd": cmd, "args": args}))
        tmp.rename(JOBS_DIR / f"{jid}.job")                 # atomic hand-off
        result = JOBS_DIR / f"{jid}.result"
        t0 = time.time()
        while not result.exists():
            if time.time() - t0 > timeout:
                raise TimeoutError(f"Lightroom took over {timeout}s on {cmd}")
            if time.time() - t0 > 20 and not heartbeat():
                raise ConnectionError("Lightroom stopped responding")
            time.sleep(0.3)
        msg = json.loads(result.read_text())
        result.unlink(missing_ok=True)
        if not msg.get("ok"):
            raise RuntimeError(msg.get("error"))
        return msg.get("result")

    def close(self):
        pass


_ids = itertools.count(1)


def connect_lightroom(launch=True) -> Lightroom | None:
    try:
        lr = Lightroom()
        if not status.get("lr_ok"):
            try:
                lr.call("setup", timeout=60)          # makes sure the "Event" collection exists
            except Exception as e:
                logging.warning("collection setup failed: %s", e)
        status.update(lr_ok=True, lr_version=lr.version, error=None)
        return lr
    except Exception as e:
        status.update(lr_ok=False, error=str(e)[:100])
        if launch:
            running = subprocess.run(["pgrep", "-f", "Lightroom Classic.app/Contents/MacOS"],
                                     capture_output=True).returncode == 0
            if not running:
                logging.info("launching Lightroom Classic")
                subprocess.run(["open", "-g", "-a", LR_APP])
                status["error"] = "Starting Lightroom Classic…"
        return None


# ------------------------------------------------------------ pairing
def iso_of(photo_id: str) -> int | None:
    orig = list(ORIG_DIR.glob(f"{photo_id}_*"))
    if not orig:
        return None
    try:
        with Image.open(orig[0]) as im:
            exif = im.getexif().get_ifd(0x8769)
            iso = exif.get(34855) or exif.get(0x8827)
            return int(iso[0] if isinstance(iso, tuple) else iso) if iso else None
    except Exception:
        return None


def twin_of(conn, raw: Path):
    """The camera JPEG with the same file stem (most recent if names repeat)."""
    row = conn.execute(
        "SELECT id FROM photos WHERE source='camera' AND filename LIKE ? ORDER BY created_at DESC LIMIT 1",
        (raw.stem + ".%",)).fetchone()
    return row[0] if row else None


def ensure_schema(conn):
    cols = {r[1] for r in conn.execute("PRAGMA table_info(photos)")}
    if "edit_v" not in cols:
        conn.execute("ALTER TABLE photos ADD COLUMN edit_v INTEGER NOT NULL DEFAULT 0")
    if "polish_state" not in cols:   # NULL = to do, 'done', 'failed', 'skip'
        conn.execute("ALTER TABLE photos ADD COLUMN polish_state TEXT")
        # photos that existed before the polish lane are left as they are
        conn.execute("UPDATE photos SET polish_state='skip' WHERE polish_state IS NULL")
    conn.commit()


def next_jpeg(conn):
    """Oldest camera photo still to polish, with its original JPEG on disk."""
    for pid, name in conn.execute(
            "SELECT id, filename FROM photos WHERE source='camera' AND status='visible'"
            " AND polish_state IS NULL ORDER BY created_at LIMIT 20"):
        orig = list(ORIG_DIR.glob(f"{pid}_*"))
        if orig:
            return pid, orig[0]
        conn.execute("UPDATE photos SET polish_state='failed' WHERE id=?", (pid,))
        conn.commit()
    return None


# ------------------------------------------------------------ one photo
def apply_edit(conn, photo_id: str, jpeg: Path):
    with Image.open(jpeg) as raw:
        img = ImageOps.exif_transpose(raw).convert("RGB")
    web = resized(img, 2000)
    thumb = resized(img, 400)
    web.save(DATA / "web" / f"{photo_id}.jpg", "JPEG", quality=85, optimize=True)
    thumb.save(DATA / "thumb" / f"{photo_id}.jpg", "JPEG", quality=80, optimize=True)
    save_mid(img, photo_id)
    # the edit is the Save download; keep it under ~9.5 MB (noisy high-ISO shots
    # compress worse) by stepping the JPEG quality down only if needed
    dst = FULL_DIR / f"{photo_id}.jpg"
    if jpeg.stat().st_size <= MAX_FULL_BYTES:
        shutil.copyfile(jpeg, dst)
    else:
        for q in (86, 82, 78, 74):
            img.save(dst, "JPEG", quality=q, optimize=True, progressive=True)
            if dst.stat().st_size <= MAX_FULL_BYTES:
                break
    cap_full(dst)
    with conn:
        conn.execute("UPDATE photos SET version='edited', edit_v=edit_v+1, uploaded=0,"
                     " width=?, height=? WHERE id=?", (web.width, web.height, photo_id))


def process(lr: Lightroom, conn, raw: Path, photo_id: str):
    iso = iso_of(photo_id)
    denoise = bool(DENOISE_ISO and iso and iso >= DENOISE_ISO)
    status["current"] = {"name": raw.name, "id": photo_id, "iso": iso, "denoise": denoise, "since": time.time()}
    save_status()
    res = lr.call("polish", path=str(raw), denoise=denoise, amount=50, dir=str(OUT_DIR), iso=iso,
                  maxSize=EXPORT_LONG_EDGE, quality=EXPORT_QUALITY)
    out = Path(res["file"])
    apply_edit(conn, photo_id, out)
    with conn:
        conn.execute("UPDATE photos SET polish_state='done' WHERE id=?", (photo_id,))
    secs = res.get("seconds")
    n = status["done"]
    status["avg_s"] = round(((status["avg_s"] or 0) * n + (secs or 0)) / (n + 1), 1)
    status["done"] = n + 1
    status["last"] = ([{"id": photo_id, "name": raw.name, "s": secs, "iso": iso, "denoised": res.get("denoised"),
                        "mb": round((FULL_DIR / f"{photo_id}.jpg").stat().st_size / 1e6, 1), "at": time.time()}] + status["last"])[:8]
    logging.info("polished %s -> %s  %.1f MB  %ss%s", raw.name, photo_id, out.stat().st_size / 1e6, secs,
                 " +denoise" if res.get("denoised") else "")


# ------------------------------------------------------------ loop
def main():
    for d in (RAW_DIR, OUT_DIR):
        d.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                        handlers=[logging.StreamHandler(), logging.FileHandler(BASE / "polish.log")])
    conn = db.connect()
    ensure_schema(conn)
    lr = None
    first_seen: dict[str, float] = {}
    sizes: dict[Path, tuple] = {}
    logging.info("polish lane: %s mode", SOURCE)
    while SOURCE == "jpeg":
        job = next_jpeg(conn)
        status["waiting"] = conn.execute(
            "SELECT COUNT(*) FROM photos WHERE source='camera' AND status='visible' AND polish_state IS NULL").fetchone()[0]
        if not job:
            status["current"] = None
            alive = heartbeat()                           # keep the status file fresh while idle
            if not alive:
                lr = None
                status.update(lr_ok=False, error="Lightroom Classic is closed")
            elif lr is None:
                lr = connect_lightroom(launch=False)
            save_status()
            time.sleep(2)
            continue
        if lr is None:
            lr = connect_lightroom(launch=True)
            if lr is None:
                save_status()
                time.sleep(5)
                continue
        pid, path = job
        try:
            process(lr, conn, path, pid)
        except (ConnectionError, TimeoutError, OSError) as e:
            logging.warning("Lightroom link lost (%s) - retrying", e)
            lr = None
            status.update(lr_ok=False, error=str(e)[:100])
        except Exception as e:
            logging.exception("polish failed for %s", path.name)
            status["failed"] += 1
            status["error"] = f"{path.name}: {str(e)[:100]}"
            with conn:
                conn.execute("UPDATE photos SET polish_state='failed' WHERE id=?", (pid,))
        status["current"] = None
        save_status()

    logging.info("polish lane watching %s for RAW files", INBOX)
    while True:
        # 1) move finished RAW uploads out of the inbox (size stable for 2 s)
        for p in INBOX.iterdir():
            if p.suffix.lower() in RAW_EXT and not p.name.startswith("."):
                sz = p.stat().st_size
                prev = sizes.get(p)
                if prev and prev[0] == sz and time.time() - prev[1] > 2:
                    shutil.move(str(p), RAW_DIR / p.name)
                    sizes.pop(p, None)
                elif not prev or prev[0] != sz:
                    sizes[p] = (sz, time.time())
        queue = sorted(RAW_DIR.iterdir(), key=lambda p: p.stat().st_mtime)
        queue = [p for p in queue if p.suffix.lower() in RAW_EXT]
        status["waiting"] = len(queue)
        if not queue:
            status["current"] = None
            if lr is None and time.time() - status.get("updated", 0) > 30:
                lr = connect_lightroom(launch=False)      # just report status when idle
            save_status()
            time.sleep(2)
            continue
        if lr is None:
            lr = connect_lightroom(launch=True)
            if lr is None:
                save_status()
                time.sleep(5)
                continue
        raw = queue[0]
        photo_id = twin_of(conn, raw)
        if not photo_id:
            first_seen.setdefault(raw.name, time.time())
            if time.time() - first_seen[raw.name] > PAIR_WAIT_S:
                logging.warning("no JPEG twin for %s after %ds - skipping", raw.name, PAIR_WAIT_S)
                (DATA / "failed").mkdir(exist_ok=True)
                shutil.move(str(raw), DATA / "failed" / raw.name)
                status["failed"] += 1
            save_status()
            time.sleep(2)
            continue
        try:
            process(lr, conn, raw, photo_id)
            (DATA / "raw_done").mkdir(exist_ok=True)
            shutil.move(str(raw), DATA / "raw_done" / raw.name)
        except (ConnectionError, TimeoutError, OSError) as e:
            logging.warning("Lightroom link lost (%s) - reconnecting", e)
            lr.close()
            lr = None
            status.update(lr_ok=False, error=str(e)[:100])
        except Exception as e:
            logging.exception("polish failed for %s", raw.name)
            status["failed"] += 1
            status["error"] = f"{raw.name}: {str(e)[:100]}"
            (DATA / "failed").mkdir(exist_ok=True)
            shutil.move(str(raw), DATA / "failed" / raw.name)
        status["current"] = None
        save_status()


if __name__ == "__main__":
    main()
