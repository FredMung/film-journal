"""Film Journal — log film frames from an iPhone, stored on the Pi, mirrored to the NAS."""

import json
import os
import re
import shutil
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, abort, g, jsonify, render_template, request, send_from_directory
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("FILM_JOURNAL_DATA_DIR", ROOT / "data"))
PHOTO_DIR = DATA_DIR / "photos"
DB_PATH = DATA_DIR / "film-journal.sqlite3"
NAS_MOUNT = Path(os.environ.get("FILM_JOURNAL_NAS_MOUNT", "/mnt/nas-transit"))
NAS_DIR = NAS_MOUNT / "film-journal"
SYNC_DELAY_SECONDS = 10

SCHEMA = """
CREATE TABLE IF NOT EXISTS cameras (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    exposures INTEGER,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rolls (
    id INTEGER PRIMARY KEY,
    client_id TEXT,
    camera TEXT,
    film_stock TEXT,
    iso INTEGER,
    exposures INTEGER NOT NULL DEFAULT 36,
    title TEXT,
    description TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
);
CREATE TABLE IF NOT EXISTS frames (
    id INTEGER PRIMARY KEY,
    roll_id INTEGER NOT NULL REFERENCES rolls(id) ON DELETE CASCADE,
    frame_no INTEGER NOT NULL,
    aperture TEXT,
    shutter TEXT,
    note TEXT,
    photo TEXT,
    shot_at TEXT NOT NULL,
    UNIQUE (roll_id, frame_no)
);
"""

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


# The user's cameras (from ~/camera-negative-print/README.md), with frames per roll.
DEFAULT_CAMERAS = [
    ("Hasselblad 500C/M", 12),
    ("Mamiya RB67 Pro SD", 10),
    ("Nikon F", 36),
    ("Nikon F2", 36),
    ("Nikon F3", 36),
    ("Nikon F100", 36),
    ("Pentax Spotmatic", 36),
]


def init_db():
    PHOTO_DIR.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(SCHEMA)
        cols = {r[1] for r in conn.execute("PRAGMA table_info(cameras)")}
        if "exposures" not in cols:
            conn.execute("ALTER TABLE cameras ADD COLUMN exposures INTEGER")
        # client_id: the phone names rolls itself so it can load one while offline.
        cols = {r[1] for r in conn.execute("PRAGMA table_info(rolls)")}
        if "client_id" not in cols:
            conn.execute("ALTER TABLE rolls ADD COLUMN client_id TEXT")
        conn.execute("UPDATE rolls SET client_id = 'r' || id WHERE client_id IS NULL")
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS rolls_client_id ON rolls (client_id)")
        for name, exposures in DEFAULT_CAMERAS:
            conn.execute(
                "INSERT OR IGNORE INTO cameras (name, exposures, created_at) VALUES (?, ?, ?)",
                (name, exposures, now_iso()),
            )


def db():
    if "db" not in g:
        g.db = connect()
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def clean(value, limit=500):
    """Empty strings and '—' placeholders become NULL: a frame may have no settings."""
    if value is None:
        return None
    value = str(value).strip()
    if value in ("", "—", "-", "null", "None"):
        return None
    return value[:limit]


def clean_int(value):
    value = clean(value)
    try:
        return int(value) if value is not None else None
    except ValueError:
        return None


def roll_dict(row):
    return dict(row) if row else None


def frames_for(roll_id):
    rows = db().execute(
        "SELECT * FROM frames WHERE roll_id = ? ORDER BY frame_no", (roll_id,)
    ).fetchall()
    return [dict(r) for r in rows]


def resolve_roll(ref):
    """A roll URL may use the server id or the phone-made client_id."""
    if ref.isdigit():
        row = db().execute("SELECT id FROM rolls WHERE id = ?", (int(ref),)).fetchone()
    else:
        row = db().execute("SELECT id FROM rolls WHERE client_id = ?", (ref,)).fetchone()
    if row is None:
        abort(404)
    return row["id"]


def get_roll(roll_id):
    row = db().execute("SELECT * FROM rolls WHERE id = ?", (roll_id,)).fetchone()
    if row is None:
        abort(404)
    return row


# ---------------------------------------------------------------- NAS mirror

_sync_timer = None
_sync_lock = threading.Lock()
_sync_status = {"last_ok": None, "last_error": None}


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")[:40]


