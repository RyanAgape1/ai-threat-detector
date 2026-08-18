"""
AI agent #1 — the context analyst.

Reads the free-text "primary security concerns" and "additional context" the
operator typed on the Environment page and decides whether those words imply
changes to *what the system detects* — as opposed to threshold tuning, which is
environment_agent.py's job.

This agent is read-only. It produces findings; event_designer_agent.py turns them
into installed rules. Splitting the two means the operator can review what the
system thinks they asked for before any detection logic changes.
"""
import json
import os
from typing import Optional

from openai import AsyncOpenAI

import custom_events
import environment_config

# Local Ollama by default, matching environment_agent.py. These agents emit
# structured tool calls rather than prose, so a local model is adequate - and
# the hosted key currently has no credits.
#_MODEL = "gemma4:12b"
_MODEL = "gpt-4o"   # hosted alternative (needs OPENAI_API_KEY credits)

# Flip this together with _MODEL / _get_client() below.
_USE_OLLAMA = False

# A local model drops the occasional tool call; one empty response must not be
# reported to the operator as "no changes needed".
_MAX_ATTEMPTS = 3


def _provider_kwargs() -> dict:
    """Ollama-only request options.

    gemma4 is a reasoning model, and Ollama caps generation at a 4096-token
    context by default (num_ctx is NOT settable over the OpenAI-compatible API).
    Its thinking tokens exhaust that budget before the tool call is emitted, so
    the request comes back empty with finish_reason="length". Turning thinking
    off takes tool-call reliability from roughly a third to consistent.
    Not a valid parameter for the hosted API, hence the gate.
    """
    return {"extra_body": {"think": False}} if _USE_OLLAMA else {}

_client: Optional[AsyncOpenAI] = None


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        #_client = AsyncOpenAI(
        #    base_url="http://localhost:11434/v1",
        #    api_key="ollama",
        #)
        _client = AsyncOpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
    return _client


_ANALYSIS_TOOL = {
    "type": "function",
    "function": {
        "name": "submit_analysis",
        "description": "Submit your analysis of whether this deployment's context requires detection-event changes.",
        "parameters": {
            "type": "object",
            "properties": {
                "context_understood": {
                    "type": "string",
                    "description": "One short paragraph restating what this operator is actually trying to monitor, in your own words. If they mentioned something you cannot support, say so here too.",
                },
                "requires_changes": {
                    "type": "boolean",
                    "description": "True if the context implies detection events should be added, removed, or re-enabled. False if the built-in event set already covers everything they described.",
                },
                "needed_events": {
                    "type": "array",
                    "description": "New detection capabilities the context calls for. Describe intent — the designer agent picks exact parameters. Empty if none are needed.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "purpose": {
                                "type": "string",
                                "description": "What should be detected or measured, in plain language, e.g. 'how long each customer stays seated at a table'",
                            },
                            "rationale": {
                                "type": "string",
                                "description": "Quote or paraphrase the part of the operator's text that calls for this",
                            },
                            "suggested_kind": {
                                "type": "string",
                                "enum": list(custom_events.RULE_KINDS.keys()),
                                "description": "Which primitive best expresses this",
                            },
                            "suggested_target": {
                                "type": "string",
                                "description": "Main object class involved, e.g. person, car, dog, cup",
                            },
                            "importance": {
                                "type": "string",
                                "enum": list(custom_events.IMPORTANCE_LEVELS),
                                "description": "'important' if it should appear in shift reports",
                            },
                            "needs_zone": {
                                "type": "boolean",
                                "description": "True if this only makes sense for a specific region of the frame the operator will have to calibrate",
                            },
                        },
                        "required": ["purpose", "rationale", "suggested_kind", "suggested_target", "importance", "needs_zone"],
                    },
                },
                "builtin_changes": {
                    "type": "array",
                    "description": "Built-in detection events to switch off (noise here) or back on (needed here). Empty if none.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "event_type": {"type": "string", "enum": custom_events.BUILTIN_EVENT_TYPES},
                            "action": {"type": "string", "enum": ["enable", "disable"]},
                            "reason": {"type": "string"},
                        },
                        "required": ["event_type", "action", "reason"],
                    },
                },
                "unsupported_requests": {
                    "type": "array",
                    "description": "Things the operator asked for that these primitives genuinely cannot do (e.g. face recognition, reading text, identifying specific named people, emotion detection). Be honest — do not invent a rule that only looks like it satisfies the request.",
                    "items": {"type": "string"},
                },
            },
            "required": ["context_understood", "requires_changes", "needed_events", "builtin_changes", "unsupported_requests"],
        },
    },
}


