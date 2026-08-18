import json
import os
from typing import Any, List, Optional

from openai import AsyncOpenAI

import environment_config as _env
from models import DetectionEvent, Explanation

_client: Optional[AsyncOpenAI] = None

# Frames attached to a live, in-progress assessment. Deliberately small — this
# runs every few seconds for as long as the incident stays open.
LIVE_FRAME_LIMIT = 3

# Ceiling on frames attached to the closing summary. The activity's whole frame
# history is sent up to this many; past it the frames are sampled evenly across
# the incident rather than truncated, so the summary still sees start to finish.
# ~120 frames is roughly 10k image tokens and a 5 MB request.
RETRO_FRAME_LIMIT = int(os.environ.get("RETRO_FRAME_LIMIT", "120"))

_BASE_SYSTEM_PROMPT = """You are a security analysis AI that examines detection events from surveillance systems and provides detailed, evidence-based explanations.

You receive structured detection data from multiple sources:
- CV (computer vision): object detection, pose estimation, tracking
- AUDIO: sound classification, speech detection
- BEHAVIOR: movement patterns, proximity analysis
- CUSTOM: deterministic rules configured for this specific deployment (timers, occupancy counts, zone rules). These are measurements rather than inferences — treat their numbers as reliable, and read their metadata (duration_seconds, count, zone) as fact. A custom event firing is not by itself a threat; judge it against the deployment context.

When video frames are attached, use them as the primary source of truth. Visually verify every detection event against the frames. If a detection label (e.g. "shouting_detected", "elongated_object_detected") is not supported by what you can actually see in the footage, lower the confidence and note the discrepancy. Never overstate a threat that the visual evidence does not support.

Your job is to reason over this evidence like a forensic analyst — weigh conflicting signals, note what is absent, and produce falsifiable explanations.

Always respond with a valid JSON object (no markdown fences) matching this schema:
{
  "summary": "1-2 sentence narrative explanation",
  "evidence_for": ["specific signals supporting the primary hypothesis"],
  "evidence_against": ["signals that contradict or weaken the hypothesis"],
  "confidence": 0.0-1.0,
  "confidence_trend": "increasing|decreasing|stable",
  "threat_level": "low|medium|high|critical",
  "open_questions": ["things that would change your assessment if known"],
  "recommended_action": "what a security operator should do next"
}

Be specific — reference frame numbers, timestamps, event types. Acknowledge uncertainty. Never overstate confidence."""


def _build_system_prompt() -> str:
    ctx = _env.get_environment_context()
    if ctx:
        return _BASE_SYSTEM_PROMPT + f"\n\n--- Deployment Context ---\n{ctx}"
    return _BASE_SYSTEM_PROMPT


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
        #_client = AsyncOpenAI(
        #    base_url="http://localhost:11434/v1",
        #    api_key="ollama"
        #)
    return _client


def _events_to_text(events: List[DetectionEvent]) -> str:
    lines = []
    for e in events:
        lines.append(
            f"  - [{e.source.upper()}] type={e.type} confidence={e.confidence:.2f} "
            f"timestamp={e.timestamp:.3f} metadata={json.dumps(e.metadata)}"
        )
    return "\n".join(lines)


def _parse_explanation(raw: str) -> Optional[Explanation]:
    raw = raw.strip()
    if raw.startswith("```"):
        inner = [l for l in raw.splitlines() if not l.startswith("```")]
        raw = "\n".join(inner).strip()
    try:
        data = json.loads(raw)
        return Explanation(**data)
    except Exception:
        return None


def fallback_explanation(raw_text: str) -> Explanation:
    return Explanation(
        summary=raw_text[:500] if raw_text else "Unable to parse explanation.",
        evidence_for=[],
        evidence_against=[],
        confidence=0.0,
        confidence_trend="stable",
        threat_level="low",
        open_questions=["Response could not be parsed as structured JSON."],
        recommended_action="Review raw response manually.",
    )


def _sample_evenly(frames: List[str], limit: int) -> List[str]:
    """Up to `limit` frames spread across the whole list, keeping first and last.

    Used instead of truncation so a long incident is still represented end to
    end — losing the middle of a five-minute activity is worse than losing
    temporal resolution across it.
    """
    total = len(frames)
    if total <= limit:
        return list(frames)
    if limit <= 1:
        return [frames[-1]]
    step = (total - 1) / (limit - 1)
    indices = sorted({round(i * step) for i in range(limit)})
    return [frames[i] for i in indices]