def sync_to_nas():
    """Mirror DB snapshot, one JSON per roll, and photos to the NAS.

    The live DB stays on local disk; SQLite over this CIFS share is unreliable.
    """
    with _sync_lock:
        try:
            if not os.path.ismount(NAS_MOUNT):
                raise RuntimeError(f"{NAS_MOUNT} is not mounted")
            (NAS_DIR / "rolls").mkdir(parents=True, exist_ok=True)
            (NAS_DIR / "photos").mkdir(parents=True, exist_ok=True)

            staging = DATA_DIR / "snapshot.sqlite3"
            staging.unlink(missing_ok=True)
            with connect() as conn:
                conn.execute("VACUUM INTO ?", (str(staging),))
                rolls = [dict(r) for r in conn.execute("SELECT * FROM rolls")]
                for roll in rolls:
                    roll["frames"] = [
                        dict(f)
                        for f in conn.execute(
                            "SELECT * FROM frames WHERE roll_id = ? ORDER BY frame_no",
                            (roll["id"],),
                        )
                    ]
            shutil.copyfile(staging, NAS_DIR / "film-journal.sqlite3")
            staging.unlink(missing_ok=True)

            for roll in rolls:
                name = f"roll-{roll['id']:04d}"
                label = slug(" ".join(filter(None, [roll["film_stock"], roll["title"]])))
                if label:
                    name += f"-{label}"
                for stale in (NAS_DIR / "rolls").glob(f"roll-{roll['id']:04d}*.json"):
                    if stale.name != f"{name}.json":
                        stale.unlink()
                (NAS_DIR / "rolls" / f"{name}.json").write_text(
                    json.dumps(roll, indent=2, ensure_ascii=False)
                )

            for src in PHOTO_DIR.rglob("*.jpg"):
                dest = NAS_DIR / "photos" / src.relative_to(PHOTO_DIR)
                st = src.stat()
                if dest.exists() and dest.stat().st_size == st.st_size:
                    continue
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(src, dest)
            _sync_status.update(last_ok=now_iso(), last_error=None)
        except Exception as exc:  # NAS down must never break logging a frame
            _sync_status["last_error"] = f"{now_iso()} {exc}"
            app.logger.warning("NAS sync failed: %s", exc)


def schedule_sync():
    """Debounced: a burst of frame saves produces one sync."""
    global _sync_timer
    if _sync_timer is not None:
        _sync_timer.cancel()
    _sync_timer = threading.Timer(SYNC_DELAY_SECONDS, sync_to_nas)
    _sync_timer.daemon = True
    _sync_timer.start()


# ---------------------------------------------------------------- pages

@app.get("/")
def index():
    return render_template("index.html")


@app.get("/photos/<path:name>")
def photo(name):
    return send_from_directory(PHOTO_DIR, name, max_age=86400)


@app.get("/sw.js")
def service_worker():
    resp = send_from_directory(ROOT / "static", "sw.js", mimetype="text/javascript", max_age=0)
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/manifest.webmanifest")
def manifest():
    return send_from_directory(ROOT / "static", "manifest.webmanifest",
                               mimetype="application/manifest+json")


# ---------------------------------------------------------------- API

@app.get("/api/state")
def state():
    active = [dict(r) for r in db().execute(
        "SELECT * FROM rolls WHERE finished_at IS NULL ORDER BY started_at, id"
    )]
    for roll in active:
        roll["frames"] = frames_for(roll["id"])
    cameras = [dict(r) for r in db().execute("SELECT * FROM cameras ORDER BY name")]
    last = db().execute(
        "SELECT camera, film_stock, iso, exposures FROM rolls ORDER BY id DESC LIMIT 1"
    ).fetchone()
    return jsonify(
        active=active,
        cameras=cameras,
        last_roll=roll_dict(last),
        sync=_sync_status,
    )


@app.post("/api/cameras")
def add_camera():
    data = request.get_json(silent=True) or {}
    name = clean(data.get("name"), 80)
    if not name:
        abort(400)
    db().execute("INSERT OR IGNORE INTO cameras (name, exposures, created_at) VALUES (?, ?, ?)",
                 (name, clean_int(data.get("exposures")), now_iso()))
    db().commit()
    schedule_sync()
    return jsonify(ok=True)


@app.delete("/api/cameras/<int:camera_id>")
def delete_camera(camera_id):
    db().execute("DELETE FROM cameras WHERE id = ?", (camera_id,))
    db().commit()
    return jsonify(ok=True)


@app.get("/api/rolls")
def list_rolls():
    rows = db().execute(
        """SELECT r.*, COUNT(f.id) AS frame_count,
                  (SELECT photo FROM frames WHERE roll_id = r.id AND photo IS NOT NULL
                   ORDER BY frame_no LIMIT 1) AS cover
           FROM rolls r LEFT JOIN frames f ON f.roll_id = r.id
           GROUP BY r.id ORDER BY r.id DESC"""
    ).fetchall()
    return jsonify(rolls=[dict(r) for r in rows])


