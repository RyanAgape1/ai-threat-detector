import asyncio
import json
import os
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Dict, Optional
from uuid import uuid4

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from pydantic import BaseModel as PydanticBaseModel
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

load_dotenv()

import audio_analyzer
import detector
import environment_agent
import environment_config
import recordings_db
import report_generator
import s3_backup
from evidence_bus import EvidenceBus
from global_person_registry import GlobalPersonRegistry
from models import DetectionEvent
from video_processor import VideoProcessor, StreamProcessor

RECORDINGS_DIR = Path(__file__).parent / "recordings"

# ---------------------------------------------------------------------------
# WebSocket connection registry
# ---------------------------------------------------------------------------

connected_websockets: set[WebSocket] = set()
_ws_lock = asyncio.Lock()

# Per-session state for live camera streams
stream_processors: Dict[str, "StreamProcessor"] = {}
_frame_locks: Dict[str, asyncio.Lock] = {}

# Cross-camera person Re-ID registry (shared across all camera sessions)
person_registry = GlobalPersonRegistry()


async def broadcast(message: dict) -> None:
    """Send a JSON message to all connected WebSocket clients."""
    if not connected_websockets:
        return

    payload = json.dumps(message)
    dead: set[WebSocket] = set()

    async with _ws_lock:
        for ws in list(connected_websockets):
            try:
                await ws.send_text(payload)
            except Exception:
                dead.add(ws)

        for ws in dead:
            connected_websockets.discard(ws)


# ---------------------------------------------------------------------------
# App-level singletons
# ---------------------------------------------------------------------------

bus: Optional[EvidenceBus] = None
video_processor: Optional[VideoProcessor] = None


DB_BACKUP_INTERVAL = 3600  # seconds between automatic DB snapshots


async def _db_backup_loop() -> None:
    while True:
        await asyncio.sleep(DB_BACKUP_INTERVAL)
        await s3_backup.backup_db_async(recordings_db.DB_PATH)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global bus, video_processor

    RECORDINGS_DIR.mkdir(exist_ok=True)
    recordings_db.init_db()
    purged = recordings_db.purge_orphaned_activities()
    if purged:
        print(f"[startup] purged {purged} orphaned activities with no matching recording")

    bus = EvidenceBus(broadcast_fn=broadcast)
    bus.start()
    video_processor = VideoProcessor(bus_ingest=bus.ingest, broadcast_fn=broadcast)

    await asyncio.get_event_loop().run_in_executor(None, detector.load_model)

    db_backup_task = asyncio.create_task(_db_backup_loop())
    if s3_backup.is_configured():
        print("[s3] S3 backup enabled - DB snapshots every hour, recordings uploaded on save")
    else:
        print("[s3] S3 not configured — set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_S3_BUCKET to enable")

    print("Backend running on http://localhost:8000")
    yield

    db_backup_task.cancel()
    if bus._cleanup_task:
        bus._cleanup_task.cancel()
    # Finalize any active camera recordings on shutdown
    for sid, proc in list(stream_processors.items()):
        meta = proc.stop_recording()
        if meta:
            recordings_db.save_recording(**meta, session_id=sid)
            s3_backup.backup_recording(meta["filepath"], meta["filename"])
    stream_processors.clear()
    _frame_locks.clear()


# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------

