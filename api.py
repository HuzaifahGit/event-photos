"""Backend API: selfie matching, gallery listing, media.

Run (dev):  .venv/bin/uvicorn api:app --host 0.0.0.0 --port 8000
Then open http://<mac-ip>:8000 on a phone on the same Wi-Fi.

Privacy: selfie images are decoded in memory and never written to disk.
Only their embeddings are kept, in this process's memory, per session.
"""
import io
import os
import secrets
import threading
import time
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps
from pydantic import BaseModel

import cloud
import config
import db
from api_helpers import taken_iso
from indexer import DATA, FaceEngine

BASE = Path(__file__).resolve().parent
STATIC = BASE / "static"

# Cosine similarity thresholds for buffalo_l. Starting values, to be tuned on
# real test shots (biased toward recall: an extra photo beats a missed guest).
# Checked on 154 real event photos: every strong match (>=0.40) was
# the right person; matches at 0.26-0.31 were all other people.
STRONG_MATCH = 0.40
POSSIBLE_MATCH = 0.30
MAX_SELFIES = 3
SELFIE_LONG_EDGE = 800      # the phone sends a face-filling oval crop; more pixels don't help
SESSION_TTL_S = 3 * 24 * 3600

app = FastAPI(title="event-photos photos")

# The guest page lives on Cloudflare Pages (a different origin) and calls this API.
_origins = [o for o in (config.GUEST_ORIGIN,) if o] + ["http://localhost:8000", "http://127.0.0.1:8000"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_origin_regex=r"https://([a-z0-9-]+\.)?event-photos(-photos)?\.pages\.dev",
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type", "X-Event-Pass"],
)

# Only guests who came in through the QR code (they hold a signed pass from the
# guest site) may use selfie search and uploads.
import hashlib as _hl
import hmac as _hmac
from starlette.responses import JSONResponse as _JSON

GUARDED = ("/api/match", "/api/session/", "/api/upload", "/api/photos")


def _pass_ok(token: str) -> bool:
    import re as _re
    m = _re.fullmatch(r"v1\.(\d+)\.([0-9a-f]{40})", token or "")
    if not m or int(m.group(1)) < time.time():
        return False
    want = _hmac.new(config.GATE_SECRET.encode(), f"v1.{m.group(1)}".encode(), _hl.sha256).hexdigest()[:40]
    return _hmac.compare_digest(want, m.group(2))


@app.middleware("http")
async def guest_gate(request, call_next):
    if config.GATE_SECRET and request.method != "OPTIONS" and request.url.path.startswith(GUARDED):
        local = request.client and request.client.host in ("127.0.0.1", "::1") \
            and "cf-connecting-ip" not in request.headers
        if not local and not _pass_ok(request.headers.get("x-event-pass", "")):
            return _JSON({"detail": "guests_only"}, status_code=401)
    return await call_next(request)
engine: FaceEngine | None = None


# --------------------------------------------------------------- matcher
class Matcher:
    """In-memory face matrix, reloaded whenever the indexer adds faces."""

    def __init__(self):
        self.lock = threading.Lock()
        self.version = None
        self.photo_ids: list[str] = []
        self.face_photo_idx = np.zeros(0, dtype=np.int64)
        self.mat = np.zeros((0, 512), dtype=np.float32)

    def _current_version(self, conn):
        return conn.execute(
            "SELECT (SELECT IFNULL(MAX(id),0) FROM faces),"
            " (SELECT COUNT(*) FROM photos WHERE status='visible')"
        ).fetchone()

    def refresh(self, conn):
        v = self._current_version(conn)
        if v == self.version:
            return
        with self.lock:
            if v == self.version:          # another request already reloaded it while we waited
                return
            _, photo_of_face, mat = db.load_embeddings(conn)
            uniq = sorted(set(photo_of_face))
            pos = {p: i for i, p in enumerate(uniq)}
            self.photo_ids = uniq
            self.face_photo_idx = np.array([pos[p] for p in photo_of_face], dtype=np.int64)
            self.mat = mat
            self.version = v

    def scores(self, queries: np.ndarray) -> dict[str, float]:
        """Best similarity per photo across all its faces and all query vectors."""
        with self.lock:
            if not len(self.mat) or not len(queries):
                return {}
            sims = (self.mat @ queries.T).max(axis=1)
            best = np.full(len(self.photo_ids), -1.0, dtype=np.float32)
            np.maximum.at(best, self.face_photo_idx, sims)
            return {p: float(s) for p, s in zip(self.photo_ids, best)}

    def best_face_embedding(self, photo_id: str, queries: np.ndarray):
        """The face in photo_id most similar to the query (for 'that's me')."""
        with self.lock:
            if photo_id not in self.photo_ids:
                return None
            idx = self.photo_ids.index(photo_id)
            rows = np.where(self.face_photo_idx == idx)[0]
            if not len(rows):
                return None
            sims = (self.mat[rows] @ queries.T).max(axis=1)
            return self.mat[rows[int(sims.argmax())]].copy()


