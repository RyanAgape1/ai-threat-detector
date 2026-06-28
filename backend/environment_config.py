"""
Environment configuration — stores and manages detection thresholds and custom rules.
Loaded once from disk, then cached in memory; updates take effect immediately.
"""
import json
from pathlib import Path
from typing import List, Optional

CONFIG_PATH = Path(__file__).parent / "environment_config.json"

DEFAULT_CONFIG: dict = {
    "environment_type": "generic",
    "description": "",
    "thresholds": {
        "person_confidence": 0.45,
        "bag_confidence": 0.50,
        "vehicle_confidence": 0.40,
        "crowd_min_persons": 2,
        "rapid_motion_threshold": 0.25,
        "movement_threshold": 0.10,
        "loitering_seconds": 30.0,
        "reid_area_gate": 0.04,
        "reid_min_frames": 3,
    },
    "disabled_events": [],
}

_cached_config: Optional[dict] = None


def load_config() -> dict:
    global _cached_config
    if _cached_config is not None:
        return _cached_config
    if CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH) as f:
                data = json.load(f)
            merged: dict = {
                "environment_type": data.get("environment_type", "generic"),
                "description": data.get("description", ""),
                "thresholds": {**DEFAULT_CONFIG["thresholds"], **data.get("thresholds", {})},
                "disabled_events": data.get("disabled_events", []),
            }
            _cached_config = merged
            return _cached_config
        except Exception as exc:
            print(f"[env_config] failed to load config: {exc}")
    _cached_config = dict(DEFAULT_CONFIG)
    _cached_config["thresholds"] = dict(DEFAULT_CONFIG["thresholds"])
    _cached_config["disabled_events"] = []
    return _cached_config


def save_config(config: dict) -> None:
    global _cached_config
    with open(CONFIG_PATH, "w") as f:
        json.dump(config, f, indent=2)
    _cached_config = config
    print(f"[env_config] saved config for environment: {config.get('environment_type', '?')}")


def get_thresholds() -> dict:
    return load_config()["thresholds"]


def get_disabled_events() -> List[str]:
    return load_config().get("disabled_events", [])
