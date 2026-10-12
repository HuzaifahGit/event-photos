"""Small helpers shared by the API and the cloud manifest."""
from datetime import datetime


def taken_iso(exif_time: str | None, created_at: str | None) -> str | None:
    """EXIF capture time (camera-local, no zone) or the DB arrival time (UTC)."""
    if exif_time:
        try:
            return datetime.strptime(exif_time, "%Y:%m:%d %H:%M:%S").isoformat()
        except ValueError:
            pass
    return created_at.replace(" ", "T") + "Z" if created_at else None