@app.post("/api/rolls")
def start_roll():
    data = request.get_json(silent=True) or {}
    client_id = clean(data.get("client_id"), 64) or uuid.uuid4().hex
    # OR IGNORE: a queued create replayed after a dropped response is a no-op.
    db().execute(
        """INSERT OR IGNORE INTO rolls (client_id, camera, film_stock, iso, exposures, started_at)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (client_id, clean(data.get("camera"), 80), clean(data.get("film_stock"), 80),
         clean_int(data.get("iso")), clean_int(data.get("exposures")) or 36,
         clean(data.get("started_at"), 40) or now_iso()),
    )
    db().commit()
    schedule_sync()
    return jsonify(roll=roll_dict(get_roll(resolve_roll(client_id))))


@app.get("/api/rolls/<ref>")
def roll_detail(ref):
    roll_id = resolve_roll(ref)
    return jsonify(roll=roll_dict(get_roll(roll_id)), frames=frames_for(roll_id))


@app.patch("/api/rolls/<ref>")
def update_roll(ref):
    roll_id = resolve_roll(ref)
    data = request.get_json(silent=True) or {}
    fields = {
        "camera": lambda v: clean(v, 80),
        "film_stock": lambda v: clean(v, 80),
        "iso": clean_int,
        "exposures": clean_int,
        "title": lambda v: clean(v, 120),
        "description": lambda v: clean(v, 5000),
    }
    updates = {k: fn(data[k]) for k, fn in fields.items() if k in data}
    if updates:
        sets = ", ".join(f"{k} = ?" for k in updates)
        db().execute(f"UPDATE rolls SET {sets} WHERE id = ?", (*updates.values(), roll_id))
        db().commit()
        schedule_sync()
    return jsonify(roll=roll_dict(get_roll(roll_id)))


@app.post("/api/rolls/<ref>/finish")
def finish_roll(ref):
    roll_id = resolve_roll(ref)
    finished_at = clean((request.get_json(silent=True) or {}).get("finished_at"), 40) or now_iso()
    db().execute("UPDATE rolls SET finished_at = COALESCE(finished_at, ?) WHERE id = ?",
                 (finished_at, roll_id))
    db().commit()
    schedule_sync()
    return jsonify(roll=roll_dict(get_roll(roll_id)))


@app.post("/api/rolls/<ref>/reopen")
def reopen_roll(ref):
    roll_id = resolve_roll(ref)
    db().execute("UPDATE rolls SET finished_at = NULL WHERE id = ?", (roll_id,))
    db().commit()
    return jsonify(roll=roll_dict(get_roll(roll_id)))


@app.delete("/api/rolls/<ref>")
def delete_roll(ref):
    roll_id = resolve_roll(ref)
    db().execute("DELETE FROM rolls WHERE id = ?", (roll_id,))
    db().commit()
    shutil.rmtree(PHOTO_DIR / f"roll-{roll_id:04d}", ignore_errors=True)
    schedule_sync()
    return jsonify(ok=True)


def save_photo(roll_id, frame_no, upload):
    """Normalise to an upright JPEG, long edge <= 2048px."""
    folder = PHOTO_DIR / f"roll-{roll_id:04d}"
    folder.mkdir(parents=True, exist_ok=True)
    name = f"frame-{frame_no:02d}-{int(time.time())}.jpg"
    img = ImageOps.exif_transpose(Image.open(upload.stream))
    img = img.convert("RGB")
    img.thumbnail((2048, 2048))
    img.save(folder / name, "JPEG", quality=85)
    return f"roll-{roll_id:04d}/{name}"


@app.post("/api/rolls/<ref>/frames")
def save_frame(ref):
    roll_id = resolve_roll(ref)
    form = request.form
    frame_no = clean_int(form.get("frame_no"))
    if frame_no is None or frame_no < 0 or frame_no > 99:
        abort(400)
    existing = db().execute(
        "SELECT photo FROM frames WHERE roll_id = ? AND frame_no = ?", (roll_id, frame_no)
    ).fetchone()
    photo = existing["photo"] if existing else None
    if "photo" in request.files and request.files["photo"].filename:
        photo = save_photo(roll_id, frame_no, request.files["photo"])
        if existing and existing["photo"] and existing["photo"] != photo:
            (PHOTO_DIR / existing["photo"]).unlink(missing_ok=True)
    db().execute(
        """INSERT INTO frames (roll_id, frame_no, aperture, shutter, note, photo, shot_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (roll_id, frame_no) DO UPDATE SET
             aperture = excluded.aperture, shutter = excluded.shutter,
             note = excluded.note, photo = excluded.photo, shot_at = excluded.shot_at""",
        (roll_id, frame_no, clean(form.get("aperture"), 10), clean(form.get("shutter"), 10),
         clean(form.get("note"), 1000), photo, clean(form.get("shot_at"), 40) or now_iso()),
    )
    db().commit()
    schedule_sync()
    return jsonify(frames=frames_for(roll_id))


@app.delete("/api/rolls/<ref>/frames/<int:frame_no>")
def delete_frame(ref, frame_no):
    roll_id = resolve_roll(ref)
    row = db().execute(
        "SELECT photo FROM frames WHERE roll_id = ? AND frame_no = ?", (roll_id, frame_no)
    ).fetchone()
    if row and row["photo"]:
        (PHOTO_DIR / row["photo"]).unlink(missing_ok=True)
    db().execute("DELETE FROM frames WHERE roll_id = ? AND frame_no = ?", (roll_id, frame_no))
    db().commit()
    schedule_sync()
    return jsonify(frames=frames_for(roll_id))


@app.post("/api/sync")
def sync_now():
    sync_to_nas()
    return jsonify(sync=_sync_status)


init_db()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5010)), debug=True)
