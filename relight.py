"""Make camera-photo brightness consistent: re-edit in Lightroom (Adobe Auto + an
exposure offset) until the faces in each photo reach the same brightness.
Closed loop per photo: export -> measure faces -> correct exposure -> repeat.
Photos already within the band are left alone. Log: relight.log"""
import logging, math, shutil, sqlite3, sys
import numpy as np
from PIL import Image, ImageOps
import polish
from indexer import DATA, ORIG_DIR

TARGET = 0.40          # 0.5*face + 0.5*frame median luma (sRGB 0-1)
BAND = 0.035           # already within +-BAND -> leave it
TOL = 0.025            # stop iterating when this close
TARGET_NOFACE = 0.40   # median luma of the whole frame when there are no faces
MAX_ITER = 4

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s",
                    handlers=[logging.StreamHandler(), logging.FileHandler("relight.log")])


def measure(img: Image.Image, faces, w0) -> tuple[float, bool]:
    a = np.asarray(img.convert("RGB"), dtype=np.float32) / 255
    Y = 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]
    s = img.width / w0
    vals = []
    for x1, y1, x2, y2 in faces:
        cx, cy = (x1 + x2) / 2 * s, (y1 + y2) / 2 * s
        rw, rh = (x2 - x1) / 4 * s, (y2 - y1) / 4 * s
        p = Y[max(0, int(cy - rh)):int(cy + rh) + 1, max(0, int(cx - rw)):int(cx + rw) + 1]
        if p.size:
            vals.append(float(np.median(p)))
    frame = float(np.median(Y))
    if vals:
        # half people, half scene: faces alone would over-brighten darker skin or
        # faces in shadow; the scene alone ignores who the photo is about
        return 0.5 * float(np.median(vals)) + 0.5 * frame, True
    return frame, False


def ev_for(cur, tgt):
    return 2.2 * math.log2(max(tgt, 1e-3) / max(cur, 1e-3))


def main():
    conn = sqlite3.connect(DATA / "photos.db")
    lr = polish.connect_lightroom(launch=True)
    if lr is None:
        sys.exit("Lightroom plug-in not reachable")
    ids = [r[0] for r in conn.execute(
        "SELECT id FROM photos WHERE source='camera' AND status='visible' ORDER BY created_at")]
    only = set(sys.argv[1:])
    done = skipped = 0
    for pid in ids:
        if only and pid not in only:
            continue
        w0 = conn.execute("SELECT width FROM photos WHERE id=?", (pid,)).fetchone()[0]
        faces = [r for r in conn.execute(
            "SELECT x1,y1,x2,y2 FROM faces WHERE photo_id=? AND det_score>0.6", (pid,))]
        cur, hasf = measure(Image.open(DATA / f"web/{pid}.jpg"), faces, w0)
        tgt = TARGET if hasf else TARGET_NOFACE
        if abs(cur - tgt) <= BAND:
            skipped += 1
            continue
        orig = sorted(ORIG_DIR.glob(f"{pid}_*"))
        no_auto = False
        if not orig:
            # camera original gone: start from the current edited full-size copy,
            # exposure only (Auto already ran on it)
            src = DATA / "relight_src" / f"{pid}.jpg"
            src.parent.mkdir(exist_ok=True)
            if not src.exists():
                full = DATA / f"full/{pid}.jpg"
                if full.exists():
                    shutil.copyfile(full, src)
                else:                                   # only in the cloud
                    import cloud, config
                    src.write_bytes(cloud.client().get_object(Bucket=config.R2_BUCKET, Key=f"full/{pid}.jpg")["Body"].read())
            orig, no_auto = [src], True
        # first measure what plain Auto gives, then steer from there
        ev, out, got = (max(-0.6, min(1.6, 0.9 * ev_for(cur, tgt))) if not orig[0].name.startswith(pid + "_") else 0.0), None, None
        for it in range(MAX_ITER):
            res = lr.call("polish", path=str(orig[0]), denoise=False, amount=50, dir=str(polish.OUT_DIR),
                          maxSize=polish.EXPORT_LONG_EDGE, quality=polish.EXPORT_QUALITY, exposure=round(ev, 2),
                          noAuto=no_auto, highlights=(-45 if ev > 0.3 else None))
            out = res["file"]
            with Image.open(out) as im:
                got, _ = measure(ImageOps.exif_transpose(im).reduce(4), faces, w0)
            if abs(got - tgt) <= TOL:
                break
            ev = max(-0.6, min(1.6, ev + 0.9 * ev_for(got, tgt)))   # never push one photo too far
        polish.apply_edit(conn, pid, __import__("pathlib").Path(out))
        conn.commit()
        done += 1
        logging.info("%s face %.2f -> %.2f  (exposure %+.2f EV, %d pass%s)", pid, cur, got, ev, it + 1, "" if it == 0 else "es")
    logging.info("finished: %d re-edited, %d already consistent", done, skipped)


if __name__ == "__main__":
    main()
