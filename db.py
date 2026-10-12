"""SQLite storage for photos and face embeddings."""
import sqlite3
from pathlib import Path

import numpy as np

BASE = Path(__file__).resolve().parent
DB_PATH = BASE / "data" / "photos.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS photos (
    id          TEXT PRIMARY KEY,
    filename    TEXT NOT NULL,
    captured_at TEXT,
    source      TEXT NOT NULL DEFAULT 'camera',
    status      TEXT NOT NULL DEFAULT 'visible',
    web_key     TEXT,
    thumb_key   TEXT,
    width       INTEGER,
    height      INTEGER,
    version     TEXT NOT NULL DEFAULT 'live',
    face_count  INTEGER NOT NULL DEFAULT 0,
    index_ms    INTEGER,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS faces (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    photo_id    TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    x1 REAL, y1 REAL, x2 REAL, y2 REAL,
    det_score   REAL,
    embedding   BLOB NOT NULL,
    cluster_id  INTEGER
);
CREATE INDEX IF NOT EXISTS faces_photo ON faces(photo_id);
"""


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(SCHEMA)
    _migrate(conn)
    return conn


def _migrate(conn):
    # A guest's face, linked to the full name they picked, so others can
    # search photos by name. Only the face vectors are kept (never the selfie).
    conn.execute("""CREATE TABLE IF NOT EXISTS people (
        fullname TEXT PRIMARY KEY, nick TEXT, device TEXT,
        queries BLOB NOT NULL, rejected TEXT NOT NULL DEFAULT '[]', updated_at REAL NOT NULL)""")
    cols = {r[1] for r in conn.execute("PRAGMA table_info(photos)")}
    for name, ddl in (("uploader_id", "TEXT"), ("uploader_name", "TEXT"),
                      ("uploaded", "INTEGER NOT NULL DEFAULT 0"), ("origin", "TEXT NOT NULL DEFAULT 'mac'"),
                      ("edit_v", "INTEGER NOT NULL DEFAULT 0"),
                      ("media", "TEXT NOT NULL DEFAULT 'image'"), ("batch", "TEXT")):
        if name not in cols:
            conn.execute(f"ALTER TABLE photos ADD COLUMN {name} {ddl}")
    conn.commit()


def _role():
    import config
    return "pi" if config.ROLE == "pi" else "mac"


def photo_exists(conn, photo_id: str) -> bool:
    return conn.execute("SELECT 1 FROM photos WHERE id=?", (photo_id,)).fetchone() is not None


def save_photo(conn, photo: dict, faces: list[dict]) -> None:
    with conn:
        conn.execute("DELETE FROM faces WHERE photo_id=?", (photo["id"],))
        conn.execute(
            """INSERT OR REPLACE INTO photos
               (id, filename, captured_at, source, status, web_key, thumb_key,
                width, height, face_count, index_ms, uploader_id, uploader_name, origin, media, batch)
               VALUES (:id, :filename, :captured_at, :source, :status, :web_key,
                       :thumb_key, :width, :height, :face_count, :index_ms,
                       :uploader_id, :uploader_name, :origin, :media, :batch)""",
            {"uploader_id": None, "uploader_name": None, "origin": _role(), "media": "image", "batch": None, **photo},
        )
        conn.executemany(
            """INSERT INTO faces (photo_id, x1, y1, x2, y2, det_score, embedding)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            [
                (photo["id"], *f["bbox"], f["det_score"],
                 np.asarray(f["embedding"], dtype=np.float32).tobytes())
                for f in faces
            ],
        )


def load_embeddings(conn, visible_only: bool = True):
    """Return (face_ids, photo_ids, matrix[n,512]) with L2-normalised rows."""
    sql = "SELECT f.id, f.photo_id, f.embedding FROM faces f JOIN photos p ON p.id=f.photo_id"
    if visible_only:
        sql += " WHERE p.status='visible'"
    rows = conn.execute(sql).fetchall()
    if not rows:
        return [], [], np.zeros((0, 512), dtype=np.float32)
    mat = np.stack([np.frombuffer(r[2], dtype=np.float32) for r in rows])
    mat /= np.linalg.norm(mat, axis=1, keepdims=True) + 1e-9
    return [r[0] for r in rows], [r[1] for r in rows], mat
