import sqlite3
from pathlib import Path
from typing import Optional

DB_PATH = Path(__file__).parent / "recordings.db"


def init_db() -> None:
    with sqlite3.connect(str(DB_PATH)) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS recordings (
                id TEXT PRIMARY KEY,
                started_at REAL NOT NULL,
                ended_at REAL NOT NULL,
                filename TEXT NOT NULL,
                filepath TEXT NOT NULL,
                duration_seconds REAL NOT NULL,
                frame_count INTEGER NOT NULL DEFAULT 0,
                filesize_bytes INTEGER NOT NULL DEFAULT 0
            )
        """)
        conn.commit()


def save_recording(
    id: str,
    started_at: float,
    ended_at: float,
    filename: str,
    filepath: str,
    duration_seconds: float,
    frame_count: int,
    filesize_bytes: int,
) -> None:
    with sqlite3.connect(str(DB_PATH)) as conn:
        conn.execute(
            """INSERT OR REPLACE INTO recordings
               (id, started_at, ended_at, filename, filepath,
                duration_seconds, frame_count, filesize_bytes)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (id, started_at, ended_at, filename, filepath,
             duration_seconds, frame_count, filesize_bytes),
        )
        conn.commit()


def list_recordings() -> list[dict]:
    with sqlite3.connect(str(DB_PATH)) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM recordings ORDER BY started_at DESC"
        ).fetchall()
        return [dict(row) for row in rows]


def get_recording(id: str) -> Optional[dict]:
    with sqlite3.connect(str(DB_PATH)) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT * FROM recordings WHERE id = ?", (id,)
        ).fetchone()
        return dict(row) if row else None


def delete_recording_row(id: str) -> Optional[str]:
    """Remove from DB and return the filepath, or None if not found."""
    with sqlite3.connect(str(DB_PATH)) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT filepath FROM recordings WHERE id = ?", (id,)
        ).fetchone()
        if not row:
            return None
        filepath = row["filepath"]
        conn.execute("DELETE FROM recordings WHERE id = ?", (id,))
        conn.commit()
        return filepath
