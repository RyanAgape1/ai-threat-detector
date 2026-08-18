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
    # Detection events designed by event_designer_agent.py, plus the named
    # frame regions they reference. See custom_events.py for the rule schema.
    "custom_events": [],
    "zones": [],
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
                "custom_events": data.get("custom_events", []),
                "zones": data.get("zones", []),
            }
            _cached_config = merged
            return _cached_config
        except Exception as exc:
            print(f"[env_config] failed to load config: {exc}")
    _cached_config = dict(DEFAULT_CONFIG)
    _cached_config["thresholds"] = dict(DEFAULT_CONFIG["thresholds"])
    _cached_config["disabled_events"] = []
    _cached_config["time_rules"] = []
    _cached_config["custom_events"] = []
    _cached_config["zones"] = []
    return _cached_config


def save_config(config: dict) -> None:
    global _cached_config
    # Never let a partial write drop detection events that the config agent
    # doesn't know about — it only ever supplies thresholds/time rules.
    existing = _cached_config or {}
    config.setdefault("custom_events", existing.get("custom_events", []))
    config.setdefault("zones", existing.get("zones", []))
    with open(CONFIG_PATH, "w") as f:
        json.dump(config, f, indent=2)
    _cached_config = config
    print(f"[env_config] saved config for environment: {config.get('environment_type', '?')}")


# ---------------------------------------------------------------------------
# Custom detection events / zones
# ---------------------------------------------------------------------------

def get_custom_events() -> List[dict]:
    """All installed custom event definitions, enabled or not."""
    return load_config().get("custom_events", [])


def get_zones() -> List[dict]:
    return load_config().get("zones", [])


def save_detection_events(
    custom_event_defs: List[dict],
    zones: List[dict],
    disabled_events: Optional[List[str]] = None,
) -> dict:
    """Replace the custom event set (and optionally the suppressed built-ins).

    Thresholds and time rules are left untouched — those belong to the
    environment configuration agent.
    """
    config = dict(load_config())
    config["custom_events"] = custom_event_defs
    config["zones"] = zones
    if disabled_events is not None:
        config["disabled_events"] = disabled_events
    save_config(config)
    print(
        f"[env_config] saved {len(custom_event_defs)} custom event(s), "
        f"{len(zones)} zone(s)"
    )
    return config


def set_custom_event_enabled(event_type: str, enabled: bool) -> bool:
    """Toggle one custom event. Returns False if it doesn't exist."""
    config = dict(load_config())
    events = config.get("custom_events", [])
    for ev in events:
        if ev.get("event_type") == event_type:
            ev["enabled"] = enabled
            config["custom_events"] = events
            save_config(config)
            return True
    return False


def get_custom_event(event_type: str) -> Optional[dict]:
    for ev in get_custom_events():
        if ev.get("event_type") == event_type:
            return ev
    return None


def replace_custom_event(event_type: str, definition: dict) -> bool:
    """Swap one custom event for an already-validated definition.

    Used for operator tuning (e.g. lowering a dwell threshold) without having to
    re-run the designer agent, which might pick different values.
    """
    config = dict(load_config())
    events = config.get("custom_events", [])
    for i, ev in enumerate(events):
        if ev.get("event_type") == event_type:
            events[i] = definition
            config["custom_events"] = events
            save_config(config)
            return True
    return False


def delete_custom_event(event_type: str) -> bool:
    """Remove one custom event. Returns False if it doesn't exist."""
    config = dict(load_config())
    events = config.get("custom_events", [])
    remaining = [e for e in events if e.get("event_type") != event_type]
    if len(remaining) == len(events):
        return False
    config["custom_events"] = remaining
    save_config(config)
    return True


def update_zone(name: str, x: float, y: float, w: float, h: float) -> bool:
    """Recalibrate a zone's rectangle. Returns False if it doesn't exist."""
    config = dict(load_config())
    zones = config.get("zones", [])
    for z in zones:
        if z.get("name") == name:
            z["x"], z["y"], z["w"], z["h"] = x, y, w, h
            z["needs_calibration"] = False
            config["zones"] = zones
            save_config(config)
            return True
    return False


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
    """Plain-text description of the current deployment for use in AI prompts.

    Returns "" when there is nothing worth telling the model — callers can just
    check truthiness.
    """
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

    # Describe custom events so the reasoning model knows what a type like
    # "table_dwell" means rather than guessing from the name.
    custom = get_custom_events()
    if custom:
        import custom_events as _ce  # local import avoids an import cycle
        described = _ce.describe_events(custom)
        if described:
            lines.append(described)

    is_bare = (
        env_type == "generic" and not description and rule is None and not custom
    )
    return "" if is_bare else "\n".join(lines)
