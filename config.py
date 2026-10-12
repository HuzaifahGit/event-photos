"""Settings from ./cloud.env (KEY=value lines; never commit this file).

Cloud features switch on only when R2 credentials are present, so the app
runs fully local until Cloudflare is set up.
"""
import os
from pathlib import Path

BASE = Path(__file__).resolve().parent
ENV_FILE = BASE / "cloud.env"


def _load():
    vals = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                vals[k.strip()] = v.strip().strip('"').strip("'")
    vals.update({k: v for k, v in os.environ.items() if k.startswith(("R2_", "PUBLIC_", "GUEST_", "CF_", "ROLE", "PEER_", "SYNC_", "GATE_"))})
    return vals


_cfg = _load()

R2_ACCOUNT_ID = _cfg.get("R2_ACCOUNT_ID", "")
# Accept the full S3 endpoint URL too: keep only the 32-hex account id.
import re as _re

_m = _re.search(r"[0-9a-f]{32}", R2_ACCOUNT_ID)
R2_ACCOUNT_ID = _m.group(0) if _m else R2_ACCOUNT_ID
R2_ACCESS_KEY_ID = _cfg.get("R2_ACCESS_KEY_ID", "")
R2_SECRET_ACCESS_KEY = _cfg.get("R2_SECRET_ACCESS_KEY", "")
R2_BUCKET = _cfg.get("R2_BUCKET", "event-photos")
# Public base URL of the bucket, e.g. https://img.example.com (no trailing slash)
PUBLIC_IMG_BASE = _cfg.get("PUBLIC_IMG_BASE", "").rstrip("/")
# Where the guest page is served, e.g. https://photos.example.com (for CORS)
GUEST_ORIGIN = _cfg.get("GUEST_ORIGIN", "").rstrip("/")

# Optional: lets "hide" also purge Cloudflare's edge cache for that photo.
# Token needs Zone > Cache Purge on the domain; zone id is on the domain's Overview page.
CF_API_TOKEN = _cfg.get("CF_API_TOKEN", "")
CF_ZONE_ID = _cfg.get("CF_ZONE_ID", "")

# Guests need this to upload; the QR code link carries it (?code=...).
EVENT_CODE = _cfg.get("EVENT_CODE", "")

# Mac/Pi failover. ROLE=mac on the MacBook, ROLE=pi on the Raspberry Pi.
ROLE = _cfg.get("ROLE", "mac")
PEER_API = _cfg.get("PEER_API", "").rstrip("/")     # the other machine's public API
SYNC_TOKEN = _cfg.get("SYNC_TOKEN", "")

# QR-code gate: guest passes are signed with this (same value in the Worker).
GATE_SECRET = _cfg.get("GATE_SECRET", "")

CLOUD_ENABLED = bool(R2_ACCOUNT_ID and R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY and PUBLIC_IMG_BASE)
