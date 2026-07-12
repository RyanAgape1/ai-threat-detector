"""
Environment configuration — stores and manages detection thresholds and time-based rules.
Loaded once from disk, then cached in memory; updates take effect immediately.
"""
import json
from datetime import datetime
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
    "time_rules": [],
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
                "time_rules": data.get("time_rules", []),
            }
            _cached_config = merged
            return _cached_config
        except Exception as exc:
            print(f"[env_config] failed to load config: {exc}")
    _cached_config = dict(DEFAULT_CONFIG)
    _cached_config["thresholds"] = dict(DEFAULT_CONFIG["thresholds"])
    _cached_config["disabled_events"] = []
    _cached_config["time_rules"] = []
    return _cached_config


def save_config(config: dict) -> None:
    global _cached_config
    with open(CONFIG_PATH, "w") as f:
        json.dump(config, f, indent=2)
    _cached_config = config
    print(f"[env_config] saved config for environment: {config.get('environment_type', '?')}")


def get_active_time_rule() -> Optional[dict]:
    """Return the first time rule whose window and days cover the current local time, or None."""
    now = datetime.now()
    hour = now.hour
    weekday = now.weekday()  # 0=Mon, 6=Sun
    for rule in load_config().get("time_rules", []):
        start = int(rule.get("start_hour", 0))
        end = int(rule.get("end_hour", 0))
        # start == end is the all-day sentinel (covers entire day, no time restriction)
        if start != end:
            if start < end:
                hour_match = start <= hour < end
            else:
                hour_match = hour >= start or hour < end
            if not hour_match:
                continue
        # Check days — empty/absent means every day
        days = rule.get("days", [])
        if days and weekday not in days:
            continue
        return rule
    return None


def get_effective_thresholds() -> dict:
    """Base thresholds merged with any active time rule overrides."""
    base = dict(load_config()["thresholds"])
    rule = get_active_time_rule()
    if rule:
        base.update(rule.get("thresholds", {}))
    return base


def get_effective_disabled_events() -> List[str]:
    """Base disabled events union with any active time rule additions."""
    base = set(load_config().get("disabled_events", []))
    rule = get_active_time_rule()
    if rule:
        base.update(rule.get("disabled_events", []))
    return list(base)


def get_environment_context() -> str:
    """Return a short plain-text description of the current environment for use in AI prompts."""
    cfg = load_config()
    env_type = cfg.get("environment_type", "generic")
    description = cfg.get("description", "")
    lines = [f"Deployment environment: {env_type}"]
    if description:
        lines.append(description)
    _DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    rule = get_active_time_rule()
    if rule:
        start = rule.get("start_hour", "?")
        end = rule.get("end_hour", "?")
        days = rule.get("days", [])
        days_str = "/".join(_DAY_NAMES[d] for d in days) if days else "every day"
        lines.append(
            f"Active time rule: \"{rule.get('label', 'unnamed')}\" "
            f"({start:02d}:00-{end:02d}:00, {days_str}) — "
            f"{rule.get('description', '')}"
        )
    return "\n".join(lines)
