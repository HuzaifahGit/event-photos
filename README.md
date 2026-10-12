# Event Photos

A self-hosted photo album for live events. Photographers shoot, guests scan a QR code, and within seconds the
photos are on every guest's phone. Guests find the photos they are in with a selfie, share their own photos
and videos, react and comment, and get a feed that looks like a social app. Everything from the camera to the
published page runs from one small computer (a Mac or a Raspberry Pi) plus free-tier Cloudflare services.

## What it does

**For guests (a web page, no app to install)**
- Scan a QR code to enter. Nothing to sign up for.
- **Selfie search**: take a selfie and get every photo you appear in (on-device face detection in the browser,
  face matching on your server).
- **Explore** tabs by programme (e.g. Dinner, Day 1, Photo booth), square grids with burst grouping, a full-screen
  viewer with pinch/double-tap zoom, and a Top tab of the most liked photos.
- **Feed** with posts, reactions, comments, comment likes, captions and name search.
- **Share your own photos and videos** (boomerang clips too), with captions. Originals are kept, GPS is stripped.
- Works on phones and has a desktop layout.

## The pipeline, from camera to page

```
 camera (RAW+JPEG over FTP) ──► inbox/ ──► indexer.py ──► Cloudflare R2 (thumbs, web, full sizes + photos.json)
                                   │            │                         │
                                   │            └─ faces → SQLite         ▼
                                   │                              Cloudflare Worker + D1  ──►  guest page (static/)
                                   ▼                              (QR gate, reactions, comments, uploads)
                       polish.py ► Lightroom Classic
                       (optional: auto tone, AI Denoise, consistent brightness; the edited JPEG
                        replaces the live photo under the same ID)
```

1. **Capture**: `ftp_receiver.py` receives files straight from a camera over Wi-Fi (tested with a Sony mirrorless).
2. **Index**: `indexer.py` reads each file, auto-orients it, finds faces (InsightFace), makes thumb / web /
   full copies (the downloadable copy is capped to about 4 MB at full resolution), strips GPS, and uploads to R2.
   Guest uploads are collected from R2 and indexed the same way.
3. **Auto-edit (optional)**: `polish.py` and the Lightroom plug-in in `lightroom/` send the matching RAW through
   Lightroom Classic (Adobe Auto tone, AI Denoise at high ISO, export) and swap the edited JPEG in, so phones fetch
   the improved version. `relight.py` evens out brightness across photos by measuring faces.
4. **Publish**: `cloud.py` writes `photos.json` and `deploy_pages.sh` builds the page (`static/`) and deploys it with
   the Worker (`worker/index.js`) to your domain. New photos slide into open galleries by themselves.
5. **Selfie search**: `api.py` matches a selfie against the face index and returns the guest's photos.

## Stack

Python 3.11+ (FastAPI, SQLite, InsightFace/ONNX Runtime, OpenCV), vanilla JavaScript front end (no build step),
Cloudflare Workers + R2 + D1 + Tunnel, optional Adobe Lightroom Classic.

## Set up

1. `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`
2. `cp cloud.env.example cloud.env` and fill it in (R2 keys, your domain, `GATE_SECRET`, `EVENT_CODE`). Never commit `cloud.env`.
3. Edit `wrangler.jsonc` (bucket, D1 database id, domain), then create the tables:
   `npx wrangler d1 execute <db> --remote --file worker/schema.sql`
4. Replace the placeholders in `static/brand/` with your own artwork.
5. `./start.sh` runs the FTP receiver, the indexer and the API on one machine.
6. `./deploy_pages.sh` publishes the guest page and the Worker. Put a Cloudflare Tunnel in front of the API
   (see `tunnel.example.yml`).
7. Optional: install `lightroom/EventPolish.lrdevplugin` in Lightroom Classic (File > Plug-in Manager) for the
   auto-edit lane, then run `python polish.py`.

Set the camera to FTP: this computer's IP, port 2121, user and password as in `ftp_receiver.py` (set `FTP_PASSWORD`).

Guests enter their name freely; there is no guest list to maintain.

## Licence and responsibility

Code: MIT, free for commercial use (see `LICENSE`). **The InsightFace face models are non-commercial**, so read
`THIRD_PARTY.md` before using this commercially. Selfie search handles biometric data; get consent and follow your
local privacy law. This was built for one event and is shared as is; expect to adapt it.
