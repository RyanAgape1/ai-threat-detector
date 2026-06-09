import asyncio
import json
import os
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional
from uuid import uuid4

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

load_dotenv()

import audio_analyzer
import detector
import recordings_db
from evidence_bus import EvidenceBus
from models import DetectionEvent
from video_processor import VideoProcessor, StreamProcessor

RECORDINGS_DIR = Path(__file__).parent / "recordings"

# ---------------------------------------------------------------------------
# WebSocket connection registry
# ---------------------------------------------------------------------------

connected_websockets: set[WebSocket] = set()
_ws_lock = asyncio.Lock()
_frame_lock = asyncio.Lock()  # serialises YOLO calls — model is not thread-safe


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
stream_processor: Optional[StreamProcessor] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global bus, video_processor, stream_processor

    RECORDINGS_DIR.mkdir(exist_ok=True)
    recordings_db.init_db()

    bus = EvidenceBus(broadcast_fn=broadcast)
    bus.start()
    video_processor = VideoProcessor(bus_ingest=bus.ingest, broadcast_fn=broadcast)
    stream_processor = StreamProcessor(recordings_dir=str(RECORDINGS_DIR))

    await asyncio.get_event_loop().run_in_executor(None, detector.load_model)

    print("Backend running on http://localhost:8000")
    yield

    if bus._cleanup_task:
        bus._cleanup_task.cancel()


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
    stream_processor.reset()
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


@app.post("/stream/frame")
async def stream_frame(frame: UploadFile = File(...)) -> dict:
    """Accept a single JPEG frame from the browser camera, run detection, feed events."""
    contents = await frame.read()
    loop = asyncio.get_event_loop()
    async with _frame_lock:
        events, frame_b64 = await loop.run_in_executor(None, stream_processor.process_frame_bytes, contents)
    for event in events:
        await bus.ingest(event, frame_b64)
    return {"status": "ok", "events": len(events)}


@app.post("/stream/audio")
async def stream_audio(
    audio: UploadFile = File(...),
    rms: float = Form(0.0),
) -> dict:
    """Accept a 2-second audio chunk from the browser mic, run Whisper, inject real events."""
    contents = await audio.read()
    events = await audio_analyzer.analyze_audio_chunk(
        contents, audio.filename or "audio.webm", rms
    )
    for event in events:
        await bus.ingest(event)
    return {"status": "ok", "events": len(events)}


@app.post("/stream/reset")
async def stream_reset() -> dict:
    """Finalize recording and reset stream processor state (call when camera stops)."""
    meta = stream_processor.stop_recording()
    if meta:
        recordings_db.save_recording(**meta)
        print(f"[recording] saved {meta['filename']} ({meta['frame_count']} frames, {meta['duration_seconds']:.1f}s)")
    stream_processor.reset()
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
# Entry point (for running directly with `python main.py`)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