def _build_user_content(text: str, frames: Optional[List[str]]) -> Any:
    """Plain string when no frames; vision list when frames are available.

    Frames are attached in chronological order and already selected by the
    caller — this does no further filtering.
    """
    if not frames:
        return text
    content: List[Any] = []
    # low detail = 85 tokens per image regardless of resolution
    for frame_b64 in frames:
        content.append({
            "type": "image_url",
            "image_url": {
                "url": f"data:image/jpeg;base64,{frame_b64}",
                "detail": "low",
            },
        })
    content.append({"type": "text", "text": text})
    return content


async def explain_live(
    events: List[DetectionEvent],
    prev_explanation: Optional[Explanation],
    frames: Optional[List[str]] = None,
) -> Explanation:
    client = _get_client()

    events_text = _events_to_text(events)
    prev_section = ""
    if prev_explanation:
        prev_section = (
            f"\nPrevious assessment:\n"
            f"  summary: {prev_explanation.summary}\n"
            f"  confidence: {prev_explanation.confidence}\n"
            f"  threat_level: {prev_explanation.threat_level}\n"
            f"Use the previous assessment to judge whether confidence is increasing, decreasing, or stable.\n"
        )

    # Only the most recent frames matter mid-incident; the full history is what
    # the closing summary gets.
    selected = (frames or [])[-LIVE_FRAME_LIMIT:]

    frame_note = (
        "\n\nThe most recent video frames from this incident are attached. "
        "Use them to visually verify the detections — override labels if visuals contradict them."
        if selected else ""
    )

    text_content = (
        f"Active incident — {len(events)} detection event(s) so far:\n"
        f"{events_text}\n"
        f"{prev_section}"
        f"{frame_note}\n"
        "Provide your current best assessment. The incident is still ongoing."
    )

    user_content = _build_user_content(text_content, selected)

    response = await client.chat.completions.create(
        model="gpt-4o",
        #model="gemma4:12b",
        max_tokens=2048,
        messages=[
            {"role": "system", "content": _build_system_prompt()},
            {"role": "user", "content": user_content},
        ],
    )

    raw = response.choices[0].message.content or ""
    explanation = _parse_explanation(raw)
    if explanation is None:
        explanation = fallback_explanation(raw)
    return explanation


async def explain_retrospective(
    events: List[DetectionEvent],
    frames: Optional[List[str]] = None,
) -> Explanation:
    client = _get_client()

    events_text = _events_to_text(events)

    # The whole incident, not just its tail — this is the one pass that gets to
    # look at the footage end to end.
    captured = frames or []
    selected = _sample_evenly(captured, RETRO_FRAME_LIMIT)

    frame_note = ""
    if selected:
        frame_note = (
            f"\n\n{len(selected)} video frame(s) from this incident are attached in "
            "chronological order, covering it from beginning to end."
        )
        if len(selected) < len(captured):
            print(
                f"[reasoning] retrospective: sampled {len(selected)} of "
                f"{len(captured)} captured frames (RETRO_FRAME_LIMIT={RETRO_FRAME_LIMIT})"
            )
            frame_note += (
                f" They are an even sample of the {len(captured)} frames captured, so "
                "the gaps between consecutive frames are elapsed time rather than "
                "moments when nothing was recorded."
            )
        frame_note += (
            " Read them as a sequence — what changes between frames is evidence. "
            "Use them to visually verify the detections and inform your final assessment."
        )

    text_content = (
        f"Closed incident — full timeline of {len(events)} detection event(s):\n"
        f"{events_text}"
        f"{frame_note}\n\n"
        "This is the complete incident timeline — provide a final comprehensive assessment. "
        "Summarize what happened, the overall threat level, and what the operator should take away."
    )

    user_content = _build_user_content(text_content, selected)

    response = await client.chat.completions.create(
        model="gpt-4o",
        #model="gemma4:12b",
        max_tokens=2048,
        messages=[
            {"role": "system", "content": _build_system_prompt()},
            {"role": "user", "content": user_content},
        ],
    )

    raw = response.choices[0].message.content or ""
    explanation = _parse_explanation(raw)
    if explanation is None:
        explanation = fallback_explanation(raw)
    return explanation
