import json
import os
from typing import Any, List, Optional

from openai import AsyncOpenAI

from models import DetectionEvent, Explanation

_client: Optional[AsyncOpenAI] = None

SYSTEM_PROMPT = """You are a security analysis AI that examines detection events from surveillance systems and provides detailed, evidence-based explanations.

You receive structured detection data from multiple sources:
- CV (computer vision): object detection, pose estimation, tracking
- AUDIO: sound classification, speech detection
- BEHAVIOR: movement patterns, proximity analysis

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


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
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


def _build_user_content(text: str, frames: Optional[List[str]]) -> Any:
    """Plain string when no frames; vision list when frames are available."""
    if not frames:
        return text
    content: List[Any] = []
    # Send at most 3 most-recent frames; low detail = 85 tokens each
    for frame_b64 in frames[-3:]:
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

    frame_note = (
        "\n\nVideo frames from this incident are attached. "
        "Use them to visually verify the detections — override labels if visuals contradict them."
        if frames else ""
    )

    text_content = (
        f"Active incident — {len(events)} detection event(s) so far:\n"
        f"{events_text}\n"
        f"{prev_section}"
        f"{frame_note}\n"
        "Provide your current best assessment. The incident is still ongoing."
    )

    user_content = _build_user_content(text_content, frames)

    response = await client.chat.completions.create(
        model="gpt-4o",
        max_tokens=1024,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
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

    frame_note = (
        "\n\nVideo frames from this incident are attached. "
        "Use them to visually verify the detections and inform your final assessment."
        if frames else ""
    )

    text_content = (
        f"Closed incident — full timeline of {len(events)} detection event(s):\n"
        f"{events_text}"
        f"{frame_note}\n\n"
        "This is the complete incident timeline — provide a final comprehensive assessment. "
        "Summarize what happened, the overall threat level, and what the operator should take away."
    )

    user_content = _build_user_content(text_content, frames)

    response = await client.chat.completions.create(
        model="gpt-4o",
        max_tokens=1024,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ],
    )

    raw = response.choices[0].message.content or ""
    explanation = _parse_explanation(raw)
    if explanation is None:
        explanation = fallback_explanation(raw)
    return explanation
