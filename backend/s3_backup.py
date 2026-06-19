"""
S3 backup utilities.

Requires in .env:
  AWS_ACCESS_KEY_ID
  AWS_SECRET_ACCESS_KEY
  AWS_S3_BUCKET
  AWS_REGION        (optional, defaults to us-east-1)

S3 layout:
  <bucket>/db/recordings_<timestamp>.db   — periodic DB snapshots
  <bucket>/recordings/<filename>          — video files
"""
import asyncio
import os
import sqlite3
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

_s3_client = None


def is_configured() -> bool:
    return bool(
        os.environ.get("AWS_ACCESS_KEY_ID")
        and os.environ.get("AWS_SECRET_ACCESS_KEY")
        and os.environ.get("AWS_S3_BUCKET")
    )


def _client():
    global _s3_client
    if _s3_client is None:
        import boto3
        _s3_client = boto3.client(
            "s3",
            aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID"),
            aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
            region_name=os.environ.get("AWS_REGION", "us-east-1"),
        )
    return _s3_client


# ---------------------------------------------------------------------------
# DB snapshot
# ---------------------------------------------------------------------------

def backup_db(db_path: Path) -> bool:
    """Snapshot the SQLite DB via the backup API and upload to S3."""
    if not is_configured():
        return False
    tmp_path: Optional[str] = None
    try:
        bucket = os.environ["AWS_S3_BUCKET"]
        timestamp = datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")
        s3_key = f"db/recordings_{timestamp}.db"

        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
            tmp_path = f.name

        with sqlite3.connect(str(db_path)) as src, sqlite3.connect(tmp_path) as dst:
            src.backup(dst)

        _client().upload_file(tmp_path, bucket, s3_key)
        print(f"[s3] DB snapshot -> s3://{bucket}/{s3_key}")
        return True
    except Exception as exc:
        print(f"[s3] DB backup failed: {exc}")
        return False
    finally:
        if tmp_path:
            Path(tmp_path).unlink(missing_ok=True)


async def backup_db_async(db_path: Path) -> bool:
    return await asyncio.get_event_loop().run_in_executor(None, backup_db, db_path)


# ---------------------------------------------------------------------------
# Recording video upload
# ---------------------------------------------------------------------------

def backup_recording(filepath: str, filename: str) -> bool:
    """Upload a finalized recording video file to S3."""
    if not is_configured():
        return False
    try:
        bucket = os.environ["AWS_S3_BUCKET"]
        s3_key = f"recordings/{filename}"
        _client().upload_file(filepath, bucket, s3_key)
        print(f"[s3] Recording -> s3://{bucket}/{s3_key}")
        return True
    except Exception as exc:
        print(f"[s3] Recording upload failed: {exc}")
        return False


async def backup_recording_async(filepath: str, filename: str) -> bool:
    return await asyncio.get_event_loop().run_in_executor(
        None, backup_recording, filepath, filename
    )
