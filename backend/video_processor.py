import asyncio
import base64
import os
import time
from typing import Callable, Dict, List, Optional, Tuple
from uuid import uuid4

import cv2
import numpy as np

import audio_analyzer
import detector
from models import DetectionEvent


class VideoProcessor:
    def __init__(self, bus_ingest: Callable, broadcast_fn: Callable):
        self.bus_ingest = bus_ingest
        self.broadcast = broadcast_fn
        self.jobs: Dict[str, dict] = {}

    async def start(self, video_path: str, job_id: str, filename: str) -> None:
        self.jobs[job_id] = {
            "status": "processing",
            "filename": filename,
            "current_frame": 0,
            "total_frames": 0,
        }
        asyncio.create_task(self._run(video_path, job_id, filename))

    async def _run(self, video_path: str, job_id: str, filename: str) -> None:
        try:
            await self._process(video_path, job_id, filename)
        except Exception as e:
            self.jobs[job_id]["status"] = "error"
            self.jobs[job_id]["error"] = str(e)
            await self.broadcast({
                "type": "upload_progress",
                "job_id": job_id,
                "filename": filename,
                "current_frame": 0,
                "total_frames": 0,
                "status": "error",
                "error": str(e),
            })
        finally:
            try:
                os.unlink(video_path)
            except OSError:
                pass

    async def _process(self, video_path: str, job_id: str, filename: str) -> None:
        # Analyse the video's audio track concurrently with frame processing.
        # No-ops silently if ffmpeg is not installed or there is no audio track.
        audio_task = asyncio.create_task(
            audio_analyzer.process_video_audio(video_path, self.bus_ingest)
        )

        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            raise ValueError("Could not open video file")

        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        # Sample at ~2 fps
        sample_every = max(1, int(fps / 2))

        self.jobs[job_id]["total_frames"] = total_frames
        await self.broadcast({
            "type": "upload_progress",
            "job_id": job_id,
            "filename": filename,
            "current_frame": 0,
            "total_frames": total_frames,
            "status": "processing",
        })

        prev_gray: Optional[np.ndarray] = None
        frame_num = 0
        sampled = 0

        while cap.isOpened():
            ret, frame = cap.read()
            if not ret:
                break

            if frame_num % sample_every == 0:
                events = detector.detect(frame, prev_gray, frame_num, fps=fps)
                frame_b64: Optional[str] = None
                if events:
                    frame_b64 = _encode_frame(frame)
                for event in events:
                    await self.bus_ingest(event, frame_b64)
                    await asyncio.sleep(0.05)

                prev_gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                sampled += 1
                self.jobs[job_id]["current_frame"] = frame_num

                await self.broadcast({
                    "type": "upload_progress",
                    "job_id": job_id,
                    "filename": filename,
                    "current_frame": frame_num,
                    "total_frames": total_frames,
                    "status": "processing",
                })

                # Pace at ~2x real-time so it feels like live analysis
                await asyncio.sleep(0.25)

            frame_num += 1

        cap.release()
        await audio_task  # ensure audio processing finishes before file cleanup

        self.jobs[job_id]["status"] = "done"
        self.jobs[job_id]["current_frame"] = total_frames
        await self.broadcast({
            "type": "upload_progress",
            "job_id": job_id,
            "filename": filename,
            "current_frame": total_frames,
            "total_frames": total_frames,
            "status": "done",
        })


def _encode_frame(frame: np.ndarray, max_width: int = 640) -> Optional[str]:
    """Resize frame to max_width, encode as JPEG, return base64 string."""
    h, w = frame.shape[:2]
    if w > max_width:
        scale = max_width / w
        frame = cv2.resize(frame, (max_width, int(h * scale)))
    ok, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 60])
    if not ok:
        return None
    return base64.b64encode(buf.tobytes()).decode()


# ---------------------------------------------------------------------------
# StreamProcessor — for live camera frames POSTed one at a time
# ---------------------------------------------------------------------------

