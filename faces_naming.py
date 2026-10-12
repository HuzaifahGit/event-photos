"""Name the faces found in the event photos (naming tool).

Faces are grouped into "probably the same person" clusters so a person is
named once. A name is stored per face (keyed by photo + position, with a copy
of the face vector, so it survives re-indexing). Named faces feed the guest
site's search by name: their photos are listed under that name, and their
vectors find the same person in future photos (see api.people_index).
"""
import io
import threading
import time

import numpy as np
from PIL import Image

import db
from pathlib import Path
DATA = Path(__file__).resolve().parent / "data"

SAME_PERSON = 0.42     # cosine to a cluster's centre to join it
MIN_FACE_PX = 40       # smaller faces (web-copy pixels) are too small to recognise
SKIP = "__skip__"      # "not a guest / can't tell"

_lock = threading.Lock()
_cache = {"key": None, "clusters": []}
_crops: dict[int, bytes] = {}


def ensure_schema(conn):
    conn.execute("""CREATE TABLE IF NOT EXISTS face_names (
        fkey TEXT PRIMARY KEY, photo_id TEXT NOT NULL, fullname TEXT NOT NULL,
        embedding BLOB NOT NULL, named_by TEXT, named_at REAL NOT NULL)""")
    conn.commit()


def fkey(photo_id, x1, y1, x2, y2):
    return f"{photo_id}:{round((x1 + x2) / 40)}:{round((y1 + y2) / 40)}"


def _faces(conn):
    rows = conn.execute("""SELECT f.id, f.photo_id, f.x1, f.y1, f.x2, f.y2, f.det_score, f.embedding
                           FROM faces f JOIN photos p ON p.id = f.photo_id
                           WHERE p.status = 'visible' AND (f.x2 - f.x1) >= ?""", (MIN_FACE_PX,)).fetchall()
    return rows


def clusters(conn):
    """Group faces; cached until faces or names change."""
    ensure_schema(conn)
    key = conn.execute("SELECT (SELECT IFNULL(MAX(id),0) || ':' || COUNT(*) FROM faces),"
                       " (SELECT COUNT(*) || ':' || IFNULL(MAX(named_at),0) FROM face_names),"
                       " (SELECT COUNT(*) FROM photos WHERE status='visible'),"
                       " (SELECT IFNULL(MAX(updated_at),0) FROM people)").fetchone()
    with _lock:
        if _cache["key"] == key:
            return _cache["clusters"]
    rows = _faces(conn)
    names = {r[0]: r[1] for r in conn.execute("SELECT fkey, fullname FROM face_names")}
    people = [(n, np.frombuffer(q, dtype=np.float32).reshape(-1, 512))
              for n, q in conn.execute("SELECT fullname, queries FROM people")]
    order = sorted(range(len(rows)), key=lambda i: -(rows[i][6] or 0))   # clearest faces seed the clusters
    cents, members = [], []
    for i in order:
        e = np.frombuffer(rows[i][7], dtype=np.float32)
        e = e / (np.linalg.norm(e) + 1e-9)
        if cents:
            sims = np.stack(cents) @ e
            j = int(sims.argmax())
            if sims[j] >= SAME_PERSON:
                members[j].append(i)
                c = cents[j] * (len(members[j]) - 1) + e
                cents[j] = c / (np.linalg.norm(c) + 1e-9)
                continue
        cents.append(e)
        members.append([i])
    out = []
    for c, m in zip(cents, members):
        faces = []
        for i in m:
            fid, pid, x1, y1, x2, y2, score, _ = rows[i]
            k = fkey(pid, x1, y1, x2, y2)
            faces.append({"id": fid, "photo": pid, "name": names.get(k), "q": round((score or 0) * (x2 - x1))})
        faces.sort(key=lambda f: -f["q"])
        named = [f["name"] for f in faces if f["name"]]
        name = max(set(named), key=named.count) if named else None
        suggest = None
        if not name and people:      # did this person already do a selfie search?
            best = max(((float((q @ c).max()), n) for n, q in people), default=(0, None))
            if best[0] >= 0.40:
                suggest = best[1]
        out.append({"id": faces[0]["id"], "faces": faces, "photos": len({f["photo"] for f in faces}),
                    "name": name, "selfie": suggest})
    out.sort(key=lambda c: -c["photos"])
    with _lock:
        _cache.update(key=key, clusters=out)
    del rows, people, cents, members, order           # thousands of embeddings: give the memory back now
    return out


def assign(conn, face_ids, fullname, by=None):
    ensure_schema(conn)
    fullname = " ".join(str(fullname).split())[:80]
    rows = conn.execute(f"SELECT id, photo_id, x1, y1, x2, y2, embedding FROM faces WHERE id IN ({','.join('?' * len(face_ids))})",
                        list(face_ids)).fetchall()
    now = time.time()
    with conn:
        for fid, pid, x1, y1, x2, y2, emb in rows:
            k = fkey(pid, x1, y1, x2, y2)
            if not fullname:
                conn.execute("DELETE FROM face_names WHERE fkey=?", (k,))
            else:
                conn.execute("""INSERT INTO face_names (fkey, photo_id, fullname, embedding, named_by, named_at)
                                VALUES (?,?,?,?,?,?) ON CONFLICT(fkey) DO UPDATE SET fullname=excluded.fullname,
                                embedding=excluded.embedding, named_by=excluded.named_by, named_at=excluded.named_at""",
                             (k, pid, fullname, emb, by, now))
    return len(rows)


def crop(conn, face_id: int) -> bytes | None:
    if face_id in _crops:
        return _crops[face_id]
    r = conn.execute("SELECT photo_id, x1, y1, x2, y2 FROM faces WHERE id=?", (face_id,)).fetchone()
    if not r:
        return None
    pid, x1, y1, x2, y2 = r
    path = DATA / "web" / f"{pid}.jpg"
    if not path.exists():
        return None
    with Image.open(path) as im:
        cx, cy, s = (x1 + x2) / 2, (y1 + y2) / 2, max(x2 - x1, y2 - y1) * 1.45
        box = (int(cx - s / 2), int(cy - s / 2), int(cx + s / 2), int(cy + s / 2))
        out = im.convert("RGB").crop(box).resize((180, 180), Image.LANCZOS)
    buf = io.BytesIO()
    out.save(buf, "JPEG", quality=85)
    if len(_crops) > 6000:
        _crops.clear()
    _crops[face_id] = buf.getvalue()
    return _crops[face_id]
