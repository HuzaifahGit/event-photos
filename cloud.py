"""Cloudflare R2 sync: web copies, thumbnails and the public photos.json manifest.

The indexer calls sync_once() every loop. It uploads visible photos that
aren't in R2 yet, deletes hidden ones from R2, and republishes photos.json
when anything changed. If the internet drops, uploads simply stay pending and
go out on a later loop, so a SIM outage never blocks indexing.
"""
import json
import logging
import time
from pathlib import Path

import config
import db
from api_helpers import taken_iso
DATA = Path(__file__).resolve().parent / "data"   # same as indexer.DATA, without loading OpenCV

UPLOAD_BATCH = 20
# The Pi publishes only the photos it took in itself, to its own file;
# the guest site merges photos.json + photos-pi.json.
MANIFEST_KEY = "photos-pi.json" if config.ROLE == "pi" else "photos.json"
SCOPE = " AND origin='pi'" if config.ROLE == "pi" else ""
_client = None
_last_error_log = 0.0


def client():
    global _client
    if _client is None:
        import boto3
        from botocore.config import Config

        _client = boto3.client(
            "s3",
            endpoint_url=f"https://{config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
            aws_access_key_id=config.R2_ACCESS_KEY_ID,
            aws_secret_access_key=config.R2_SECRET_ACCESS_KEY,
            region_name="auto",
            config=Config(retries={"max_attempts": 2}, connect_timeout=5, read_timeout=30),
        )
    return _client


def ensure_schema(conn):
    cols = {r[1] for r in conn.execute("PRAGMA table_info(photos)")}
    if "uploaded" not in cols:
        conn.execute("ALTER TABLE photos ADD COLUMN uploaded INTEGER NOT NULL DEFAULT 0")
        conn.commit()
    if "phash" not in cols:          # "<edit_v>:<64-bit dHash>" of the thumbnail (burst grouping)
        conn.execute("ALTER TABLE photos ADD COLUMN phash TEXT")
        conn.commit()


def dhash(path) -> str | None:
    """64-bit difference hash: near-identical shots (bursts) differ in only a few bits."""
    from PIL import Image
    try:
        with Image.open(path) as im:
            g = im.convert("L").resize((9, 8), Image.LANCZOS)
        px = list(g.getdata())
        bits = 0
        for y in range(8):
            for x in range(8):
                bits = (bits << 1) | (px[y * 9 + x] > px[y * 9 + x + 1])
        return f"{bits:016x}"
    except Exception:
        return None


def fill_phashes(conn):
    """Hash any photo whose thumbnail changed (new, or re-edited) since last time."""
    todo = []
    for pid, v, ph in conn.execute("SELECT id, edit_v, phash FROM photos WHERE status='visible'"):
        if ph and ph.split(":")[0] == str(v or 0):
            continue
        f = DATA / "thumb" / f"{pid}.jpg"
        if f.exists():
            h = dhash(f)
            if h:
                todo.append((f"{v or 0}:{h}", pid))
    if todo:
        with conn:
            conn.executemany("UPDATE photos SET phash=? WHERE id=?", todo)


def media_files(pid: str, media: str = "image") -> list:
    """(R2 key, local path, content type) for every file of a photo or boomerang.
    Boomerangs: poster web/thumb JPEG + full video + small looping gallery video."""
    files = [(f"thumb/{pid}.jpg", DATA / "thumb" / f"{pid}.jpg", "image/jpeg"),
             (f"mid/{pid}.jpg", DATA / "mid" / f"{pid}.jpg", "image/jpeg"),
             (f"web/{pid}.jpg", DATA / "web" / f"{pid}.jpg", "image/jpeg")]
    if media in ("boomerang", "video"):
        files += [(f"video/{pid}.mp4", DATA / "video" / f"{pid}.mp4", "video/mp4"),
                  (f"vthumb/{pid}.mp4", DATA / "vthumb" / f"{pid}.mp4", "video/mp4")]
    else:
        files.append((f"full/{pid}.jpg", DATA / "full" / f"{pid}.jpg", "image/jpeg"))
    return files


def _put(key: str, body: bytes, content_type: str, cache: str):
    client().put_object(Bucket=config.R2_BUCKET, Key=key, Body=body,
                        ContentType=content_type, CacheControl=cache)


MANIFEST_COLS = ("id, captured_at, created_at, width, height, source, uploader_name, edit_v, media,"
                 " uploader_id, batch, filename, phash")


def owner_hash(uploader_id: str | None) -> str | None:
    """Public stand-in for a guest's device id (the id itself is a secret: it
    proves ownership of captions/comments). Same hash the Worker uses for avatars."""
    import hashlib
    return hashlib.sha1(uploader_id.encode()).hexdigest()[:10] if uploader_id else None