matcher = Matcher()


# --------------------------------------------------------------- sessions
class Session:
    def __init__(self):
        self.selfies: list[np.ndarray] = []
        self.confirmed: list[np.ndarray] = []   # faces the guest tapped "that's me" on
        self.rejected: set[str] = set()          # photos tapped "not me"
        self.seen: set[str] = set()              # photos already returned once
        self.touched = time.time()
        self.person: dict | None = None          # {"fullname", "nick", "device"} if the guest picked a name

    def queries(self) -> np.ndarray:
        return np.stack(self.selfies + self.confirmed)


sessions: dict[str, Session] = {}
sessions_lock = threading.Lock()


def get_session(sid: str) -> Session:
    with sessions_lock:
        now = time.time()
        for k in [k for k, s in sessions.items() if now - s.touched > SESSION_TTL_S]:
            del sessions[k]
        s = sessions.get(sid)
        if not s:
            raise HTTPException(404, "session_expired")
        s.touched = now
        return s


# --------------------------------------------------------------- helpers
def media_url(kind: str, pid: str, uploaded: int, v: int = 0, ext: str = "jpg") -> str:
    """R2 public URL once uploaded; otherwise served by this API (relative path)."""
    if config.CLOUD_ENABLED:
        # served by the guest site from R2, behind the QR-code gate
        return f"/r2/{kind}/{pid}.{ext}" + (f"?v={v}" if v else "")
    return f"/media/{kind}/{pid}.{ext}"


def photo_dict(row) -> dict:
    pid, filename, captured, created, w, h, uploaded, source, by, v, media = row
    extra = {}
    if media in ("boomerang", "video"):
        extra = {"kind": "boomerang", **({"vid": 1} if media == "video" else {}), "video": media_url("video", pid, uploaded, v, "mp4"),
                 "vthumb": media_url("vthumb", pid, uploaded, v, "mp4")}
    return {
        **extra,
        "source": source,
        "by": by if source == "guest" else None,
        "id": pid,
        "thumb": media_url("thumb", pid, uploaded, v),
        "web": media_url("web", pid, uploaded, v),
        "full": media_url("full", pid, uploaded, v),
        "taken": taken_iso(captured, created),
        "w": w,
        "h": h,
        "name": filename,
    }


PHOTO_COLS = "id, filename, captured_at, created_at, width, height, uploaded, source, uploader_name, edit_v, media"


# At most 2 selfies are run through the face model at once (the rest wait their turn):
# a burst of guests then can't make every request grab its own model memory at the
# same time (that pushed the Pi deep into swap). It's no slower: the CPU is the limit.
_selfie_slots = threading.BoundedSemaphore(2)


_selfies_active = 0
_selfies_lock = threading.Lock()


def selfie_embedding(data: bytes) -> np.ndarray:
    global _selfies_active
    with _selfies_lock:
        _selfies_active += 1
    try:
        with _selfie_slots:
            return _selfie_embedding(data)
    finally:
        with _selfies_lock:
            _selfies_active -= 1


