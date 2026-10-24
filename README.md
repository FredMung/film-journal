# Film Journal

A small Flask web app for logging film frames from an iPhone. Installable as a PWA, works offline (queued writes sync when back online), stores everything in local SQLite and mirrors a snapshot, per-roll JSON and photos to a NAS share.

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/gunicorn --workers 1 --threads 4 --bind 0.0.0.0:5010 app:app
```

Then open `http://<host>:5010`. A systemd unit is included in `film-journal.service` (edit the user and paths to match your machine).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `FILM_JOURNAL_DATA_DIR` | `./data` | SQLite DB and photos |
| `FILM_JOURNAL_NAS_MOUNT` | `/mnt/nas-transit` | Mount point for the NAS mirror (skipped if not mounted) |

## Notes

There is no authentication — run it on a private network (LAN / Tailscale) only. iOS needs HTTPS for the PWA install, e.g. via `tailscale serve`.
