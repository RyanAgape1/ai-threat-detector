"""
Custom detection events — user-defined detection logic designed by the AI agents
in context_analyst_agent.py / event_designer_agent.py.

Design rule: the agents NEVER emit code. They emit declarative rule specs built
from the fixed catalogue of primitives in RULE_KINDS. This module owns:

  * the catalogue (single source of truth for params, defaults and validation)
  * validation/normalisation of agent-authored specs
  * CustomEventEngine — the deterministic per-frame evaluator that turns those
    specs into DetectionEvents

Because the primitives are fixed, a bad agent output produces a validation error
rather than arbitrary behaviour, and every emitted event is reproducible.
"""
import re
from collections import deque
from typing import Any, Dict, List, Optional, Tuple

from models import DetectionEvent

# ---------------------------------------------------------------------------
# COCO classes — what YOLOv8n can actually see.
# detector.py only surfaces person/weapon/bag/vehicle; custom rules can reach
# any of these 80 classes via the object_present / proximity primitives.
# ---------------------------------------------------------------------------

COCO_CLASSES: List[str] = [
    'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
    'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat',
    'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack',
    'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball',
    'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket',
    'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
    'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair',
    'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse',
    'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink',
    'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier',
    'toothbrush',
]

BUILTIN_EVENT_TYPES: List[str] = [
    'person_detected', 'weapon_detected', 'unattended_object', 'vehicle_detected',
    'crowd_or_confrontation', 'loitering_detected', 'rapid_motion', 'movement',
    'person_moved_camera', 'elevated_noise', 'shouting_detected',
]

# ---------------------------------------------------------------------------
# Primitive catalogue
# ---------------------------------------------------------------------------
# Each param: (type, default, minimum, maximum, description). `type` is one of
# number | integer | boolean | string | string_list. Defaults are applied during
# normalisation so an agent may omit any param.

RULE_KINDS: Dict[str, dict] = {
    'dwell': {
        'summary': (
            'Times how long an individual person is present, and emits progress events '
            'plus a final total-duration event when they leave. This is the primitive for '
            '"how long did someone stay at a table / in the queue / at the counter". '
            'In presence mode (the default) the timer keeps running through normal human '
            'movement — turning, gesturing, sitting down, standing up, walking around a '
            'table — and survives brief occlusion, resuming the same timer when the '
            'person is recognised again.'
        ),
        'needs_tracks': True,
        'params': {
            'target': ('string', 'person', None, None, 'Object class to time (almost always "person")'),
            'mode': ('string', 'presence', None, None,
                     '"presence" = time how long the person is there at all, ignoring how much they move (use this for table/queue/waiting-time questions); '
                     '"stationary" = only count time while they stay in roughly one spot (use only when standing still in one place is itself the point); '
                     '"zone" = like presence but only counts time inside the named zone'),
            'min_seconds': ('number', 300.0, 5.0, 43200.0, 'Emit once the person has stayed this long'),
            'repeat_seconds': ('number', 0.0, 0.0, 43200.0, 'Re-emit every N seconds after the first event. 0 = emit once only'),
            'absence_grace_seconds': ('number', 20.0, 0.0, 600.0, 'How long the person may be out of sight (occlusion, walking behind something, briefly leaving frame) before the timer is considered finished. The same timer resumes if they reappear within this window'),
            'max_drift': ('number', 0.6, 0.1, 10.0, 'stationary mode only: how far the person may move and still count as being in the same spot, measured in multiples of their own body height so the rule behaves the same near and far from the camera. 0.6 tolerates turning and gesturing but catches someone walking off'),
            'drift_grace_seconds': ('number', 10.0, 0.0, 300.0, 'stationary mode only: how long they must be away from their spot before the clock resets. Prevents arm movement or a shift of weight from restarting the timer'),
            'emit_on_exit': ('boolean', True, None, None, 'Also emit a "<event_type>_ended" event carrying the total duration when the person leaves'),
        },
    },
    'zone_count': {
        'summary': (
            'Fires when at least N objects of a class are present (optionally sustained '
            'for a period). Use for queue length, table occupancy, overcrowding.'
        ),
        'needs_tracks': False,
        'params': {
            'target': ('string', 'person', None, None, 'Object class to count'),
            'min_count': ('integer', 3, 1, 50, 'Fire when this many are present at once'),
            'sustained_seconds': ('number', 15.0, 0.0, 3600.0, 'Count must hold for this long before firing. 0 = fire immediately'),
            'repeat_seconds': ('number', 120.0, 0.0, 43200.0, 'Re-emit every N seconds while the condition holds. 0 = emit once per episode'),
        },
    },
    'zone_vacant': {
        'summary': (
            'Fires when a zone contains none of the target class for a period. Use for '
            '"nobody at the front desk", "station left unmanned", "no staff on the floor".'
        ),
        'needs_tracks': False,
        'params': {
            'target': ('string', 'person', None, None, 'Object class whose absence is notable'),
            'min_seconds': ('number', 300.0, 5.0, 43200.0, 'How long the zone must stay empty before firing'),
            'repeat_seconds': ('number', 0.0, 0.0, 43200.0, 'Re-emit every N seconds while still empty. 0 = emit once per episode'),
        },
    },
    'object_present': {
        'summary': (
            'Fires when any of the listed COCO object classes is seen. This is how you '
            'add detection for objects the built-in detector ignores (dog, cup, laptop, '
            'bottle, cell phone, bicycle, dining table, ...).'
        ),
        'needs_tracks': False,
        'params': {
            'object_classes': ('string_list', [], None, None, 'COCO class names to watch for'),
            'min_confidence': ('number', 0.45, 0.1, 0.95, 'Minimum YOLO confidence'),
            'cooldown_seconds': ('number', 60.0, 0.0, 43200.0, 'Suppress repeats of the same class for this long'),
        },
    },
    'proximity': {
        'summary': (
            'Fires when a target class comes close to another class for a sustained '
            'period. Use for "person lingering next to a vehicle", "person at the till", '
            '"someone by the cash register".'
        ),
        'needs_tracks': False,
        'params': {
            'target': ('string', 'person', None, None, 'First object class'),
            'near': ('string', 'car', None, None, 'Second object class the target must be close to'),
            'max_distance_ratio': ('number', 0.15, 0.01, 1.0, 'Max centre-to-centre distance as a fraction of the frame diagonal'),
            'min_seconds': ('number', 5.0, 0.0, 3600.0, 'How long they must stay close'),
            'cooldown_seconds': ('number', 60.0, 0.0, 43200.0, 'Suppress repeats for this long'),
        },
    },
    'event_rate': {
        'summary': (
            'Fires when built-in events happen too often in a window — a meta-rule over '
            'the existing detectors. Use for "repeated rapid motion", "door opening over '
            'and over", "many separate people in a short window".'
        ),
        'needs_tracks': False,
        'params': {
            'event_types': ('string_list', [], None, None, f'Built-in event types to count. Options: {", ".join(BUILTIN_EVENT_TYPES)}'),
            'min_count': ('integer', 3, 2, 100, 'Fire when this many occur inside the window'),
            'window_seconds': ('number', 60.0, 5.0, 3600.0, 'Sliding window length'),
            'cooldown_seconds': ('number', 120.0, 0.0, 43200.0, 'Suppress repeats for this long'),
        },
    },
}

