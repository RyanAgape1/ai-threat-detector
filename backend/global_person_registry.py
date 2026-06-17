"""
Thread-safe registry that assigns a stable global_person_id across cameras.

When a new local track appears on any camera, its Re-ID embedding is compared
against all known identities.  If cosine similarity exceeds MATCH_THRESHOLD the
person is recognised; otherwise a new identity is created.  Identities that
haven't been seen on any camera for IDENTITY_TIMEOUT seconds are expired.
"""
import threading
import time
from typing import Dict, List, Optional, Tuple
from uuid import uuid4

import numpy as np

MATCH_THRESHOLD = 0.65       # cosine similarity required to call it the same person
IDENTITY_TIMEOUT = 300.0     # seconds of silence before an identity is forgotten
EMA_ALPHA = 0.2              # weight of each new embedding update (exponential moving avg)


class GlobalPersonRegistry:
    def __init__(self):
        self._lock = threading.Lock()
        # global_person_id -> {embedding, first_seen, last_seen, last_camera, camera_path}
        self._identities: Dict[str, dict] = {}

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def identify(self, embedding: np.ndarray, camera_id: str) -> Tuple[str, Optional[str]]:
        """Match embedding to a known identity (or create one).

        Returns (global_person_id, moved_from_camera).
        moved_from_camera is the previous camera_id if the person just switched
        cameras, otherwise None.
        """
        with self._lock:
            self._expire_old()

            best_id: Optional[str] = None
            best_sim = -1.0
            for gid, data in self._identities.items():
                sim = float(np.dot(embedding, data['embedding']))
                if sim > best_sim:
                    best_sim = sim
                    best_id = gid

            if best_id is not None and best_sim >= MATCH_THRESHOLD:
                data = self._identities[best_id]
                data['last_seen'] = time.time()

                # Detect camera move
                prev_camera = data['last_camera']
                moved_from: Optional[str] = None
                if prev_camera != camera_id:
                    moved_from = prev_camera
                    data['last_camera'] = camera_id
                    data['camera_path'].append(camera_id)

                # EMA update so stored embedding drifts toward recent appearance
                updated = (1 - EMA_ALPHA) * data['embedding'] + EMA_ALPHA * embedding
                norm = float(np.linalg.norm(updated))
                data['embedding'] = updated / norm if norm > 0 else updated

                return best_id, moved_from

            # Unknown person — register a new identity
            new_id = str(uuid4())
            self._identities[new_id] = {
                'embedding': embedding.copy(),
                'first_seen': time.time(),
                'last_seen': time.time(),
                'last_camera': camera_id,
                'camera_path': [camera_id],
            }
            return new_id, None

    def camera_path_for(self, global_person_id: str) -> List[str]:
        """Ordered list of cameras the person has visited (with repeats on re-entry)."""
        with self._lock:
            data = self._identities.get(global_person_id)
            return list(data['camera_path']) if data else []

    def is_cross_camera(self, global_person_id: str) -> bool:
        """True if this person has been seen on more than one camera."""
        path = self.camera_path_for(global_person_id)
        return len(set(path)) > 1

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _expire_old(self) -> None:
        now = time.time()
        expired = [
            gid for gid, data in self._identities.items()
            if now - data['last_seen'] > IDENTITY_TIMEOUT
        ]
        for gid in expired:
            del self._identities[gid]