def manifest_row(r) -> dict:
    d = {"id": r[0], "taken": taken_iso(r[1], r[2]), "w": r[3], "h": r[4], "source": r[5],
         "by": r[6] if r[5] == "guest" else None}
    if r[7]:
        d["v"] = r[7]
    if r[8] in ("boomerang", "video"):
        d["kind"] = "boomerang"          # plays as a video tile
        if r[8] == "video":
            d["vid"] = 1                 # a real video (sound, controls), not a loop
    if r[5] == "guest":
        # Feed: who shared it (hashed), which share it came in, and when it was posted
        d["u"] = owner_hash(r[9])
        d["b"] = r[10]
    # photobooth: the vendor's position inside the session (booth019_<n>_...: 0 = video)
    import re
    m = re.match(r"booth\d+_(\d+)_", r[11] or "") if len(r) > 11 else None
    if m:
        d["o"] = int(m.group(1))
    if len(r) > 12 and r[12]:
        d["ph"] = r[12].split(":")[-1]       # look-alike fingerprint (bursts become one tile)
    # when it reached the album (Feed order; photographer posts are grouped by this too)
    d["at"] = r[2].replace(" ", "T") + "Z" if r[2] else None
    return d


def manifest_photos(conn, local=False) -> list:
    try:
        fill_phashes(conn)
    except Exception:
        pass
    up = "" if local else " AND uploaded=1"
    rows = conn.execute(f"SELECT {MANIFEST_COLS} FROM photos"
                        f" WHERE status='visible'{up} ORDER BY COALESCE(captured_at, created_at) DESC").fetchall()
    focus = focus_points(conn)
    out = []
    for r in rows:
        d = manifest_row(r)
        if r[0] in focus:
            d["f"] = focus[r[0]]
        out.append(d)
    return out


def focus_points(conn) -> dict:
    """Where the people are in each photo (0-1, x then y), weighted toward bigger
    faces: Explore crops its square tiles around this point."""
    dims = {pid: (w, h) for pid, w, h in conn.execute("SELECT id, width, height FROM photos WHERE status='visible'")}
    acc = {}
    for pid, x1, y1, x2, y2 in conn.execute("SELECT photo_id, x1, y1, x2, y2 FROM faces WHERE det_score >= 0.6"):
        w, h = dims.get(pid, (0, 0))
        if not w or not h:
            continue
        a = max(1.0, (x2 - x1) * (y2 - y1))
        sx, sy, sa = acc.get(pid, (0.0, 0.0, 0.0))
        acc[pid] = (sx + a * (x1 + x2) / 2 / w, sy + a * (y1 + y2) / 2 / h, sa + a)
    return {pid: [round(min(1, max(0, sx / sa)), 3), round(min(1, max(0, sy / sa)), 3)]
            for pid, (sx, sy, sa) in acc.items() if sa}


def manifest(conn) -> dict:
    rows = conn.execute(f"SELECT {MANIFEST_COLS} FROM photos"
                        f" WHERE status='visible' AND uploaded=1{SCOPE}"
                        " ORDER BY COALESCE(captured_at, created_at) DESC").fetchall()
    return {"updated": int(time.time()), "img_base": config.PUBLIC_IMG_BASE,
            "photos": [manifest_row(r) for r in rows]}


def sync_once(conn, force_manifest: bool = False) -> int:
    """One pass. Returns number of objects changed. Safe to call often."""
    global _last_error_log
    if not config.CLOUD_ENABLED:
        return 0
    changed = 0
    try:
        pending = conn.execute(
            f"SELECT id, media FROM photos WHERE status='visible' AND uploaded=0{SCOPE} LIMIT ?", (UPLOAD_BATCH,)
        ).fetchall()
        for pid, media in pending:
            for key, f, ctype in media_files(pid, media):
                if key.startswith(("full/", "mid/")) and not f.exists():
                    continue
                _put(key, f.read_bytes(), ctype, "public, max-age=31536000, immutable")
            conn.execute("UPDATE photos SET uploaded=1 WHERE id=?", (pid,))
            conn.commit()
            changed += 1

        gone = conn.execute(f"SELECT id, media FROM photos WHERE status='hidden' AND uploaded=1{SCOPE}").fetchall()
        for pid, media in gone:
            keys = [k for k, _, _ in media_files(pid, media)]
            client().delete_objects(Bucket=config.R2_BUCKET, Delete={"Objects": [{"Key": k} for k in keys]})
            purge_urls([f"{config.PUBLIC_IMG_BASE}/{k}" for k in keys])
            conn.execute("UPDATE photos SET uploaded=0 WHERE id=?", (pid,))
            conn.commit()
            changed += 1

        if changed or force_manifest:
            _put(MANIFEST_KEY, json.dumps(manifest(conn), separators=(",", ":")).encode(),
                 "application/json", "public, max-age=15")
            logging.info("cloud: %d change(s) synced, manifest published", changed)
    except Exception as e:  # offline, bad creds, etc. -> retry next loop
        if time.time() - _last_error_log > 60:
            logging.warning("cloud sync paused: %s", e)
            _last_error_log = time.time()
    return changed