IMPORTANCE_LEVELS = ('routine', 'notable', 'important')

# How close a reappearing person must be to a recently-quiet timer for it to be
# treated as the same person resuming. Fraction of the frame diagonal.
_RESUME_RADIUS = 0.25

_EVENT_TYPE_RE = re.compile(r'^[a-z][a-z0-9_]{2,49}$')


# ---------------------------------------------------------------------------
# Prompt helpers — keeps the agents and the runtime describing the same thing
# ---------------------------------------------------------------------------

def catalogue_text(brief: bool = False, kinds: Optional[List[str]] = None) -> str:
    """Human/LLM-readable description of the primitives.

    brief=True omits per-parameter detail — enough for the analyst to pick a
    primitive, without the bulk the designer needs.
    kinds=[...] restricts output to those primitives.

    Both switches exist to control prompt size: the local model runs in a 4096
    token context, so a full catalogue plus tool schema leaves no room to
    generate a reply.
    """
    lines: List[str] = []
    selected = [k for k in (kinds or RULE_KINDS) if k in RULE_KINDS] or list(RULE_KINDS)
    for kind in selected:
        spec = RULE_KINDS[kind]
        summary = spec['summary']
        if brief:
            # First sentence only.
            summary = summary.split('. ')[0].rstrip('.') + '.'
        lines.append(f'- {kind}: {summary}')
        if spec['needs_tracks'] and not brief:
            lines.append('    (requires person tracking — live camera sessions only, not uploaded video)')
        if brief:
            continue
        for pname, (ptype, default, lo, hi, desc) in spec['params'].items():
            bounds = ''
            if lo is not None or hi is not None:
                bounds = f' [{lo}–{hi}]'
            lines.append(f'    · {pname} ({ptype}, default {default!r}){bounds}: {desc}')
    return '\n'.join(lines)