def _selfie_embedding(data: bytes) -> np.ndarray:
    try:
        with Image.open(io.BytesIO(data)) as raw:
            img = ImageOps.exif_transpose(raw).convert("RGB")
    except Exception:
        raise HTTPException(400, "bad_image")
    img.thumbnail((SELFIE_LONG_EDGE, SELFIE_LONG_EDGE))
    bgr = cv2.cvtColor(np.asarray(img), cv2.COLOR_RGB2BGR)
    emb = engine.embed_largest(bgr, det_size=320)
    if emb is None:                       # face not found at the fast size: one careful retry
        emb = engine.embed_largest(bgr)
    del img, bgr
    if emb is None:
        raise HTTPException(422, "no_face")
    return emb


def named_faces(conn, fullname: str):
    """Faces that were named as this guest: (vectors, photo ids)."""
    if not fullname:
        return np.zeros((0, 512), np.float32), set()
    try:
        rows = conn.execute("SELECT photo_id, embedding FROM face_names WHERE fullname=?", (fullname,)).fetchall()
    except Exception:          # table not created yet
        return np.zeros((0, 512), np.float32), set()
    if not rows:
        return np.zeros((0, 512), np.float32), set()
    v = np.stack([np.frombuffer(e, dtype=np.float32) for _, e in rows])
    v /= np.linalg.norm(v, axis=1, keepdims=True) + 1e-9
    return v, {p for p, _ in rows}


def build_results(session: Session, conn) -> dict:
    matcher.refresh(conn)
    # Photos already named as this guest are certain matches, and
    # those faces (often side or far shots) help find more photos of them.
    named_v, named_ids = named_faces(conn, (session.person or {}).get("fullname", ""))
    q = session.queries()
    scores = matcher.scores(np.concatenate([q, named_v[:40]]) if len(named_v) else q)
    for pid in named_ids:
        scores[pid] = max(scores.get(pid, 0.0), 0.99)
    hits = {p: s for p, s in scores.items() if s >= POSSIBLE_MATCH and p not in session.rejected}
    rows = {}
    if hits:
        q = f"SELECT {PHOTO_COLS} FROM photos WHERE status='visible' AND id IN ({','.join('?' * len(hits))})"
        rows = {r[0]: r for r in conn.execute(q, list(hits))}
    strong, possible = [], []
    first_visit = not session.seen  # "new" only means something on a return visit
    for pid, s in hits.items():
        if pid not in rows:
            continue
        d = photo_dict(rows[pid])
        d["score"] = round(s, 3)
        d["new"] = not first_visit and pid not in session.seen
        (strong if s >= STRONG_MATCH else possible).append(d)
    for lst in (strong, possible):
        lst.sort(key=lambda d: d["taken"] or "", reverse=True)
    new_count = sum(d["new"] for d in strong)
    session.seen.update(d["id"] for d in strong + possible)
    total = conn.execute("SELECT COUNT(*) FROM photos WHERE status='visible'").fetchone()[0]
    return {"strong": strong, "possible": possible, "new_count": new_count, "total_photos": total}


# --------------------------------------------------------------- routes
@app.on_event("startup")
def startup():
    global engine
    engine = FaceEngine()
    with db.connect() as conn:
        cloud.ensure_schema(conn)
        matcher.refresh(conn)
    threading.Thread(target=people_publisher, daemon=True).start()
    people_dirty.set()


@app.get("/api/stats")
def stats():
    with db.connect() as conn:
        total = conn.execute("SELECT COUNT(*) FROM photos WHERE status='visible'").fetchone()[0]
    return {"total_photos": total, "event": "event-photos"}


@app.get("/api/photos")
def list_photos(offset: int = 0, limit: int = 60, source: str = "all"):
    limit = max(1, min(limit, 200))
    where = "status='visible'"
    args: list = []
    if source in ("camera", "guest"):
        where += " AND source=?"
        args.append(source)
    with db.connect() as conn:
        counts = dict(conn.execute(
            "SELECT source, COUNT(*) FROM photos WHERE status='visible' GROUP BY source").fetchall())
        total = conn.execute(f"SELECT COUNT(*) FROM photos WHERE {where}", args).fetchone()[0]
        rows = conn.execute(
            f"SELECT {PHOTO_COLS} FROM photos WHERE {where}"
            " ORDER BY COALESCE(captured_at, created_at) DESC LIMIT ? OFFSET ?",
            (*args, limit, offset),
        ).fetchall()
    return {
        "total": total,
        "counts": {"all": sum(counts.values()), "camera": counts.get("camera", 0), "guest": counts.get("guest", 0)},
        "photos": [photo_dict(r) for r in rows],
    }