_last_pull = 0.0
INCOMING = "incoming/"
PI_GRACE_S = 75          # the Pi leaves fresh uploads to the Mac; takes them only if the Mac hasn't


def pull_incoming(guest_inbox) -> int:
    """Guest uploads now go straight from the phone to R2 (incoming/<stem>.<ext> +
    <stem>.json, written by the Worker). Bring them into the local guest inbox so
    the normal indexer path handles them, then remove them from incoming/."""
    global _last_pull, _last_error_log
    if not config.CLOUD_ENABLED or time.time() - _last_pull < 3:
        return 0
    _last_pull = time.time()
    got = 0
    try:
        c = client()
        objs = {}
        for pg in c.get_paginator("list_objects_v2").paginate(Bucket=config.R2_BUCKET, Prefix=INCOMING):
            for o in pg.get("Contents", []):
                objs[o["Key"]] = o
        now = time.time()
        for key, o in sorted(objs.items(), key=lambda kv: kv[1]["LastModified"]):
            if not key.endswith(".json"):
                continue
            stem = key[len(INCOMING):-5]
            media = [k for k in objs if k.startswith(INCOMING + stem + ".") and not k.endswith(".json")]
            if not media:
                continue
            if config.ROLE == "pi" and now - o["LastModified"].timestamp() < PI_GRACE_S:
                continue
            guest_inbox.mkdir(parents=True, exist_ok=True)
            ext = media[0].rsplit(".", 1)[1]
            side = c.get_object(Bucket=config.R2_BUCKET, Key=key)["Body"].read()
            body = c.get_object(Bucket=config.R2_BUCKET, Key=media[0])["Body"].read()
            (guest_inbox / f"{stem}.json").write_bytes(side)            # sidecar first
            tmp = guest_inbox / f".{stem}.part"
            tmp.write_bytes(body)
            tmp.rename(guest_inbox / f"{stem}.{ext}")                   # atomic for the indexer
            c.delete_objects(Bucket=config.R2_BUCKET, Delete={"Objects": [{"Key": key}, {"Key": media[0]}]})
            got += 1
        if got:
            logging.info("cloud: pulled %d guest upload(s) from incoming/", got)
    except Exception as e:
        if time.time() - _last_error_log > 60:
            logging.warning("cloud: incoming pull paused: %s", e)
            _last_error_log = time.time()
    return got


def purge_urls(urls: list[str]) -> bool:
    """Drop URLs from Cloudflare's edge cache so hidden photos stop loading at once."""
    if not (config.CF_API_TOKEN and config.CF_ZONE_ID):
        logging.warning("cloud: no CF_API_TOKEN/CF_ZONE_ID - cached copies may linger: %s", urls)
        return False
    import urllib.request

    req = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4/zones/{config.CF_ZONE_ID}/purge_cache",
        data=json.dumps({"files": urls}).encode(),
        headers={"Authorization": f"Bearer {config.CF_API_TOKEN}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        ok = json.load(r).get("success", False)
    logging.info("cloud: purged %d url(s) from edge cache: %s", len(urls), ok)
    return ok


def pending_count(conn) -> int:
    if not config.CLOUD_ENABLED:
        return 0
    return conn.execute(
        "SELECT COUNT(*) FROM photos WHERE ((status='visible' AND uploaded=0)"
        f" OR (status='hidden' AND uploaded=1)){SCOPE}"
    ).fetchone()[0]


def wipe_bucket():
    """Delete every object in the bucket (post-event cleanup)."""
    paginator = client().get_paginator("list_objects_v2")
    n = 0
    for page in paginator.paginate(Bucket=config.R2_BUCKET):
        keys = [{"Key": o["Key"]} for o in page.get("Contents", [])]
        for i in range(0, len(keys), 1000):
            client().delete_objects(Bucket=config.R2_BUCKET, Delete={"Objects": keys[i:i + 1000]})
            n += len(keys[i:i + 1000])
    return n