def build_apply_tool_schema(kinds: Optional[List[str]] = None) -> dict:
    """JSON schema for the event designer's apply_detection_events tool.

    Descriptions are kept terse and `kinds` narrows the enum, because this
    schema is sent on every request and competes with the reply for context.
    """
    kind_enum = [k for k in (kinds or RULE_KINDS) if k in RULE_KINDS] or list(RULE_KINDS)
    return {
        'type': 'object',
        'properties': {
            'custom_events': {
                'type': 'array',
                'description': 'Complete set of events to install (replaces the existing set).',
                'items': {
                    'type': 'object',
                    'properties': {
                        'event_type': {'type': 'string', 'description': 'snake_case id, e.g. table_dwell'},
                        'label': {'type': 'string', 'description': 'Short UI label'},
                        'description': {'type': 'string', 'description': 'One sentence'},
                        'kind': {'type': 'string', 'enum': kind_enum},
                        'importance': {'type': 'string', 'enum': list(IMPORTANCE_LEVELS)},
                        'zone': {'type': 'string', 'description': 'Zone name, or omit for whole frame'},
                        'params': {
                            'type': 'object',
                            'description': 'Params for the kind; omitted ones use defaults',
                            'additionalProperties': True,
                        },
                    },
                    'required': ['event_type', 'label', 'description', 'kind', 'params'],
                },
            },
            'zones': {
                'type': 'array',
                'description': 'Named regions used by rules. x/y/w/h are fractions of the frame (0-1).',
                'items': {
                    'type': 'object',
                    'properties': {
                        'name': {'type': 'string'},
                        'description': {'type': 'string'},
                        'x': {'type': 'number'},
                        'y': {'type': 'number'},
                        'w': {'type': 'number'},
                        'h': {'type': 'number'},
                        'needs_calibration': {'type': 'boolean'},
                    },
                    'required': ['name', 'x', 'y', 'w', 'h'],
                },
            },
            'disable_events': {
                'type': 'array',
                'items': {'type': 'string', 'enum': BUILTIN_EVENT_TYPES},
                'description': 'Built-in events to suppress as noise here',
            },
            'enable_events': {
                'type': 'array',
                'items': {'type': 'string', 'enum': BUILTIN_EVENT_TYPES},
                'description': 'Built-in events to un-suppress',
            },
            'explanation': {
                'type': 'string',
                'description': '2-4 sentences for the operator: what you added and what needs calibrating',
            },
        },
        'required': ['custom_events', 'explanation'],
    }


# ---------------------------------------------------------------------------
# Validation / normalisation
# ---------------------------------------------------------------------------

def _coerce(ptype: str, value: Any, default: Any, lo, hi) -> Any:
    try:
        if ptype == 'number':
            v = float(value)
        elif ptype == 'integer':
            v = int(round(float(value)))
        elif ptype == 'boolean':
            v = value if isinstance(value, bool) else str(value).strip().lower() in ('true', '1', 'yes')
        elif ptype == 'string_list':
            if isinstance(value, str):
                v = [s.strip() for s in value.split(',') if s.strip()]
            else:
                v = [str(s).strip() for s in value if str(s).strip()]
            return v
        else:
            v = str(value).strip()
            return v
    except (TypeError, ValueError):
        return default
    if ptype in ('number', 'integer'):
        if lo is not None:
            v = max(lo, v)
        if hi is not None:
            v = min(hi, v)
    return v


def normalize_definition(raw: dict) -> Tuple[Optional[dict], Optional[str]]:
    """Validate one agent-authored custom event. Returns (definition, error)."""
    if not isinstance(raw, dict):
        return None, 'definition is not an object'

    event_type = str(raw.get('event_type', '')).strip().lower().replace(' ', '_').replace('-', '_')
    if not _EVENT_TYPE_RE.match(event_type):
        return None, f'invalid event_type {raw.get("event_type")!r} (need snake_case, 3-50 chars, starting with a letter)'
    if event_type in BUILTIN_EVENT_TYPES:
        return None, f'event_type {event_type!r} collides with a built-in event'

    kind = str(raw.get('kind', '')).strip().lower()
    spec = RULE_KINDS.get(kind)
    if spec is None:
        return None, f'unknown kind {raw.get("kind")!r} (options: {", ".join(RULE_KINDS)})'

    raw_params = raw.get('params') or {}
    if not isinstance(raw_params, dict):
        raw_params = {}

    params: Dict[str, Any] = {}
    for pname, (ptype, default, lo, hi, _desc) in spec['params'].items():
        if pname in raw_params and raw_params[pname] is not None:
            params[pname] = _coerce(ptype, raw_params[pname], default, lo, hi)
        else:
            params[pname] = list(default) if isinstance(default, list) else default

    # Per-kind semantic checks
    if kind == 'dwell':
        if params['mode'] not in ('presence', 'stationary', 'zone'):
            params['mode'] = 'presence'
        if params['mode'] == 'zone' and not raw.get('zone'):
            return None, f'{event_type}: dwell in "zone" mode requires a zone'
    if kind == 'object_present':
        unknown = [c for c in params['object_classes'] if c not in COCO_CLASSES]
        params['object_classes'] = [c for c in params['object_classes'] if c in COCO_CLASSES]
        if not params['object_classes']:
            return None, f'{event_type}: object_present needs at least one valid COCO class (rejected: {unknown})'
    if kind == 'event_rate':
        params['event_types'] = [t for t in params['event_types'] if t in BUILTIN_EVENT_TYPES]
        if not params['event_types']:
            return None, f'{event_type}: event_rate needs at least one valid built-in event type'
    if kind in ('zone_count', 'zone_vacant', 'proximity', 'dwell'):
        target = params.get('target')
        if target and target not in COCO_CLASSES:
            return None, f'{event_type}: target {target!r} is not a COCO class'
    if kind == 'proximity' and params.get('near') not in COCO_CLASSES:
        return None, f'{event_type}: near {params.get("near")!r} is not a COCO class'
    if kind == 'zone_vacant' and not raw.get('zone'):
        return None, f'{event_type}: zone_vacant requires a zone (an empty whole frame is not meaningful)'

    importance = str(raw.get('importance', 'notable')).strip().lower()
    if importance not in IMPORTANCE_LEVELS:
        importance = 'notable'

    zone = raw.get('zone')
    zone = str(zone).strip().lower().replace(' ', '_') if zone else None

    return {
        'event_type': event_type,
        'label': str(raw.get('label') or event_type.replace('_', ' ').title())[:80],
        'description': str(raw.get('description') or '')[:400],
        'kind': kind,
        'params': params,
        'zone': zone,
        'importance': importance,
        'enabled': bool(raw.get('enabled', True)),
        'created_by': str(raw.get('created_by') or 'event_designer_agent'),
    }, None


