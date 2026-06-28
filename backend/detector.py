"""
YOLO-based threat detection using YOLOv8n (auto-downloads ~6MB on first run).
Replaces the hand-crafted OpenCV heuristics with real object detection.
"""
import cv2
import numpy as np
import torch
from typing import List, Optional

import environment_config as _env
from models import DetectionEvent

_model = None
_device = 'cuda' if torch.cuda.is_available() else 'cpu'

# COCO class IDs relevant to security
_PERSON  = 0
_WEAPONS  = {43: 'knife', 76: 'scissors'}
_BAGS     = {24: 'backpack', 26: 'handbag', 28: 'suitcase'}
_VEHICLES = {2: 'car', 3: 'motorcycle', 5: 'bus', 7: 'truck'}


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

    # Load environment config once per frame (in-memory cache, no disk hit)
    cfg = _env.get_thresholds()
    disabled = set(_env.get_disabled_events())

    person_conf_gate = cfg.get("person_confidence", 0.45)
    bag_conf_gate = cfg.get("bag_confidence", 0.50)
    vehicle_conf_gate = cfg.get("vehicle_confidence", 0.40)
    crowd_min = int(cfg.get("crowd_min_persons", 2))

    # ── YOLO object detection ───────────────────────────────────────────────
    try:
        model = load_model()
        results = model(frame, verbose=False, conf=0.30, device=_device)[0]

        # First pass: collect persons and bags separately
        person_boxes: List[tuple] = []  # (cx, cy, x1, y1, x2, y2, conf)
        bag_boxes: List[tuple] = []     # (cx, cy, x1, y1, x2, y2, conf, class_name)

        for box in results.boxes:
            cls  = int(box.cls[0])
            conf = float(box.conf[0])
            x1, y1, x2, y2 = [int(v) for v in box.xyxy[0].tolist()]
            cx, cy = (x1 + x2) / 2, (y1 + y2) / 2

            if cls in _VEHICLES and conf >= vehicle_conf_gate:
                if 'vehicle_detected' not in disabled:
                    bbox = {'x': x1, 'y': y1, 'w': x2 - x1, 'h': y2 - y1}
                    base = {'frame_id': frame_num, 'video_time_seconds': video_time, 'bounding_box': bbox}
                    events.append(DetectionEvent(
                        source='cv', type='vehicle_detected', confidence=conf,
                        metadata={**base, 'object_class': _VEHICLES[cls]},
                    ))
            elif cls in _WEAPONS:
                if 'weapon_detected' not in disabled:
                    bbox = {'x': x1, 'y': y1, 'w': x2 - x1, 'h': y2 - y1}
                    base = {'frame_id': frame_num, 'video_time_seconds': video_time, 'bounding_box': bbox}
                    events.append(DetectionEvent(
                        source='cv', type='weapon_detected', confidence=conf,
                        metadata={**base, 'object_class': _WEAPONS[cls]},
                    ))
            elif cls == _PERSON and conf >= person_conf_gate:
                person_boxes.append((cx, cy, x1, y1, x2, y2, conf))
            elif cls in _BAGS and conf >= bag_conf_gate:
                bag_boxes.append((cx, cy, x1, y1, x2, y2, conf, _BAGS[cls]))

        # Emit person events
        if 'person_detected' not in disabled:
            for cx, cy, x1, y1, x2, y2, conf in person_boxes:
                bbox = {'x': x1, 'y': y1, 'w': x2 - x1, 'h': y2 - y1}
                events.append(DetectionEvent(
                    source='cv', type='person_detected', confidence=conf,
                    metadata={'frame_id': frame_num, 'video_time_seconds': video_time, 'bounding_box': bbox},
                ))

        # Emit unattended_object only when no person is within 1.5× the bag's diagonal
        if 'unattended_object' not in disabled:
            for bcx, bcy, x1, y1, x2, y2, conf, class_name in bag_boxes:
                bag_diag = ((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5
                proximity = bag_diag * 1.5
                person_nearby = any(
                    ((bcx - pcx) ** 2 + (bcy - pcy) ** 2) ** 0.5 < proximity
                    for pcx, pcy, *_ in person_boxes
                )
                if not person_nearby:
                    bbox = {'x': x1, 'y': y1, 'w': x2 - x1, 'h': y2 - y1}
                    base = {'frame_id': frame_num, 'video_time_seconds': video_time, 'bounding_box': bbox}
                    events.append(DetectionEvent(
                        source='cv', type='unattended_object', confidence=conf * 0.8,
                        metadata={**base, 'object_class': class_name},
                    ))

        if 'crowd_or_confrontation' not in disabled and len(person_boxes) >= crowd_min:
            events.append(DetectionEvent(
                source='behavior', type='crowd_or_confrontation',
                confidence=min(0.88, 0.50 + len(person_boxes) * 0.08),
                metadata={
                    'frame_id': frame_num,
                    'video_time_seconds': video_time,
                    'person_count': len(person_boxes),
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

        rapid_thresh = cfg.get("rapid_motion_threshold", 0.25)
        move_thresh = cfg.get("movement_threshold", 0.10)

        if motion > rapid_thresh and 'rapid_motion' not in disabled:
            events.append(DetectionEvent(
                source='behavior', type='rapid_motion',
                confidence=min(0.90, 0.55 + motion * 1.5),
                metadata={
                    'frame_id': frame_num,
                    'video_time_seconds': video_time,
                    'motion_ratio': round(motion, 3),
                },
            ))
        elif motion > move_thresh and 'movement' not in disabled:
            events.append(DetectionEvent(
                source='behavior', type='movement',
                confidence=min(0.80, 0.40 + motion * 2),
                metadata={
                    'frame_id': frame_num,
                    'video_time_seconds': video_time,
                    'motion_ratio': round(motion, 3),
                },
            ))

    return events
