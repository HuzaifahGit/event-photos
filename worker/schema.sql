CREATE TABLE IF NOT EXISTS reactions (
  photo_id TEXT NOT NULL, device TEXT NOT NULL, emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY (photo_id, device, emoji));
CREATE INDEX IF NOT EXISTS reactions_photo ON reactions(photo_id);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, photo_id TEXT NOT NULL, device TEXT NOT NULL,
  name TEXT, body TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS comments_photo ON comments(photo_id, created_at);
CREATE INDEX IF NOT EXISTS comments_device ON comments(device, created_at);
CREATE TABLE IF NOT EXISTS captions (
  photo_id TEXT PRIMARY KEY, device TEXT NOT NULL, name TEXT, body TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS avatars (u TEXT PRIMARY KEY, v INTEGER NOT NULL);

-- per-guest upload count for direct-to-R2 uploads
CREATE TABLE IF NOT EXISTS guest_uploads (device TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0);

-- saved guest profiles (restore after clearing the browser)
CREATE TABLE IF NOT EXISTS profiles (fullname TEXT PRIMARY KEY, us TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL);


CREATE TABLE IF NOT EXISTS comment_likes (comment_id INTEGER NOT NULL, device TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (comment_id, device));