def _system_prompt() -> str:
    return f"""You analyse a security camera deployment's description and decide what it should DETECT.

A separate agent already handles threshold tuning (confidence gates, motion sensitivity, loitering seconds, time-of-day rules). Do NOT recommend threshold changes — focus only on which detection events should exist.

Built-in detection events that already exist:
{chr(10).join('- ' + t for t in custom_events.BUILTIN_EVENT_TYPES)}

New detection events can only be built from these primitives:
{custom_events.catalogue_text(brief=True)}

Detectable objects are the 80 COCO classes — people, vehicles, animals, bags, tableware, electronics, furniture. Anything outside that list cannot be detected.

How to think about it:
- The operator's words are the requirement. If they describe wanting to *know* or *track* something the built-in events do not report, that is a needed event.
- "How long does X stay" / "turnover" / "dwell time" / "wait time" → dwell. It tolerates normal movement (sitting, standing, turning, stepping away briefly), so it does not need a zone unless the question is genuinely about one specific region.
- "How many at once" / "queue" / "crowding" / "capacity" → zone_count.
- "Nobody there" / "unmanned" / "left unattended" → zone_vacant.
- An object class the built-in events ignore (pets, drinks, phones, laptops, bicycles) → object_present.
- "Someone hanging around near <thing>" → proximity.
- "Over and over" / "repeatedly" / "again and again" → event_rate.
- If the described environment makes a built-in event pure noise (e.g. constant staff movement in a busy kitchen), recommend disabling it. If it makes one essential, recommend enabling it.
- If the context is empty, vague, or fully covered by the built-ins, set requires_changes false and return empty arrays. Do not invent work.
- Never claim a primitive can do something it cannot. Anything requiring identity, faces, text, audio content, emotion, or object properties beyond the COCO class list goes in unsupported_requests.

Call submit_analysis exactly once."""


async def analyze_context(env_type: str, concerns: str, context: str) -> dict:
    """Run the analyst. Returns the analysis dict (never raises on model quirks)."""
    cfg = environment_config.load_config()
    existing = environment_config.get_custom_events()
    disabled = cfg.get("disabled_events", [])

    user_message = (
        f"Environment type: {env_type or cfg.get('environment_type', 'generic')}\n"
        f"Primary security concerns: {concerns or 'not specified'}\n"
        f"Additional context: {context or 'none'}\n\n"
        f"Currently suppressed built-in events: {disabled or 'none'}\n"
        f"Custom events already installed: "
        f"{[e['event_type'] for e in existing] or 'none'}\n\n"
        "Analyse whether this deployment needs detection-event changes."
    )

    # Local models intermittently return no tool call at all, which would look
    # to the caller like "nothing to change" — a silent wrong answer. Retry
    # rather than accept an empty analysis.
    analysis: dict = {}
    fallback_text = ""
    for attempt in range(_MAX_ATTEMPTS):
        response = await _get_client().chat.completions.create(
            model=_MODEL,
            messages=[
                {"role": "system", "content": _system_prompt()},
                {"role": "user", "content": user_message},
            ],
            tools=[_ANALYSIS_TOOL],
            tool_choice={"type": "function", "function": {"name": "submit_analysis"}},
            **_provider_kwargs(),
        )

        msg = response.choices[0].message
        fallback_text = fallback_text or (msg.content or "")
        if msg.tool_calls:
            try:
                parsed = json.loads(msg.tool_calls[0].function.arguments)
            except json.JSONDecodeError as exc:
                print(f"[analyst] attempt {attempt + 1}: unparseable tool arguments ({exc})")
                continue
            if isinstance(parsed, dict) and parsed:
                analysis = parsed
                break
        print(f"[analyst] attempt {attempt + 1}: no usable tool call, retrying")

    if not analysis:
        print("[analyst] giving up after retries — reporting no changes")

    # Normalise so the frontend and designer agent can rely on the shape
    return {
        "context_understood": str(analysis.get("context_understood") or fallback_text).strip(),
        "requires_changes": bool(analysis.get("requires_changes", False)),
        "needed_events": analysis.get("needed_events") or [],
        "builtin_changes": analysis.get("builtin_changes") or [],
        "unsupported_requests": analysis.get("unsupported_requests") or [],
    }
