import asyncio
import base64
import math
import os
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Tuple
from uuid import uuid4

import cv2
import numpy as np

import audio_analyzer
import detector
import environment_config as _env
import reid
from global_person_registry import GlobalPersonRegistry
from models import DetectionEvent


# ---------------------------------------------------------------------------
# Person tracking helpers
# ---------------------------------------------------------------------------

LOITERING_SECONDS = 30.0
TRACK_TIMEOUT_SECONDS = 5.0   # drop a track if unseen for this long
TRACK_MAX_DISTANCE = 0.35     # max normalised centroid distance to match (0–1 diagonal)
REID_MIN_FRAMES = 3           # consecutive frames a track must exist before Re-ID runs
REID_AREA_GATE = 0.04         # bbox must be >= 4% of frame area for Re-ID
CHECKPOINT_INTERVAL = 1800    # seconds between mid-session recording checkpoints (30 min)


@dataclass
class _PersonTrack:
    track_id: int
    first_seen: float
    last_seen: float
    cx: float   # normalised centroid x (0–1)
    cy: float   # normalised centroid y (0–1)
    confidence: float = 0.0
    bbox: Optional[dict] = None                # last known pixel bounding box for annotation
    announced: bool = False             # person_detected already emitted
    last_loitering_at: Optional[float] = None  # wall-clock time of last loitering_detected
    global_person_id: Optional[str] = None     # assigned by GlobalPersonRegistry
    frames_seen: int = 0                # consecutive frames this track has been matched
    reid_done: bool = False             # Re-ID has been attempted on a stable crop


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

    def __init__(
        self,
        recordings_dir: Optional[str] = None,
        camera_id: Optional[str] = None,
        registry: Optional[GlobalPersonRegistry] = None,
    ):
        self._prev_gray: Optional[np.ndarray] = None
        self._frame_count: int = 0
        self._recordings_dir = recordings_dir
        self._camera_id = camera_id
        self._registry = registry
        # Recording state (reset between sessions)
        self._rec_id: Optional[str] = None
        self._rec_path: Optional[str] = None
        self._rec_start: Optional[float] = None
        self._rec_frames: int = 0
        self._rec_frame_offset: int = 0  # _frame_count value at start of current segment
        self._writer: Optional[cv2.VideoWriter] = None
        # Person tracking state
        self._person_tracks: Dict[int, _PersonTrack] = {}
        self._next_track_id: int = 0

    def process_frame_bytes(self, jpeg_bytes: bytes) -> Tuple[list, Optional[str], Optional[dict]]:
        """Returns (events, frame_b64, checkpoint_meta).
        checkpoint_meta is non-None when a recording segment was finalized mid-session."""
        nparr = np.frombuffer(jpeg_bytes, np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if frame is None:
            return [], None, None

        # Mid-session checkpoint: finalize and rotate the recording file periodically
        checkpoint_meta: Optional[dict] = None
        if self._rec_start is not None and time.time() - self._rec_start >= CHECKPOINT_INTERVAL:
            checkpoint_meta = self._do_checkpoint()

        # Record this frame — isolated in try/except so any writer failure
        # never prevents detection from running.
        try:
            if self._recordings_dir is not None and self._rec_path is None:
                self._rec_id = str(uuid4())
                filename = f"recording_{int(time.time())}.mp4"
                self._rec_path = os.path.join(self._recordings_dir, filename)
                self._rec_start = time.time()
                self._rec_frames = 0
                self._rec_frame_offset = self._frame_count

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
        raw_events = detector.detect(frame, self._prev_gray, self._frame_count - self._rec_frame_offset, fps=2.0)
        self._prev_gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        self._frame_count += 1

        h, w = frame.shape[:2]
        events = self._apply_person_tracking(raw_events, frame, w, h)

        # First frame of a new camera session: guarantee an activity opens even
        # if YOLO sees nothing yet (prev_gray is None, motion detection is skipped).
        if is_first_frame and not events:
            events = [DetectionEvent(
                source='behavior',
                type='live_feed_started',
                confidence=1.0,
                metadata={'frame_id': 0},
            )]

        annotated = self._annotate_frame(frame)
        frame_b64 = _encode_frame(annotated) if events else None
        return events, frame_b64, checkpoint_meta

    def _apply_person_tracking(
        self, raw_events: list, frame: np.ndarray, frame_w: int, frame_h: int
    ) -> list:
        """Replace raw person_detected events with tracked ones.

        Emits person_detected once per new track, loitering_detected once
        after LOITERING_SECONDS for the same track. All non-person events
        pass through unchanged.
        """
        now = time.time()

        # Separate person detections from everything else
        person_events: List[DetectionEvent] = []
        other_events: List[DetectionEvent] = []
        for ev in raw_events:
            if ev.type == 'person_detected':
                person_events.append(ev)
            else:
                other_events.append(ev)

        # Build normalised centroids for this frame's person detections
        detections: List[Tuple[float, float, DetectionEvent]] = []
        for ev in person_events:
            bb = ev.metadata.get('bounding_box', {})
            cx = (bb.get('x', 0) + bb.get('w', 0) / 2) / frame_w
            cy = (bb.get('y', 0) + bb.get('h', 0) / 2) / frame_h
            detections.append((cx, cy, ev))

        # Load environment thresholds (in-memory cache, no disk hit)
        _cfg = _env.get_thresholds()
        loitering_secs = float(_cfg.get("loitering_seconds", LOITERING_SECONDS))
        reid_area_gate = float(_cfg.get("reid_area_gate", REID_AREA_GATE))
        reid_min_frames = int(_cfg.get("reid_min_frames", REID_MIN_FRAMES))

        # Expire old tracks
        expired = [
            tid for tid, t in self._person_tracks.items()
            if now - t.last_seen > TRACK_TIMEOUT_SECONDS
        ]
        for tid in expired:
            del self._person_tracks[tid]

        # Greedy nearest-neighbour matching: for each detection find closest active track
        matched_track_ids: set = set()
        matched_det_indices: set = set()
        # map track_id -> best detection index (for metadata)
        track_to_det: Dict[int, int] = {}

        if self._person_tracks and detections:
            track_list = list(self._person_tracks.items())
            for det_idx, (cx, cy, _ev) in enumerate(detections):
                best_tid, best_dist = None, float('inf')
                for tid, track in track_list:
                    if tid in matched_track_ids:
                        continue
                    dist = math.sqrt((cx - track.cx) ** 2 + (cy - track.cy) ** 2)
                    if dist < best_dist:
                        best_dist = dist
                        best_tid = tid
                if best_tid is not None and best_dist <= TRACK_MAX_DISTANCE:
                    matched_track_ids.add(best_tid)
                    matched_det_indices.add(det_idx)
                    track_to_det[best_tid] = det_idx
                    t = self._person_tracks[best_tid]
                    t.last_seen = now
                    t.cx = cx
                    t.cy = cy
                    t.confidence = _ev.confidence
                    t.bbox = _ev.metadata.get('bounding_box')
                    t.frames_seen += 1

        # Create tracks for unmatched detections (Re-ID is deferred until REID_MIN_FRAMES)
        new_track_to_det: Dict[int, int] = {}
        for det_idx, (cx, cy, _ev) in enumerate(detections):
            if det_idx not in matched_det_indices:
                tid = self._next_track_id
                self._next_track_id += 1
                self._person_tracks[tid] = _PersonTrack(
                    track_id=tid,
                    first_seen=now,
                    last_seen=now,
                    cx=cx,
                    cy=cy,
                    confidence=_ev.confidence,
                    bbox=_ev.metadata.get('bounding_box'),
                    frames_seen=1,
                )
                new_track_to_det[tid] = det_idx

        # Deferred Re-ID pass: run once a track has been seen for REID_MIN_FRAMES frames
        reid_events: List[DetectionEvent] = []
        if self._registry is not None and self._camera_id is not None:
            for tid, track in self._person_tracks.items():
                if track.reid_done or track.frames_seen < reid_min_frames:
                    continue
                try:
                    bb = track.bbox or {}
                    bb_area = bb.get('w', 0) * bb.get('h', 0)
                    frame_area = frame_w * frame_h
                    if bb_area < frame_area * reid_area_gate or track.confidence < 0.55:
                        continue  # crop still too small — try again next frame
                    emb = reid.extract_embedding(frame, bb)
                    if emb is not None:
                        global_pid, moved_from = self._registry.identify(emb, self._camera_id)
                        track.global_person_id = global_pid
                        track.reid_done = True
                        if moved_from is not None:
                            cam_path = self._registry.camera_path_for(global_pid)
                            reid_events.append(DetectionEvent(
                                source='behavior',
                                type='person_moved_camera',
                                confidence=1.0,
                                metadata={
                                    'global_person_id': global_pid,
                                    'from_camera': moved_from,
                                    'to_camera': self._camera_id,
                                    'camera_path': cam_path,
                                },
                            ))
                except Exception as exc:
                    print(f'[reid] error during embedding/identify: {exc}')

        # Emit events based on track state
        tracking_events: List[DetectionEvent] = []
        for tid, track in self._person_tracks.items():
            cam_path = (
                self._registry.camera_path_for(track.global_person_id)
                if self._registry and track.global_person_id
                else ([self._camera_id] if self._camera_id else [])
            )

            if not track.announced:
                track.announced = True
                det_idx = track_to_det.get(tid, new_track_to_det.get(tid))
                if det_idx is not None:
                    base_meta = {**detections[det_idx][2].metadata, 'track_id': tid}
                else:
                    base_meta = {'track_id': tid}
                if track.global_person_id is not None:
                    base_meta['global_person_id'] = track.global_person_id
                base_meta['camera_path'] = cam_path
                tracking_events.append(DetectionEvent(
                    source='cv',
                    type='person_detected',
                    confidence=track.confidence,
                    metadata=base_meta,
                ))

            elif (now - track.first_seen) >= loitering_secs and (
                track.last_loitering_at is None
                or (now - track.last_loitering_at) >= loitering_secs
            ):
                track.last_loitering_at = now
                meta: dict = {
                    'track_id': tid,
                    'duration_seconds': round(now - track.first_seen, 1),
                    'camera_path': cam_path,
                }
                if track.global_person_id:
                    meta['global_person_id'] = track.global_person_id
                tracking_events.append(DetectionEvent(
                    source='behavior',
                    type='loitering_detected',
                    confidence=track.confidence,
                    metadata=meta,
                ))

        return other_events + tracking_events + reid_events

    def _annotate_frame(self, frame: np.ndarray) -> np.ndarray:
        """Draw bounding boxes and person ID labels for all active tracks."""
        if not self._person_tracks:
            return frame
        annotated = frame.copy()
        for track in self._person_tracks.values():
            bb = track.bbox
            if bb is None:
                continue
            x, y, w, h = int(bb['x']), int(bb['y']), int(bb['w']), int(bb['h'])
            label = track.global_person_id[:8] if track.global_person_id else f'#{track.track_id}'
            color = (0, 255, 0)
            cv2.rectangle(annotated, (x, y), (x + w, y + h), color, 2)
            (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.45, 1)
            cv2.rectangle(annotated, (x, y - th - 6), (x + tw + 6, y), color, -1)
            cv2.putText(annotated, label, (x + 3, y - 3), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 1)
        return annotated

    def _do_checkpoint(self) -> Optional[dict]:
        """Close the current recording segment, save metadata, reset state for a new segment."""
        if self._writer is not None:
            self._writer.release()
            self._writer = None

        meta = None
        if self._rec_path is not None and self._rec_frames >= self.MIN_FRAMES_TO_SAVE:
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
            print(f"[recording] checkpoint saved: {os.path.basename(self._rec_path)} ({self._rec_frames} frames)")
        elif self._rec_path and os.path.exists(self._rec_path):
            os.unlink(self._rec_path)

        # Reset so the next frame opens a fresh recording segment
        self._rec_id = self._rec_path = self._rec_start = None
        self._rec_frames = 0
        return meta

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
        self._rec_frame_offset = 0
        self._person_tracks = {}
        self._next_track_id = 0
