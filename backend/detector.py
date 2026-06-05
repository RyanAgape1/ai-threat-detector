"""
YOLO-based threat detection using YOLOv8n (auto-downloads ~6MB on first run).
Replaces the hand-crafted OpenCV heuristics with real object detection.
"""
import cv2
import numpy as np
from typing import List, Optional

from models import DetectionEvent

_model = None

# COCO class IDs relevant to security
_PERSON  = 0
_WEAPONS = {43: 'knife', 76: 'scissors'}
_BAGS    = {24: 'backpack', 26: 'handbag', 28: 'suitcase'}


def load_model():
    """Lazy-load YOLOv8n. Safe to call multiple times."""
    global _model
    if _model is not None:
        return _model
    import logging
    logging.getLogger('ultralytics').setLevel(logging.WARNING)
    from ultralytics import YOLO
    _model = YOLO('yolov8n.pt')
    print('[detector] YOLOv8n model loaded.')
    return _model


def detect(
    frame: np.ndarray,
    prev_gray: Optional[np.ndarray],
    frame_num: int,
    fps: float = 2.0,
) -> List[DetectionEvent]:
    """
    Run YOLO object detection + optical-flow motion analysis on a BGR frame.
    fps: actual video FPS (for computing video_time_seconds used by UI seek).
    """
    events: List[DetectionEvent] = []
    video_time = round(frame_num / fps, 2)

    # ── YOLO object detection ───────────────────────────────────────────────
    try:
        model = load_model()
        results = model(frame, verbose=False, conf=0.30)[0]

        person_count = 0
        for box in results.boxes:
            cls  = int(box.cls[0])
            conf = float(box.conf[0])
            x1, y1, x2, y2 = [int(v) for v in box.xyxy[0].tolist()]
            bbox = {'x': x1, 'y': y1, 'w': x2 - x1, 'h': y2 - y1}
            base = {'frame_id': frame_num, 'video_time_seconds': video_time, 'bounding_box': bbox}

            if cls in _WEAPONS:
                events.append(DetectionEvent(
                    source='cv', type='weapon_detected', confidence=conf,
                    metadata={**base, 'object_class': _WEAPONS[cls]},
                ))

            elif cls == _PERSON and conf >= 0.45:
                person_count += 1
                events.append(DetectionEvent(
                    source='cv', type='person_detected', confidence=conf,
                    metadata=base,
                ))

            elif cls in _BAGS and conf >= 0.50:
                events.append(DetectionEvent(
                    source='cv', type='unattended_object', confidence=conf * 0.8,
                    metadata={**base, 'object_class': _BAGS[cls]},
                ))

        if person_count >= 2:
            events.append(DetectionEvent(
                source='behavior', type='crowd_or_confrontation',
                confidence=min(0.88, 0.50 + person_count * 0.08),
                metadata={
                    'frame_id': frame_num,
                    'video_time_seconds': video_time,
                    'person_count': person_count,
                },
            ))

    except Exception as exc:
        print(f'[detector] YOLO error on frame {frame_num}: {exc}')

    # ── Optical-flow motion analysis ────────────────────────────────────────
    if prev_gray is not None:
        gray  = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        diff  = cv2.absdiff(prev_gray, gray)
        _, th = cv2.threshold(diff, 25, 255, cv2.THRESH_BINARY)
        motion = float(np.count_nonzero(th)) / th.size

        if motion > 0.25:
            events.append(DetectionEvent(
                source='behavior', type='violent_motion',
                confidence=min(0.90, 0.55 + motion * 1.5),
                metadata={
                    'frame_id': frame_num,
                    'video_time_seconds': video_time,
                    'motion_ratio': round(motion, 3),
                },
            ))
        elif motion > 0.10:
            events.append(DetectionEvent(
                source='behavior', type='sudden_movement',
                confidence=min(0.80, 0.40 + motion * 2),
                metadata={
                    'frame_id': frame_num,
                    'video_time_seconds': video_time,
                    'motion_ratio': round(motion, 3),
                },
            ))

    return events