# --------------------------------------------------------------- guest upload
# The phone resizes to ~2000 px before sending, so a normal upload is ~0.5 MB.
# Files land in inbox/guest/ with a .json sidecar; the indexer picks them up
# like camera photos (faces, R2 upload) and marks them source='guest'.
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_PER_GUEST = int(os.environ.get("MAX_PER_GUEST", "40"))
GUEST_INBOX = BASE / "inbox" / "guest"


def event_code() -> str:
    code = getattr(config, "EVENT_CODE", "") or os.environ.get("EVENT_CODE", "")
    if code:
        return code.upper()
    f = DATA / "event_code.txt"
    if not f.exists():
        alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no 0/O/1/I/L
        f.write_text("".join(secrets.choice(alphabet) for _ in range(6)))
    return f.read_text().strip().upper()


@app.post("/api/upload")
def upload(
    photo: UploadFile = File(...),
    code: str = Form(""),
    uploader: str = Form(...),
    name: str = Form(""),
    taken: str = Form(""),
    kind: str = Form("photo"),
    mirror: str = Form(""),
    batch: str = Form(""),
):
    # With the QR gate on, the guest's pass (checked by guest_gate) is the key;
    # the old typed event code is only needed when the gate is off.
    if not config.GATE_SECRET and not secrets.compare_digest(code.strip().upper().encode(), event_code().encode()):
        raise HTTPException(403, "bad_code")
    uploader = "".join(c for c in uploader if c.isalnum() or c in "-_")[:40]
    if len(uploader) < 8:
        raise HTTPException(400, "bad_uploader")
    with db.connect() as conn:
        done = conn.execute("SELECT COUNT(*) FROM photos WHERE uploader_id=?", (uploader,)).fetchone()[0]
    pending = len([p for p in GUEST_INBOX.glob(f"{uploader[:12]}_*") if p.suffix != ".json"]) if GUEST_INBOX.exists() else 0
    if done + pending >= MAX_PER_GUEST:
        raise HTTPException(429, "limit_reached")

    data = photo.file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "too_large")
    ext = ".jpg"
    if kind == "boomerang":
        # a short clip recorded in the page (MP4 on iPhone, MP4/WebM on Android);
        # the indexer turns it into the boomerang with ffmpeg
        head = data[:64]
        if head[4:8] == b"ftyp":
            ext = ".mp4"
        elif head[:4] == b"\x1a\x45\xdf\xa3":
            ext = ".webm"
        else:
            raise HTTPException(400, "bad_video")
    else:
        try:
            with Image.open(io.BytesIO(data)) as im:
                im.verify()
        except Exception:
            raise HTTPException(400, "bad_image")

    # EXIF-style "YYYY:MM:DD HH:MM:SS" (phone local time) or empty
    try:
        taken = datetime.strptime(taken[:19], "%Y:%m:%d %H:%M:%S").strftime("%Y:%m:%d %H:%M:%S")
    except ValueError:
        taken = None
    clean_name = " ".join(name.split())[:40] or None

    GUEST_INBOX.mkdir(parents=True, exist_ok=True)
    stem = f"{uploader[:12]}_{int(time.time()*1000)}_{secrets.token_hex(3)}"
    (GUEST_INBOX / f"{stem}.json").write_text(
        __import__("json").dumps({"uploader_id": uploader, "name": clean_name, "taken": taken,
                                  "kind": "boomerang" if kind == "boomerang" else "photo",
                                  "mirror": mirror == "1",
                                  # photos shared together = one post in the Feed
                                  "batch": batch if __import__("re").fullmatch(r"[a-z0-9]{6,24}", batch or "") else None}))
    tmp = GUEST_INBOX / f".{stem}.part"
    tmp.write_bytes(data)
    tmp.rename(GUEST_INBOX / f"{stem}{ext}")   # atomic: indexer never sees half a file
    return {"ok": True, "remaining": MAX_PER_GUEST - done - pending - 1}