def normalize_zone(raw: dict) -> Tuple[Optional[dict], Optional[str]]:
    if not isinstance(raw, dict):
        return None, 'zone is not an object'
    name = str(raw.get('name', '')).strip().lower().replace(' ', '_').replace('-', '_')
    if not _EVENT_TYPE_RE.match(name):
        return None, f'invalid zone name {raw.get("name")!r}'

    def _frac(key: str, default: float) -> float:
        try:
            v = float(raw.get(key, default))
        except (TypeError, ValueError):
            return default
        return max(0.0, min(1.0, v))

    # Leave room for a minimum-size rect so garbage input can't produce a zone
    # pinned to the frame edge with zero area.
    x, y = min(_frac('x', 0.0), 0.99), min(_frac('y', 0.0), 0.99)
    w = max(0.01, min(_frac('w', 1.0), 1.0 - x))
    h = max(0.01, min(_frac('h', 1.0), 1.0 - y))
    return {
        'name': name,
        'description': str(raw.get('description') or '')[:200],
        'x': round(x, 4), 'y': round(y, 4), 'w': round(w, 4), 'h': round(h, 4),
        'needs_calibration': bool(raw.get('needs_calibration', True)),
    }, None


def validate_batch(
    raw_events: List[dict], raw_zones: List[dict]
) -> Tuple[List[dict], List[dict], List[str]]:
    """Validate a whole agent proposal. Returns (events, zones, errors)."""
    errors: List[str] = []

    zones: List[dict] = []
    zone_names = set()
    for rz in raw_zones or []:
        zone, err = normalize_zone(rz)
        if err:
            errors.append(err)
            continue
        if zone['name'] in zone_names:
            continue
        zone_names.add(zone['name'])
        zones.append(zone)

    events: List[dict] = []
    seen = set()
    for re_ in raw_events or []:
        ev, err = normalize_definition(re_)
        if err:
            errors.append(err)
            continue
        if ev['event_type'] in seen:
            errors.append(f'duplicate event_type {ev["event_type"]!r} — kept the first')
            continue
        if ev['zone'] and ev['zone'] not in zone_names:
            errors.append(f'{ev["event_type"]}: references unknown zone {ev["zone"]!r} — rule dropped')
            continue
        seen.add(ev['event_type'])
        events.append(ev)

    return events, zones, errors


def describe_events(events: List[dict]) -> str:
    """Plain-text description of installed custom events, for AI reasoning prompts."""
    if not events:
        return ''
    lines = []
    for ev in events:
        if not ev.get('enabled', True):
            continue
        p = ev.get('params', {})
        detail = ', '.join(f'{k}={v}' for k, v in p.items() if v not in (None, [], ''))
        zone = f' in zone "{ev["zone"]}"' if ev.get('zone') else ''
        lines.append(
            f'- {ev["event_type"]} ("{ev.get("label", "")}"){zone}: {ev.get("description", "")} '
            f'[{ev.get("kind")}; {detail}]'
        )
        # dwell rules also emit a companion "_ended" event; without this note the
        # model sees an unexplained event type in the timeline.
        if ev.get('kind') == 'dwell' and p.get('emit_on_exit'):
            lines.append(
                f'- {ev["event_type"]}_ended: fires when that person leaves, and its '
                f'duration_seconds is the final total time they stayed.'
            )
    if not lines:
        return ''
    return (
        'Custom detection events configured for this deployment (these are '
        'deterministic measurements, not guesses — trust their numbers):\n'
        + '\n'.join(lines)
    )


# ---------------------------------------------------------------------------
# Runtime engine
# ---------------------------------------------------------------------------

