import json
import sqlite3
import time
from pathlib import Path
from typing import Optional

DB_PATH = Path(__file__).parent / "recordings.db"


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with _connect() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS recordings (
                id TEXT PRIMARY KEY,
                started_at REAL NOT NULL,
                ended_at REAL NOT NULL,
                filename TEXT NOT NULL,
                filepath TEXT NOT NULL,
                duration_seconds REAL NOT NULL,
                frame_count INTEGER NOT NULL DEFAULT 0,
                filesize_bytes INTEGER NOT NULL DEFAULT 0,
                session_id TEXT
            )
        """)
        # Migrate existing databases that predate the session_id column
        try:
            conn.execute("ALTER TABLE recordings ADD COLUMN session_id TEXT")
            conn.commit()
        except Exception:
            pass  # Column already exists
        conn.execute("""
            CREATE TABLE IF NOT EXISTS activities (
                id TEXT PRIMARY KEY,
                started_at REAL NOT NULL,
                closed_at REAL,
                status TEXT NOT NULL DEFAULT 'closed',
                summary_json TEXT,
                camera_id TEXT
            )
        """)
        try:
            conn.execute("ALTER TABLE activities ADD COLUMN camera_id TEXT")
            conn.commit()
        except Exception:
            pass  # Column already exists
        conn.execute("""
            CREATE TABLE IF NOT EXISTS detection_events (
                id TEXT PRIMARY KEY,
                activity_id TEXT NOT NULL,
                timestamp REAL NOT NULL,
                source TEXT NOT NULL,
                type TEXT NOT NULL,
                confidence REAL NOT NULL,
                metadata_json TEXT NOT NULL DEFAULT '{}'
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS explanations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                activity_id TEXT NOT NULL,
                created_at REAL NOT NULL,
                explanation_json TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS reports (
                id TEXT PRIMARY KEY,
                generated_at REAL NOT NULL,
                time_from REAL NOT NULL,
                time_to REAL NOT NULL,
                narrative TEXT NOT NULL,
                important_events_json TEXT NOT NULL DEFAULT '[]',
                person_journeys_json TEXT NOT NULL DEFAULT '[]'
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_events_activity ON detection_events(activity_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_explanations_activity ON explanations(activity_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_activities_time ON activities(started_at, closed_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_reports_time ON reports(generated_at)")
        conn.commit()


# ---------------------------------------------------------------------------
# Recordings
# ---------------------------------------------------------------------------

def save_recording(
    id: str,
    started_at: float,
    ended_at: float,
    filename: str,
    filepath: str,
    duration_seconds: float,
    frame_count: int,
    filesize_bytes: int,
    session_id: Optional[str] = None,
) -> None:
    with _connect() as conn:
        conn.execute(
            """INSERT OR REPLACE INTO recordings
               (id, started_at, ended_at, filename, filepath,
                duration_seconds, frame_count, filesize_bytes, session_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (id, started_at, ended_at, filename, filepath,
             duration_seconds, frame_count, filesize_bytes, session_id),
        )
        conn.commit()


def list_recordings() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM recordings ORDER BY started_at DESC"
        ).fetchall()
        return [dict(row) for row in rows]


def get_recording(id: str) -> Optional[dict]:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM recordings WHERE id = ?", (id,)
        ).fetchone()
        return dict(row) if row else None


def delete_recording_row(id: str) -> Optional[str]:
    """Remove from DB and return the filepath, or None if not found."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT filepath FROM recordings WHERE id = ?", (id,)
        ).fetchone()
        if not row:
            return None
        filepath = row["filepath"]
        conn.execute("DELETE FROM recordings WHERE id = ?", (id,))
        conn.commit()
        return filepath


# ---------------------------------------------------------------------------
# Activities
# ---------------------------------------------------------------------------

def save_activity(activity) -> None:
    """Persist a closed activity with all its events. Called when activity closes."""
    with _connect() as conn:
        conn.execute(
            """INSERT OR REPLACE INTO activities (id, started_at, closed_at, status, summary_json, camera_id)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                activity.id,
                activity.started_at,
                activity.closed_at,
                activity.status,
                json.dumps(activity.summary.model_dump()) if activity.summary else None,
                getattr(activity, 'camera_id', None),
            ),
        )
        for event in activity.events:
            conn.execute(
                """INSERT OR REPLACE INTO detection_events
                   (id, activity_id, timestamp, source, type, confidence, metadata_json)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    event.id,
                    activity.id,
                    event.timestamp,
                    event.source,
                    event.type,
                    event.confidence,
                    json.dumps(event.metadata),
                ),
            )
        conn.commit()


def save_explanation(activity_id: str, explanation) -> None:
    """Persist a live reasoning update for an activity."""
    with _connect() as conn:
        conn.execute(
            """INSERT INTO explanations (activity_id, created_at, explanation_json)
               VALUES (?, ?, ?)""",
            (activity_id, time.time(), json.dumps(explanation.model_dump())),
        )
        conn.commit()


def get_activities_for_recording(recording_id: str) -> list[dict]:
    """Return activities that belong to this recording's camera and time window.

    Activities now carry a camera_id that matches the recording's session_id, so
    filtering is a simple equality check rather than JSON extraction.
    Legacy recordings (no session_id) return all time-overlapping activities.
    """
    rec = get_recording(recording_id)
    if rec is None:
        return []

    window_start = rec["started_at"] - 5
    window_end = rec["ended_at"] + 5
    session_id = rec.get("session_id")

    with _connect() as conn:
        if session_id:
            act_rows = conn.execute(
                """SELECT * FROM activities
                   WHERE started_at <= ? AND (closed_at IS NULL OR closed_at >= ?)
                     AND camera_id = ?
                   ORDER BY started_at ASC""",
                (window_end, window_start, session_id),
            ).fetchall()
        else:
            act_rows = conn.execute(
                """SELECT * FROM activities
                   WHERE started_at <= ? AND (closed_at IS NULL OR closed_at >= ?)
                   ORDER BY started_at ASC""",
                (window_end, window_start),
            ).fetchall()

        result = []
        for act_row in act_rows:
            act = dict(act_row)
            act["summary"] = json.loads(act.pop("summary_json")) if act.get("summary_json") else None

            event_rows = conn.execute(
                "SELECT * FROM detection_events WHERE activity_id = ? ORDER BY timestamp ASC",
                (act["id"],),
            ).fetchall()
            act["events"] = []
            for e in event_rows:
                ed = dict(e)
                ed["metadata"] = json.loads(ed.pop("metadata_json"))
                act["events"].append(ed)

            expl_rows = conn.execute(
                "SELECT explanation_json, created_at FROM explanations WHERE activity_id = ? ORDER BY created_at ASC",
                (act["id"],),
            ).fetchall()
            act["explanations"] = [
                {**json.loads(r["explanation_json"]), "created_at": r["created_at"]}
                for r in expl_rows
            ]

            result.append(act)

        return result


# ---------------------------------------------------------------------------
# Activity range query (used by report generator)
# ---------------------------------------------------------------------------

def get_activities_in_range(time_from: float, time_to: float) -> list[dict]:
    """Return all persisted activities (with events) that overlap [time_from, time_to]."""
    with _connect() as conn:
        act_rows = conn.execute(
            """SELECT * FROM activities
               WHERE started_at <= ? AND (closed_at IS NULL OR closed_at >= ?)
               ORDER BY started_at ASC""",
            (time_to, time_from),
        ).fetchall()

        result = []
        for act_row in act_rows:
            act = dict(act_row)
            act["summary"] = json.loads(act.pop("summary_json")) if act.get("summary_json") else None

            event_rows = conn.execute(
                "SELECT * FROM detection_events WHERE activity_id = ? ORDER BY timestamp ASC",
                (act["id"],),
            ).fetchall()
            act["events"] = []
            for e in event_rows:
                ed = dict(e)
                ed["metadata"] = json.loads(ed.pop("metadata_json"))
                act["events"].append(ed)

            result.append(act)
        return result


# ---------------------------------------------------------------------------
# Reports
# ---------------------------------------------------------------------------

def save_report(
    id: str,
    generated_at: float,
    time_from: float,
    time_to: float,
    narrative: str,
    important_events: list,
    person_journeys: list,
) -> None:
    with _connect() as conn:
        conn.execute(
            """INSERT OR REPLACE INTO reports
               (id, generated_at, time_from, time_to, narrative,
                important_events_json, person_journeys_json)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                id, generated_at, time_from, time_to, narrative,
                json.dumps(important_events),
                json.dumps(person_journeys),
            ),
        )
        conn.commit()


def list_reports() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            """SELECT id, generated_at, time_from, time_to,
                      substr(narrative, 1, 200) AS narrative_preview
               FROM reports ORDER BY generated_at DESC"""
        ).fetchall()
        return [dict(row) for row in rows]


def get_report(id: str) -> Optional[dict]:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM reports WHERE id = ?", (id,)).fetchone()
        if not row:
            return None
        r = dict(row)
        r["important_events"] = json.loads(r.pop("important_events_json"))
        r["person_journeys"] = json.loads(r.pop("person_journeys_json"))
        return r


def delete_report(id: str) -> bool:
    with _connect() as conn:
        result = conn.execute("DELETE FROM reports WHERE id = ?", (id,))
        conn.commit()
        return result.rowcount > 0