# --------------------------------------------------------------- people (search by name)
# Each guest who does a selfie search is linked to the full name they picked.
# Every minute (and right after a search) the Mac works out the photos each
# person is in and publishes people.json, which the guest site's name search uses.
import json as _json
people_dirty = threading.Event()


def save_person(s: Session):
    if not s.person or not s.person.get("fullname"):
        return
    q = s.queries().astype(np.float32)
    with db.connect() as conn, conn:
        conn.execute("""INSERT INTO people (fullname, nick, device, queries, rejected, updated_at)
                        VALUES (?,?,?,?,?,?) ON CONFLICT(fullname) DO UPDATE SET nick=excluded.nick,
                        device=excluded.device, queries=excluded.queries, rejected=excluded.rejected,
                        updated_at=excluded.updated_at""",
                     (s.person["fullname"], s.person.get("nick"), s.person.get("device"),
                      q.tobytes(), _json.dumps(sorted(s.rejected)), time.time()))
    people_dirty.set()


PHOTOBOOTH_NAME = "Photobooth"
BOOTH_HINT = 0.35


def booth_sessions_for(scores: dict, have: set, booth: dict) -> set:
    """A photobooth session is the same group in every shot, often in wigs, masks
    or sunglasses. Count the whole session as this person's if they're clearly in
    any shot of it, or show up just under the bar in two or more shots."""
    out = set()
    for ids in booth.values():
        near = sum(1 for pid in ids if scores.get(pid, 0) >= BOOTH_HINT)
        if any(pid in have for pid in ids) or near >= 2:
            out.update(ids)
    return out


def people_index(conn) -> list[dict]:
    """Photos per full name: from each guest's selfie search, plus faces the
    named by the organisers (those photos directly, and their face
    vectors to find the same person in other photos)."""
    import faces_naming
    faces_naming.ensure_schema(conn)
    matcher.refresh(conn)
    visible = {r[0] for r in conn.execute("SELECT id FROM photos WHERE status='visible'")}
    people = {}
    for fullname, nick, blob, rejected, device in conn.execute("SELECT fullname, nick, queries, rejected, device FROM people"):
        people[fullname] = {"nick": nick, "q": [np.frombuffer(blob, dtype=np.float32).reshape(-1, 512)],
                            "rej": set(_json.loads(rejected or "[]")), "named": set(),
                            "us": [cloud.owner_hash(device)] if device else []}
    for fullname, pid, emb in conn.execute("SELECT fullname, photo_id, embedding FROM face_names WHERE fullname != ?",
                                           (faces_naming.SKIP,)):
        p = people.setdefault(fullname, {"nick": None, "q": [], "rej": set(), "named": set(), "us": []})
        e = np.frombuffer(emb, dtype=np.float32)
        p["q"].append((e / (np.linalg.norm(e) + 1e-9)).reshape(1, 512))
        p["named"].add(pid)
    booth = {}                                   # photobooth session (batch) -> its photo ids
    for pid, batch in conn.execute("SELECT id, batch FROM photos WHERE uploader_name=? AND status='visible'",
                                   (PHOTOBOOTH_NAME,)):
        booth.setdefault(batch, []).append(pid)
    out = []
    for fullname in sorted(people):
        p = people[fullname]
        q = np.concatenate(p["q"]) if p["q"] else np.zeros((0, 512), np.float32)
        sc = matcher.scores(q) if len(q) else {}
        ids = {pid for pid, v in sc.items() if v >= STRONG_MATCH}
        ids |= booth_sessions_for(sc, ids | p["named"], booth)
        ids = sorted(((ids | p["named"]) & visible) - p["rej"])
        nick = p["nick"]
        out.append({"name": fullname, "nick": nick if nick and nick != fullname else None, "photos": ids,
                    "us": p["us"]})      # owner hash of the browser that did the selfie search (restore after clearing)
    return out


def people_publisher():
    last = None
    while True:
        people_dirty.wait(60)
        people_dirty.clear()
        try:
            with db.connect() as conn:
                body = _json.dumps({"people": people_index(conn)}, ensure_ascii=False, separators=(",", ":"))
            if body != last and config.CLOUD_ENABLED:
                key = "people-pi.json" if config.ROLE == "pi" else "people.json"
                cloud.client().put_object(Bucket=config.R2_BUCKET, Key=key, Body=body.encode(),
                                          ContentType="application/json")
                last = body
        except Exception as e:
            print("people publish failed:", e, flush=True)


