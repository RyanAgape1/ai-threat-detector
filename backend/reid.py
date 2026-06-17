"""
Person Re-ID using OSNet x0.25 via torchreid.
OSNet is purpose-built for person Re-ID and produces discriminative embeddings
even across different camera angles and lighting conditions.
"""
import cv2
import numpy as np
from typing import Optional

_extractor = None
_available = True


def _load() -> bool:
    global _extractor, _available
    if _extractor is not None:
        return True
    try:
        from torchreid.reid.utils import FeatureExtractor
        import torch
        device = 'cuda' if torch.cuda.is_available() else 'cpu'
        _extractor = FeatureExtractor(
            model_name='osnet_x0_25',
            device=device,
        )
        print('[reid] OSNet x0.25 Re-ID model loaded.')
        return True
    except Exception as exc:
        print(f'[reid] could not load OSNet ({exc}); cross-camera Re-ID disabled.')
        _available = False
        return False


def extract_embedding(frame_bgr: np.ndarray, bbox: dict) -> Optional[np.ndarray]:
    """Crop person from frame and return an L2-normalised embedding, or None."""
    if not _available:
        return None
    if not _load():
        return None

    x = int(bbox.get('x', 0))
    y = int(bbox.get('y', 0))
    w = int(bbox.get('w', 0))
    h = int(bbox.get('h', 0))

    if w < 20 or h < 40:
        return None

    crop = frame_bgr[y: y + h, x: x + w]
    if crop.size == 0:
        return None

    crop_rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)

    features = _extractor([crop_rgb])          # shape: (1, 512)
    emb: np.ndarray = features[0].cpu().numpy()

    norm = float(np.linalg.norm(emb))
    if norm > 0:
        emb = emb / norm
    return emb