app = FastAPI(title="Anomaly Explanation Engine", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------


@app.post("/events")
async def post_event(event: DetectionEvent) -> dict:
    """Ingest a detection event and return the incident it was assigned to."""
    incident_id = await bus.ingest(event)
    return {"incident_id": incident_id}


@app.get("/activities")
async def list_activities() -> list[dict]:
    """Return all activities (active and closed)."""
    return [a.model_dump() for a in bus.activities.values()]


@app.post("/activities/clear")
async def clear_activities() -> dict:
    """Wipe all activity history and reset stream state."""
    for task in list(bus._reasoning_tasks.values()):
        task.cancel()
    for handle in list(bus._close_timers.values()):
        handle.cancel()
    bus.activities.clear()
    bus._locks.clear()
    bus._reasoning_tasks.clear()
    bus._close_timers.clear()
    bus._event_counts_since_last_reason.clear()
    bus._frames.clear()
    for proc in list(stream_processors.values()):
        proc.reset()
    stream_processors.clear()
    _frame_locks.clear()
    await broadcast({"type": "all_activities", "activities": []})
    return {"status": "cleared"}


@app.get("/activities/{activity_id}")
async def get_activity(activity_id: str) -> dict:
    """Return a single activity by ID."""
    activity = bus.activities.get(activity_id)
    if activity is None:
        raise HTTPException(status_code=404, detail="Activity not found")
    return activity.model_dump()


# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()

    # Register this connection
    async with _ws_lock:
        connected_websockets.add(websocket)

    # Send the current state of all activities to the new client
    all_activities = [a.model_dump() for a in bus.activities.values()]
    try:
        await websocket.send_text(
            json.dumps({"type": "all_activities", "activities": all_activities})
        )
    except Exception:
        async with _ws_lock:
            connected_websockets.discard(websocket)
        return

    # Keep the connection alive until the client disconnects
    try:
        while True:
            # We don't expect messages from clients, but we must await
            # something to detect disconnects without busy-looping.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        async with _ws_lock:
            connected_websockets.discard(websocket)


# ---------------------------------------------------------------------------
# Video upload
# ---------------------------------------------------------------------------

ALLOWED_VIDEO_TYPES = {"video/mp4", "video/avi", "video/mov", "video/quicktime", "video/x-msvideo", "video/webm"}


@app.post("/upload")
async def upload_video(file: UploadFile = File(...)) -> dict:
    """Accept a video file, save to temp, start background frame analysis."""
    if file.content_type and file.content_type not in ALLOWED_VIDEO_TYPES:
        raise HTTPException(status_code=415, detail=f"Unsupported media type: {file.content_type}")

    suffix = Path(file.filename).suffix if file.filename else ".mp4"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        content = await file.read()
        tmp.write(content)
    finally:
        tmp.close()

    job_id = str(uuid4())
    await video_processor.start(tmp.name, job_id, file.filename or "video")
    return {"job_id": job_id}


@app.get("/upload/{job_id}")
async def upload_status(job_id: str) -> dict:
    job = video_processor.jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


# ---------------------------------------------------------------------------
# Live camera stream
# ---------------------------------------------------------------------------


@app.post("/stream/start")
async def stream_start(camera_label: str = Form("")) -> dict:
    """Create a new camera session. Returns session_id for subsequent frame/audio/reset calls."""
    session_id = str(uuid4())
    stream_processors[session_id] = StreamProcessor(
        recordings_dir=str(RECORDINGS_DIR),
        camera_id=session_id,
        registry=person_registry,
    )
    _frame_locks[session_id] = asyncio.Lock()
    return {"session_id": session_id}


@app.post("/stream/frame")
async def stream_frame(
    frame: UploadFile = File(...),
    session_id: str = Form(...),
) -> dict:
    """Accept a single JPEG frame from a camera session, run detection, feed events."""
    processor = stream_processors.get(session_id)
    lock = _frame_locks.get(session_id)
    if processor is None or lock is None:
        raise HTTPException(status_code=404, detail="Session not found")
    contents = await frame.read()
    loop = asyncio.get_event_loop()
    async with lock:
        events, frame_b64, checkpoint_meta = await loop.run_in_executor(None, processor.process_frame_bytes, contents)
    if checkpoint_meta:
        recordings_db.save_recording(**checkpoint_meta, session_id=session_id)
        asyncio.create_task(s3_backup.backup_recording_async(checkpoint_meta["filepath"], checkpoint_meta["filename"]))
    for event in events:
        event.metadata["camera_id"] = session_id
        await bus.ingest(event, frame_b64)
    return {"status": "ok", "events": len(events)}


@app.post("/stream/audio")
async def stream_audio(
    audio: UploadFile = File(...),
    rms: float = Form(0.0),
    session_id: str = Form(""),
) -> dict:
    """Accept a 2-second audio chunk from a camera session, run Whisper, inject events."""
    contents = await audio.read()
    events = await audio_analyzer.analyze_audio_chunk(
        contents, audio.filename or "audio.webm", rms
    )
    for event in events:
        if session_id:
            event.metadata["camera_id"] = session_id
        await bus.ingest(event)
    return {"status": "ok", "events": len(events)}


@app.post("/stream/reset")
async def stream_reset(session_id: str = Form(...)) -> dict:
    """Finalize recording and tear down a camera session."""
    processor = stream_processors.pop(session_id, None)
    _frame_locks.pop(session_id, None)
    if processor is not None:
        meta = processor.stop_recording()
        if meta:
            recordings_db.save_recording(**meta, session_id=session_id)
            print(f"[recording] saved {meta['filename']} ({meta['frame_count']} frames, {meta['duration_seconds']:.1f}s)")
            asyncio.create_task(s3_backup.backup_recording_async(meta["filepath"], meta["filename"]))
    return {"status": "reset"}


# ---------------------------------------------------------------------------
# Recordings
# ---------------------------------------------------------------------------


@app.get("/recordings")
async def list_recordings() -> list[dict]:
    rows = recordings_db.list_recordings()
    valid = []
    for row in rows:
        if Path(row["filepath"]).exists():
            valid.append(row)
        else:
            # File was deleted externally — clean up the DB entry too
            recordings_db.delete_recording_row(row["id"])
    return valid


@app.get("/recordings/{recording_id}/video")
async def get_recording_video(recording_id: str) -> FileResponse:
    rec = recordings_db.get_recording(recording_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="Recording not found")
    filepath = rec["filepath"]
    if not Path(filepath).exists():
        raise HTTPException(status_code=404, detail="Recording file missing")
    return FileResponse(filepath, media_type="video/mp4", filename=rec["filename"])


@app.get("/recordings/{recording_id}/activities")
async def get_recording_activities(recording_id: str) -> list[dict]:
    rec = recordings_db.get_recording(recording_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="Recording not found")
    return recordings_db.get_activities_for_recording(recording_id)


@app.delete("/recordings/{recording_id}")
async def delete_recording(recording_id: str) -> dict:
    filepath = recordings_db.delete_recording_row(recording_id)
    if filepath is None:
        raise HTTPException(status_code=404, detail="Recording not found")
    try:
        Path(filepath).unlink(missing_ok=True)
    except OSError as e:
        print(f"[recording] failed to delete file {filepath}: {e}")
    return {"status": "deleted"}


# ---------------------------------------------------------------------------
# Reports
# ---------------------------------------------------------------------------


class GenerateReportRequest(PydanticBaseModel):
    time_from: float
    time_to: float


@app.post("/reports/generate")
async def generate_report_endpoint(req: GenerateReportRequest) -> dict:
    """Generate an activity report for the given UTC epoch time range."""
    try:
        return await report_generator.generate_report(req.time_from, req.time_to)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/reports")
async def list_reports_endpoint() -> list[dict]:
    return recordings_db.list_reports()


@app.get("/reports/{report_id}")
async def get_report_endpoint(report_id: str) -> dict:
    report = recordings_db.get_report(report_id)
    if report is None:
        raise HTTPException(status_code=404, detail="Report not found")
    return report


@app.delete("/reports/{report_id}")
async def delete_report_endpoint(report_id: str) -> dict:
    if not recordings_db.delete_report(report_id):
        raise HTTPException(status_code=404, detail="Report not found")
    return {"status": "deleted"}


# ---------------------------------------------------------------------------
# Environment configuration agent
# ---------------------------------------------------------------------------


class EnvironmentConfigRequest(PydanticBaseModel):
    env_type: str
    concerns: str = ""
    context: str = ""
    business_hours_open: Optional[str] = None   # "HH:MM" 24h
    business_hours_close: Optional[str] = None  # "HH:MM" 24h
    business_days: Optional[list] = None        # [0-6] Mon=0 Sun=6


@app.post("/environment/configure")
async def configure_environment_endpoint(req: EnvironmentConfigRequest) -> dict:
    """Run the AI agent to tune detection thresholds for a specific environment."""
    try:
        return await environment_agent.configure_environment(
            req.env_type, req.concerns, req.context,
            req.business_hours_open, req.business_hours_close, req.business_days,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/environment/config")
async def get_environment_config() -> dict:
    """Return the current environment configuration."""
    return environment_config.load_config()


# ---------------------------------------------------------------------------
# Entry point (for running directly with `python main.py`)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