@app.post("/api/match")
def match(consent: str = Form(...), selfies: list[UploadFile] = File(...),
          fullname: str = Form(""), nick: str = Form(""), device: str = Form("")):
    if consent != "yes":
        raise HTTPException(400, "consent_required")
    if not 1 <= len(selfies) <= MAX_SELFIES:
        raise HTTPException(400, "one_to_three_selfies")
    s = Session()
    for f in selfies:
        s.selfies.append(selfie_embedding(f.file.read()))
    fullname = " ".join(fullname.split())[:80]
    if fullname:
        s.person = {"fullname": fullname, "nick": " ".join(nick.split())[:30] or None, "device": device[:64]}
    sid = secrets.token_urlsafe(16)
    with sessions_lock:
        sessions[sid] = s
    counters["searches"] += 1
    save_person(s)
    with db.connect() as conn:
        return {"session": sid, **build_results(s, conn)}


@app.get("/api/session/{sid}")
def session_results(sid: str):
    s = get_session(sid)
    with db.connect() as conn:
        return {"session": sid, **build_results(s, conn)}


@app.post("/api/session/{sid}/selfie")
def add_selfie(sid: str, selfie: UploadFile = File(...)):
    s = get_session(sid)
    if len(s.selfies) >= MAX_SELFIES:
        raise HTTPException(400, "max_selfies")
    s.selfies.append(selfie_embedding(selfie.file.read()))
    save_person(s)
    with db.connect() as conn:
        return {"session": sid, **build_results(s, conn)}


class Feedback(BaseModel):
    photo_id: str
    verdict: str  # "me" | "not_me"


@app.post("/api/session/{sid}/feedback")
def feedback(sid: str, fb: Feedback):
    s = get_session(sid)
    if fb.verdict == "not_me":
        s.rejected.add(fb.photo_id)
    elif fb.verdict == "me":
        s.rejected.discard(fb.photo_id)
        emb = matcher.best_face_embedding(fb.photo_id, s.queries())
        if emb is not None and len(s.confirmed) < 10:
            s.confirmed.append(emb)
    else:
        raise HTTPException(400, "bad_verdict")
    save_person(s)
    with db.connect() as conn:
        return {"session": sid, **build_results(s, conn)}


@app.delete("/api/session/{sid}")
def forget(sid: str):
    with sessions_lock:
        sessions.pop(sid, None)
    return {"ok": True}


counters = {"searches": 0, "started": time.time()}


for _d in ("thumb", "web"):
    (DATA / _d).mkdir(parents=True, exist_ok=True)
app.mount("/media/thumb", StaticFiles(directory=DATA / "thumb"), name="thumb")
app.mount("/media/web", StaticFiles(directory=DATA / "web"), name="web")
(DATA / "full").mkdir(exist_ok=True)
app.mount("/media/full", StaticFiles(directory=DATA / "full"), name="full")
for _d in ("video", "vthumb"):
    (DATA / _d).mkdir(exist_ok=True)
    app.mount(f"/media/{_d}", StaticFiles(directory=DATA / _d), name=_d)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


# Same paths the Cloudflare guest site serves from R2, for local testing.
@app.get("/photos.json")
def local_manifest():
    with db.connect() as conn:
        return {"photos": cloud.manifest_photos(conn, local=True)}


@app.get("/r2/{kind}/{name}")
def local_media(kind: str, name: str):
    import re as _re
    m = _re.fullmatch(r"([a-z0-9]{12})\.(jpg|mp4)", name)
    if kind not in ("thumb", "mid", "web", "full", "video", "vthumb") or not m:
        raise HTTPException(404)
    photo_id = m.group(1)
    with db.connect() as conn:
        row = conn.execute("SELECT status FROM photos WHERE id=?", (photo_id,)).fetchone()
    f = DATA / kind / name
    if not row or row[0] != "visible" or not f.exists():
        raise HTTPException(404)
    return FileResponse(f)


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})