class StreamProcessor:
    """Stateful processor for real-time camera frames. Call process_frame_bytes()
    once per captured frame; it maintains prev_gray between calls for motion detection.

    If recordings_dir is provided, each camera session is automatically recorded as an
    MP4 file. Call stop_recording() before reset() to finalize and get metadata."""

    MIN_FRAMES_TO_SAVE = 5  # don't save recordings shorter than ~2.5 s

    def __init__(self, recordings_dir: Optional[str] = None):
        self._prev_gray: Optional[np.ndarray] = None
        self._frame_count: int = 0
        self._recordings_dir = recordings_dir
        # Recording state (reset between sessions)
        self._rec_id: Optional[str] = None
        self._rec_path: Optional[str] = None
        self._rec_start: Optional[float] = None
        self._rec_frames: int = 0
        self._writer: Optional[cv2.VideoWriter] = None

    def process_frame_bytes(self, jpeg_bytes: bytes) -> Tuple[list, Optional[str]]:
        """Returns (events, frame_b64). frame_b64 is set only when events were detected."""
        nparr = np.frombuffer(jpeg_bytes, np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if frame is None:
            return [], None

        # Record this frame — isolated in try/except so any writer failure
        # never prevents detection from running.
        try:
            if self._recordings_dir is not None and self._rec_path is None:
                self._rec_id = str(uuid4())
                filename = f"recording_{int(time.time())}.mp4"
                self._rec_path = os.path.join(self._recordings_dir, filename)
                self._rec_start = time.time()
                self._rec_frames = 0

            if self._rec_path is not None and self._writer is None:
                h, w = frame.shape[:2]
                for codec in ('avc1', 'mp4v'):
                    fourcc = cv2.VideoWriter_fourcc(*codec)
                    writer = cv2.VideoWriter(self._rec_path, fourcc, 2.0, (w, h))
                    if writer.isOpened():
                        self._writer = writer
                        print(f"[recording] started ({codec}) -> {self._rec_path} ({w}x{h})")
                        break
                    writer.release()
                else:
                    print("[recording] VideoWriter failed to open with any codec")

            if self._writer is not None:
                self._writer.write(frame)
                self._rec_frames += 1
        except Exception as exc:
            print(f"[recording] write error: {exc}")

        is_first_frame = (self._frame_count == 0)
        events = detector.detect(frame, self._prev_gray, self._frame_count, fps=2.0)
        self._prev_gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        self._frame_count += 1

        # First frame of a new camera session: guarantee an activity opens even
        # if YOLO sees nothing yet (prev_gray is None, motion detection is skipped).
        if is_first_frame and not events:
            events = [DetectionEvent(
                source='behavior',
                type='live_feed_started',
                confidence=1.0,
                metadata={'frame_id': 0},
            )]

        frame_b64 = _encode_frame(frame) if events else None
        return events, frame_b64

    def stop_recording(self) -> Optional[dict]:
        """Finalize the current recording and return its metadata, or None if nothing
        worth saving (too short or no recording was active)."""
        if self._writer is not None:
            self._writer.release()
            self._writer = None

        if self._rec_path is None or self._rec_frames < self.MIN_FRAMES_TO_SAVE:
            if self._rec_path and os.path.exists(self._rec_path):
                os.unlink(self._rec_path)
            print(f"[recording] discarded - {self._rec_frames} frames (need {self.MIN_FRAMES_TO_SAVE}+)")
            self._rec_id = self._rec_path = self._rec_start = None
            self._rec_frames = 0
            return None

        ended_at = time.time()
        meta = {
            "id": self._rec_id,
            "filepath": self._rec_path,
            "filename": os.path.basename(self._rec_path),
            "started_at": self._rec_start,
            "ended_at": ended_at,
            "duration_seconds": ended_at - (self._rec_start or ended_at),
            "frame_count": self._rec_frames,
            "filesize_bytes": os.path.getsize(self._rec_path) if os.path.exists(self._rec_path) else 0,
        }
        self._rec_id = self._rec_path = self._rec_start = None
        self._rec_frames = 0
        return meta

    def reset(self):
        self._prev_gray = None
        self._frame_count = 0
