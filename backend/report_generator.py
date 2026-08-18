import os
import time
from datetime import datetime, timezone
from typing import Optional
from uuid import uuid4

from openai import AsyncOpenAI

import environment_config as _env
import recordings_db

IMPORTANT_EVENT_TYPES = {
    'weapon_detected',
    'loitering_detected',
    'unattended_object',
    'crowd_or_confrontation',
    'person_moved_camera',
    'person_detected',
}
HIGH_CONFIDENCE_TYPES = {'rapid_motion'}
HIGH_CONFIDENCE_THRESHOLD = 0.75

_client: Optional[AsyncOpenAI] = None


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
        #_client = AsyncOpenAI(
        #    base_url="http://localhost:11434/v1",
        #    api_key="ollama"
        #)
    return _client


def _fmt(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')


def _is_important(event: dict) -> bool:
    t = event['type']
    # Custom events carry their own importance, set when the designer agent
    # installed them — a table timer shouldn't need a hardcoded entry here.
    if event.get('metadata', {}).get('custom_event'):
        return event['metadata'].get('importance') == 'important'
    return t in IMPORTANT_EVENT_TYPES or (
        t in HIGH_CONFIDENCE_TYPES and event['confidence'] >= HIGH_CONFIDENCE_THRESHOLD
    )


def _enrich_with_recording(events: list[dict], recordings: list[dict]) -> list[dict]:
    """Attach recording_id to events whose timestamp falls within a known recording.

    Primary match: session_id + time range.
    Fallback: time range only, so events from older/mismatched sessions still get linked.
    """
    enriched = []
    for ev in events:
        ev = dict(ev)
        camera_id = ev['metadata'].get('camera_id')
        ts = ev['timestamp']

        matched = False
        # Exact match first
        for rec in recordings:
            if rec.get('session_id') == camera_id and rec['started_at'] - 5 <= ts <= rec['ended_at'] + 5:
                ev['recording_id'] = rec['id']
                matched = True
                break

        # Fallback: any recording whose time window covers this event
        if not matched:
            for rec in recordings:
                if rec['started_at'] - 5 <= ts <= rec['ended_at'] + 5:
                    ev['recording_id'] = rec['id']
                    break

        enriched.append(ev)
    return enriched


def _build_person_journeys(all_events: list[dict], recordings: list[dict]) -> list[dict]:
    """Group person-related events by global_person_id into journey cards."""
    journey_types = {'person_detected', 'person_moved_camera', 'loitering_detected'}

    by_person: dict[str, list[dict]] = {}
    for ev in all_events:
        gid = ev['metadata'].get('global_person_id')
        if gid and ev['type'] in journey_types:
            by_person.setdefault(str(gid), []).append(ev)

    journeys = []
    for gid, events in by_person.items():
        events_sorted = sorted(events, key=lambda e: e['timestamp'])

        # Derive camera path
        camera_path: list[str] = []
        for ev in events_sorted:
            meta = ev['metadata']
            if ev['type'] == 'person_moved_camera':
                from_cam = str(meta.get('from_camera', ''))[:8]
                to_cam = str(meta.get('to_camera', ''))[:8]
                if from_cam and (not camera_path or camera_path[-1] != from_cam):
                    camera_path.append(from_cam)
                if to_cam:
                    camera_path.append(to_cam)
            elif ev['type'] == 'person_detected':
                cam = str(meta.get('camera_id', ''))[:8]
                if cam and (not camera_path or camera_path[-1] != cam):
                    camera_path.append(cam)

        journeys.append({
            'global_person_id': gid,
            'camera_path': camera_path,
            'events': _enrich_with_recording(events_sorted, recordings),
        })

    return journeys


def _build_llm_prompt(activities: list[dict], time_from: float, time_to: float) -> str:
    lines = [
        f"Monitoring period: {_fmt(time_from)} → {_fmt(time_to)}",
        f"Total activities in this period: {len(activities)}",
        "",
    ]

    for act in activities:
        started = _fmt(act['started_at'])
        closed = _fmt(act['closed_at']) if act.get('closed_at') else 'ongoing'
        cam = (act.get('camera_id') or 'upload')[:8]
        lines.append(f"Activity {act['id'][:8]}  [{started} → {closed}]  camera={cam}")

        if act.get('summary'):
            s = act['summary']
            lines.append(f"  AI summary: {s.get('summary', '')}")
            lines.append(f"  Threat level: {s.get('threat_level', 'unknown')}")
            if s.get('recommended_action'):
                lines.append(f"  Recommended action: {s['recommended_action']}")

        counts: dict[str, int] = {}
        for ev in act.get('events', []):
            counts[ev['type']] = counts.get(ev['type'], 0) + 1
        if counts:
            lines.append(f"  Detection events: {', '.join(f'{k}×{v}' for k, v in sorted(counts.items()))}")
        lines.append("")

    return "\n".join(lines)


async def generate_report(time_from: float, time_to: float) -> dict:
    activities = recordings_db.get_activities_in_range(time_from, time_to)
    recordings = recordings_db.list_recordings()

    # Flatten all events, tagging with activity_id
    all_events: list[dict] = []
    for act in activities:
        for ev in act.get('events', []):
            ev = dict(ev)
            ev.setdefault('activity_id', act['id'])
            all_events.append(ev)

    important_events = _enrich_with_recording(
        [ev for ev in all_events if _is_important(ev)],
        recordings,
    )

    person_journeys = _build_person_journeys(all_events, recordings)

    # Generate narrative
    prompt = _build_llm_prompt(activities, time_from, time_to)
    env_ctx = _env.get_environment_context()
    env_section = f"\n\nDeployment context:\n{env_ctx}" if env_ctx else ""
    report_system_prompt = (
        "You are a security operations analyst writing a shift summary report. "
        "Write a clear, professional narrative (3-5 paragraphs) covering: "
        "overall activity level, significant incidents, any patterns or concerns, "
        "and a brief overall threat assessment. "
        "Plain prose only — no JSON, no bullet points, no markdown headers."
        f"{env_section}"
    )
    try:
        client = _get_client()
        response = await client.chat.completions.create(
            model="gpt-4o",
            #model="gemma4:12b",
            max_tokens=1024,
            messages=[
                {"role": "system", "content": report_system_prompt},
                {"role": "user", "content": prompt},
            ],
        )
        narrative = response.choices[0].message.content or "No narrative returned."
    except Exception as exc:
        narrative = f"AI summary unavailable: {exc}"

    report_id = str(uuid4())
    recordings_db.save_report(
        id=report_id,
        generated_at=time.time(),
        time_from=time_from,
        time_to=time_to,
        narrative=narrative,
        important_events=important_events,
        person_journeys=person_journeys,
    )
    return recordings_db.get_report(report_id)