def _rules_signature(rules: List[dict], zones: List[dict]) -> str:
    return repr([
        (r.get('event_type'), r.get('kind'), r.get('zone'), sorted((r.get('params') or {}).items()))
        for r in rules
    ]) + repr([(z.get('name'), z.get('x'), z.get('y'), z.get('w'), z.get('h')) for z in zones])


def _in_zone(cx: float, cy: float, zone: Optional[dict]) -> bool:
    if zone is None:
        return True
    return (
        zone['x'] <= cx <= zone['x'] + zone['w']
        and zone['y'] <= cy <= zone['y'] + zone['h']
    )


def _fmt_duration(seconds: float) -> str:
    seconds = int(seconds)
    if seconds < 60:
        return f'{seconds}s'
    mins, secs = divmod(seconds, 60)
    if mins < 60:
        return f'{mins}m {secs}s' if secs else f'{mins}m'
    hrs, rem = divmod(mins, 60)
    return f'{hrs}h {rem}m' if rem else f'{hrs}h'


class CustomEventEngine:
    """Evaluates custom event rules against each processed frame.

    One instance per camera session (or per uploaded-video job). All timing goes
    through the `now` argument so uploaded video can be evaluated in *video time*
    rather than wall-clock — otherwise a video analysed at 2x real time would
    report wrong durations.
    """

    def __init__(self, camera_id: Optional[str] = None):
        self.camera_id = camera_id
        self._sig: Optional[str] = None
        self._dwell: Dict[Tuple[str, str], dict] = {}
        self._sustain: Dict[str, dict] = {}
        self._vacant: Dict[str, dict] = {}
        self._cooldown: Dict[Tuple[str, str], float] = {}
        self._rate: Dict[str, deque] = {}

    def reset(self) -> None:
        self._dwell.clear()
        self._sustain.clear()
        self._vacant.clear()
        self._cooldown.clear()
        self._rate.clear()

    # -- helpers ----------------------------------------------------------

    def _cooled(self, rule_key: str, sub_key: str, now: float, cooldown: float) -> bool:
        """True when the rule is allowed to fire (and records the firing)."""
        key = (rule_key, sub_key)
        last = self._cooldown.get(key)
        if last is not None and cooldown > 0 and (now - last) < cooldown:
            return False
        self._cooldown[key] = now
        return True

    def _base_meta(self, rule: dict, frame_meta: dict) -> dict:
        meta = dict(frame_meta or {})
        meta.update({
            'custom_event': True,
            'custom_event_label': rule.get('label'),
            'custom_event_kind': rule.get('kind'),
            'importance': rule.get('importance', 'notable'),
        })
        if rule.get('zone'):
            meta['zone'] = rule['zone']
        return meta

    # -- public ------------------------------------------------------------

    def evaluate(
        self,
        *,
        now: float,
        detections: List[dict],
        tracks: Optional[List[dict]],
        builtin_events: List[DetectionEvent],
        frame_meta: Optional[dict] = None,
        rules: Optional[List[dict]] = None,
        zones: Optional[List[dict]] = None,
        suppressed: Optional[set] = None,
    ) -> List[DetectionEvent]:
        import environment_config as _env  # local import avoids an import cycle

        if rules is None:
            rules = _env.get_custom_events()
        if zones is None:
            zones = _env.get_zones()
        if suppressed is None:
            suppressed = set(_env.get_effective_disabled_events())

        sig = _rules_signature(rules, zones)
        if sig != self._sig:
            # Rules changed under us — stale timers would report nonsense.
            self.reset()
            self._sig = sig

        zone_map = {z['name']: z for z in zones}
        frame_meta = frame_meta or {}

        out: List[DetectionEvent] = []
        active_keys = set()

        for rule in rules:
            if not rule.get('enabled', True):
                continue
            event_type = rule.get('event_type')
            if not event_type or event_type in suppressed:
                continue
            handler = getattr(self, f'_eval_{rule.get("kind")}', None)
            if handler is None:
                continue
            zone = zone_map.get(rule['zone']) if rule.get('zone') else None
            try:
                produced = handler(
                    rule=rule, zone=zone, now=now, detections=detections,
                    tracks=tracks, builtin_events=builtin_events, frame_meta=frame_meta,
                )
                if produced:
                    out.extend(produced)
            except Exception as exc:  # a broken rule must never kill the frame
                print(f'[custom_events] rule {event_type!r} failed: {exc}')
            active_keys.add(event_type)

        # Drop dwell state for rules that no longer exist
        for key in [k for k in self._dwell if k[0] not in active_keys]:
            self._dwell.pop(key, None)

        return out

    # -- primitives --------------------------------------------------------

    # -- dwell identity resolution --------------------------------------
    #
    # A person must keep the same timer while they turn, gesture, sit down,
    # stand up, walk around a table, or vanish behind something. Three things
    # can change underneath us, none of which mean "different person":
    #   * Re-ID attaches a global_person_id only after a few stable frames
    #   * the local tracker drops and re-creates a track after ~5s unseen
    #   * the centroid moves a long way while the person is still "there"
    # So timer state is keyed on a resolved identity, and short gaps resume the
    # existing timer instead of starting a new one.

    def _resolve_dwell_identity(
        self, event_type: str, track: dict, now: float, cx: float, cy: float, grace: float
    ) -> tuple:
        gid = track.get('global_person_id')
        tkey = (event_type, 't:' + str(track.get('track_id')))
        gkey = (event_type, 'g:' + str(gid)) if gid else None

        if gkey and gkey in self._dwell:
            # Re-identified. Fold any local-track timer in, keeping the earliest start.
            if tkey in self._dwell:
                local = self._dwell.pop(tkey)
                existing = self._dwell[gkey]
                existing['since'] = min(existing['since'], local['since'])
            return gkey

        if gkey and tkey in self._dwell:
            # We just learned this track's global id — carry the timer over.
            self._dwell[gkey] = self._dwell.pop(tkey)
            return gkey

        key = gkey or tkey
        if key in self._dwell:
            return key

        # Unknown identity: a new track may still be someone whose timer is only
        # moments old — e.g. they stood up and the tracker lost them briefly.
        resumed = self._find_resumable(event_type, now, cx, cy, grace)
        if resumed is not None:
            state = self._dwell.pop(resumed)
            self._dwell[key] = state
            print(
                f'[dwell] {event_type}: resumed timer for a reappearing person '
                f'(gap {_fmt_duration(now - state["last_seen"])}, '
                f'already at {_fmt_duration(now - state["since"])})'
            )
        return key

    def _find_resumable(
        self, event_type: str, now: float, cx: float, cy: float, grace: float
    ) -> Optional[tuple]:
        """Most recent timer for this rule that went quiet nearby and recently."""
        best, best_gap = None, None
        for key, state in self._dwell.items():
            if key[0] != event_type:
                continue
            gap = now - state['last_seen']
            if gap <= 0 or gap > grace:
                continue  # still active this frame, or gone too long
            lx, ly = state.get('last_pos', state['anchor'])
            if ((cx - lx) ** 2 + (cy - ly) ** 2) ** 0.5 > _RESUME_RADIUS:
                continue
            if best_gap is None or gap < best_gap:
                best, best_gap = key, gap
        return best

    def _eval_dwell(self, *, rule, zone, now, detections, tracks, builtin_events, frame_meta):
        p = rule['params']
        event_type = rule['event_type']
        mode = p['mode']
        min_seconds = float(p['min_seconds'])
        repeat = float(p['repeat_seconds'])
        grace = float(p.get('absence_grace_seconds', 20.0))

        if not tracks:
            # Person tracking is only available on live camera sessions. Still
            # expire outstanding timers so nothing is left dangling.
            return self._expire_dwell(rule, now, set(), frame_meta)

        seen: set = set()
        events: List[DetectionEvent] = []

        for track in tracks:
            cx, cy = track.get('cx', 0.0), track.get('cy', 0.0)
            # In presence mode with no zone the whole frame counts; a zone (or
            # zone mode) restricts timing to that region.
            if zone is not None and not _in_zone(cx, cy, zone):
                continue

            key = self._resolve_dwell_identity(event_type, track, now, cx, cy, grace)
            seen.add(key[1])
            state = self._dwell.get(key)

            if state is None:
                self._dwell[key] = {
                    'anchor': (cx, cy), 'last_pos': (cx, cy), 'since': now,
                    'last_emit': None, 'emitted': 0, 'last_seen': now,
                    'away_since': None,
                    'global_person_id': track.get('global_person_id'),
                    'track_id': track.get('track_id'),
                    'confidence': track.get('confidence', 0.9),
                }
                print(
                    f'[dwell] {event_type}: timer started ({mode} mode) '
                    f'- fires at {_fmt_duration(min_seconds)}'
                )
                continue

            state['last_seen'] = now
            state['last_pos'] = (cx, cy)
            state['confidence'] = track.get('confidence', state.get('confidence', 0.9))
            state['global_person_id'] = track.get('global_person_id') or state.get('global_person_id')
            state['track_id'] = track.get('track_id')

            if mode == 'stationary':
                # Drift is measured against the person's own height so the same
                # rule behaves the same near and far from the camera, and a
                # brief excursion has to persist before it resets the clock.
                body = float(track.get('nh') or 0.0)
                scale = body if body > 0.02 else 0.25
                drift = ((cx - state['anchor'][0]) ** 2 + (cy - state['anchor'][1]) ** 2) ** 0.5
                if drift > float(p['max_drift']) * scale:
                    if state['away_since'] is None:
                        state['away_since'] = now
                    elif (now - state['away_since']) >= float(p.get('drift_grace_seconds', 10.0)):
                        held = now - state['since']
                        state.update({
                            'anchor': (cx, cy), 'since': now, 'last_emit': None,
                            'emitted': 0, 'away_since': None,
                        })
                        print(
                            f'[dwell] {event_type}: person left their spot for '
                            f'{_fmt_duration(float(p.get("drift_grace_seconds", 10.0)))} '
                            f'- clock reset (lost {_fmt_duration(held)})'
                        )
                        continue
                else:
                    # Back where they were; treat the excursion as never happening.
                    state['away_since'] = None

            elapsed = now - state['since']
            if elapsed < min_seconds:
                continue

            due = state['last_emit'] is None or (repeat > 0 and (now - state['last_emit']) >= repeat)
            if not due:
                continue

            state['last_emit'] = now
            state['emitted'] += 1
            print(f'[dwell] {event_type}: FIRED at {_fmt_duration(elapsed)}')
            meta = self._base_meta(rule, frame_meta)
            meta.update({
                'duration_seconds': round(elapsed, 1),
                'duration_human': _fmt_duration(elapsed),
                'track_id': state.get('track_id'),
                'milestone': state['emitted'],
                'mode': mode,
            })
            if state.get('global_person_id'):
                meta['global_person_id'] = state['global_person_id']
            events.append(DetectionEvent(
                source='custom', type=event_type,
                confidence=float(state.get('confidence') or 0.9),
                metadata=meta,
            ))

        events.extend(self._expire_dwell(rule, now, seen, frame_meta))
        return events

    def _expire_dwell(self, rule, now, seen: set, frame_meta) -> List[DetectionEvent]:
        """Emit the total-duration event once a person has been gone past the grace."""
        p = rule['params']
        event_type = rule['event_type']
        grace = float(p.get('absence_grace_seconds', 20.0))
        min_seconds = float(p['min_seconds'])
        events: List[DetectionEvent] = []

        for key in [k for k in self._dwell if k[0] == event_type]:
            state = self._dwell[key]
            if key[1] in seen:
                continue
            if (now - state['last_seen']) < grace:
                continue  # might still walk back into view

            total = state['last_seen'] - state['since']
            self._dwell.pop(key, None)
            if not p.get('emit_on_exit') or total < min_seconds:
                continue

            print(f'[dwell] {event_type}: person left after {_fmt_duration(total)}')
            meta = self._base_meta(rule, frame_meta)
            meta.update({
                'duration_seconds': round(total, 1),
                'duration_human': _fmt_duration(total),
                'track_id': state.get('track_id'),
                'completed': True,
            })
            if state.get('global_person_id'):
                meta['global_person_id'] = state['global_person_id']
            events.append(DetectionEvent(
                source='custom', type=f'{event_type}_ended',
                confidence=float(state.get('confidence') or 0.9),
                metadata=meta,
            ))
        return events

    # -- live timer snapshot (display only, never events) -----------------

    def active_timers(self, now: float, rules: List[dict]) -> List[dict]:
        """Current dwell timers for the live counter in the UI.

        Deliberately separate from evaluate(): emitting an event per frame to
        drive a counter would trigger AI reasoning every couple of seconds, keep
        activities from ever closing, and flood the database.
        """
        by_type = {r.get('event_type'): r for r in rules if r.get('kind') == 'dwell'}
        out: List[dict] = []
        for (event_type, ident), state in self._dwell.items():
            rule = by_type.get(event_type)
            if rule is None or not rule.get('enabled', True):
                continue
            gap = now - state['last_seen']
            elapsed = now - state['since']
            out.append({
                'event_type': event_type,
                'label': rule.get('label') or event_type,
                'identity': ident,
                'track_id': state.get('track_id'),
                'global_person_id': state.get('global_person_id'),
                'elapsed_seconds': round(elapsed, 1),
                'elapsed_human': _fmt_duration(elapsed),
                'min_seconds': float(rule['params']['min_seconds']),
                'fired_count': state['emitted'],
                # True while the person is out of sight but inside the grace window.
                'out_of_sight': gap > 1.5,
            })
        out.sort(key=lambda t: -t['elapsed_seconds'])
        return out

    def _eval_zone_count(self, *, rule, zone, now, detections, tracks, builtin_events, frame_meta):
        p = rule['params']
        event_type = rule['event_type']
        target = p['target']
        matches = [
            d for d in detections
            if d['class_name'] == target and _in_zone(d['cx'], d['cy'], zone)
        ]
        count = len(matches)
        state = self._sustain.setdefault(event_type, {'since': None, 'last_emit': None})

        if count < int(p['min_count']):
            state['since'] = None
            state['last_emit'] = None
            return []

        if state['since'] is None:
            state['since'] = now
        held = now - state['since']
        if held < float(p['sustained_seconds']):
            return []

        repeat = float(p['repeat_seconds'])
        due = state['last_emit'] is None or (repeat > 0 and (now - state['last_emit']) >= repeat)
        if not due:
            return []
        state['last_emit'] = now

        meta = self._base_meta(rule, frame_meta)
        meta.update({
            'count': count,
            'target': target,
            'sustained_seconds': round(held, 1),
        })
        conf = max((d['confidence'] for d in matches), default=0.9)
        return [DetectionEvent(source='custom', type=event_type, confidence=float(conf), metadata=meta)]

    def _eval_zone_vacant(self, *, rule, zone, now, detections, tracks, builtin_events, frame_meta):
        p = rule['params']
        event_type = rule['event_type']
        target = p['target']
        present = any(
            d['class_name'] == target and _in_zone(d['cx'], d['cy'], zone)
            for d in detections
        )
        state = self._vacant.setdefault(event_type, {'empty_since': None, 'last_emit': None})

        if present:
            state['empty_since'] = None
            state['last_emit'] = None
            return []

        if state['empty_since'] is None:
            state['empty_since'] = now
            return []

        empty_for = now - state['empty_since']
        if empty_for < float(p['min_seconds']):
            return []

        repeat = float(p['repeat_seconds'])
        due = state['last_emit'] is None or (repeat > 0 and (now - state['last_emit']) >= repeat)
        if not due:
            return []
        state['last_emit'] = now

        meta = self._base_meta(rule, frame_meta)
        meta.update({
            'empty_for_seconds': round(empty_for, 1),
            'empty_for_human': _fmt_duration(empty_for),
            'target': target,
        })
        return [DetectionEvent(source='custom', type=event_type, confidence=0.95, metadata=meta)]

    def _eval_object_present(self, *, rule, zone, now, detections, tracks, builtin_events, frame_meta):
        p = rule['params']
        event_type = rule['event_type']
        wanted = set(p['object_classes'])
        min_conf = float(p['min_confidence'])
        cooldown = float(p['cooldown_seconds'])

        best: Dict[str, dict] = {}
        for d in detections:
            if d['class_name'] in wanted and d['confidence'] >= min_conf and _in_zone(d['cx'], d['cy'], zone):
                if d['class_name'] not in best or d['confidence'] > best[d['class_name']]['confidence']:
                    best[d['class_name']] = d

        events: List[DetectionEvent] = []
        for class_name, d in best.items():
            if not self._cooled(event_type, class_name, now, cooldown):
                continue
            meta = self._base_meta(rule, frame_meta)
            meta.update({'object_class': class_name, 'bounding_box': d['bbox']})
            events.append(DetectionEvent(
                source='custom', type=event_type,
                confidence=float(d['confidence']), metadata=meta,
            ))
        return events

    def _eval_proximity(self, *, rule, zone, now, detections, tracks, builtin_events, frame_meta):
        p = rule['params']
        event_type = rule['event_type']
        targets = [d for d in detections if d['class_name'] == p['target'] and _in_zone(d['cx'], d['cy'], zone)]
        others = [d for d in detections if d['class_name'] == p['near']]
        if not targets or not others:
            self._sustain.pop(event_type, None)
            return []

        max_dist = float(p['max_distance_ratio'])
        closest = None
        for t in targets:
            for o in others:
                dist = ((t['cx'] - o['cx']) ** 2 + (t['cy'] - o['cy']) ** 2) ** 0.5
                if dist <= max_dist and (closest is None or dist < closest[0]):
                    closest = (dist, t, o)

        if closest is None:
            self._sustain.pop(event_type, None)
            return []

        state = self._sustain.setdefault(event_type, {'since': now, 'last_emit': None})
        held = now - state['since']
        if held < float(p['min_seconds']):
            return []
        if not self._cooled(event_type, 'pair', now, float(p['cooldown_seconds'])):
            return []

        dist, t, o = closest
        meta = self._base_meta(rule, frame_meta)
        meta.update({
            'target': p['target'],
            'near': p['near'],
            'distance_ratio': round(dist, 3),
            'sustained_seconds': round(held, 1),
            'bounding_box': t['bbox'],
        })
        return [DetectionEvent(
            source='custom', type=event_type,
            confidence=float(min(t['confidence'], o['confidence'])), metadata=meta,
        )]

    def _eval_event_rate(self, *, rule, zone, now, detections, tracks, builtin_events, frame_meta):
        p = rule['params']
        event_type = rule['event_type']
        watched = set(p['event_types'])
        window = float(p['window_seconds'])

        buf = self._rate.setdefault(event_type, deque())
        for ev in builtin_events or []:
            if ev.type in watched:
                buf.append(now)
        while buf and (now - buf[0]) > window:
            buf.popleft()

        if len(buf) < int(p['min_count']):
            return []
        if not self._cooled(event_type, 'window', now, float(p['cooldown_seconds'])):
            return []

        meta = self._base_meta(rule, frame_meta)
        meta.update({
            'count': len(buf),
            'window_seconds': window,
            'watched_event_types': sorted(watched),
        })
        buf.clear()
        return [DetectionEvent(source='custom', type=event_type, confidence=0.95, metadata=meta)]
