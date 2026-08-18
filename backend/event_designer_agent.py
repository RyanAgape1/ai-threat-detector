"""
AI agent #2 — the event designer.

Takes the context analyst's findings and turns them into installed detection
logic: concrete custom event rules, named zones, and built-in event enable/
disable changes.

It authors *declarative specs only* (see custom_events.RULE_KINDS) — never code.
Every proposal is validated by custom_events.validate_batch before it is saved,
so a malformed or unsupported rule is rejected rather than silently installed.
If validation rejects everything, the errors are handed back and the agent gets
another attempt.

Prompt size is deliberately dynamic: the local model runs in a 4096-token
context, so the catalogue and tool schema are narrowed to the primitives the
analyst actually asked for. A full catalogue leaves no room to generate a reply.
"""
import json
import os
from typing import List, Optional

from openai import AsyncOpenAI

import context_analyst_agent
import custom_events
import environment_config

# Local Ollama by default, matching environment_agent.py. These agents emit
# structured tool calls rather than prose, so a local model is adequate - and
# the hosted key currently has no credits.
#_MODEL = "gemma4:12b"
_MODEL = "gpt-4o"   # hosted alternative (needs OPENAI_API_KEY credits)

# Flip this together with _MODEL / _get_client() below.
_USE_OLLAMA = False

# Round trips allowed for validation self-correction.
_MAX_ROUNDS = 3


def _provider_kwargs() -> dict:
    """Ollama-only request options — see context_analyst_agent._provider_kwargs.

    gemma4's thinking tokens otherwise consume Ollama's 4096-token budget before
    the tool call is emitted, returning an empty finish_reason="length" response.
    """
    return {"extra_body": {"think": False}} if _USE_OLLAMA else {}

# Classes worth naming explicitly; the rest of COCO still validates fine.
_COMMON_CLASSES = [
    'person', 'car', 'truck', 'bicycle', 'motorcycle', 'dog', 'cat', 'backpack',
    'handbag', 'suitcase', 'bottle', 'cup', 'bowl', 'laptop', 'cell phone',
    'chair', 'dining table', 'couch', 'tv', 'book', 'umbrella',
]

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


def _kinds_from_analysis(analysis: dict) -> List[str]:
    """Primitives the analyst asked for, falling back to the full catalogue."""
    kinds = [
        n.get("suggested_kind")
        for n in (analysis.get("needed_events") or [])
        if n.get("suggested_kind") in custom_events.RULE_KINDS
    ]
    # De-duplicate, preserve order.
    seen, ordered = set(), []
    for k in kinds:
        if k not in seen:
            seen.add(k)
            ordered.append(k)
    return ordered or list(custom_events.RULE_KINDS)


def _classes_from_analysis(analysis: dict) -> List[str]:
    targets = [
        str(n.get("suggested_target", "")).strip().lower()
        for n in (analysis.get("needed_events") or [])
    ]
    extra = [t for t in targets if t in custom_events.COCO_CLASSES and t not in _COMMON_CLASSES]
    return _COMMON_CLASSES + extra


def _build_tools(kinds: List[str]) -> list:
    return [{
        "type": "function",
        "function": {
            "name": "apply_detection_events",
            "description": "Install the detection events for this deployment.",
            "parameters": custom_events.build_apply_tool_schema(kinds),
        },
    }]


def _system_prompt(analysis: dict, kinds: List[str]) -> str:
    return f"""You design detection events for a security camera system, turning an analyst's findings into concrete rules.

You do NOT write code. You compose rules from these primitives:

{custom_events.catalogue_text(kinds=kinds)}

Object classes you may reference: {', '.join(_classes_from_analysis(analysis))} (any COCO class is valid).

Built-in events you may suppress or re-enable: {', '.join(custom_events.BUILTIN_EVENT_TYPES)}

Design rules:
- Name events for what they measure, snake_case: table_dwell, queue_length, pet_on_premises. Never reuse a built-in name.
- For dwell, use mode "presence" for almost everything — "how long at a table", "wait time", "how long in the shop". It keeps timing through normal human movement (turning, gesturing, sitting down, standing up, walking around a table) and survives brief occlusion. Only use "stationary" when standing still in one spot is itself the signal, e.g. someone motionless by a door.
- For a dwell timer set repeat_seconds for periodic progress (min_seconds 900 + repeat_seconds 900 reports at 15m/30m/45m) and keep emit_on_exit true so a final total-duration event lands on departure. That final event is what makes turnover reportable.
- Raise absence_grace_seconds (60-120) where people routinely walk out of view and come back, such as diners visiting the counter or restroom — the same timer resumes rather than restarting.
- Only define a zone when a rule needs one. You cannot see the camera view, so guess from the description, set needs_calibration true, and say so in your explanation.
- importance "important" only for events the operator should see in shift reports; constant measurements should be "notable" or "routine".
- Give every rule a cooldown or repeat interval so it cannot fire on every frame.
- Keep the set small: 1-4 events. Do not pad.
- Do not attempt anything the analyst listed as unsupported.

Call apply_detection_events once with the complete set."""


def _format_analysis(analysis: dict) -> str:
    """Compact text rendering — a raw JSON dump wastes scarce context."""
    lines = []
    if analysis.get("context_understood"):
        lines.append(f"Deployment: {analysis['context_understood']}")
    needed = analysis.get("needed_events") or []
    if needed:
        lines.append("\nEvents to build:")
        for n in needed:
            zone_note = " (needs a zone)" if n.get("needs_zone") else ""
            lines.append(
                f"- {n.get('purpose', '?')} | kind={n.get('suggested_kind')} "
                f"target={n.get('suggested_target')} importance={n.get('importance')}{zone_note}"
            )
    changes = analysis.get("builtin_changes") or []
    if changes:
        lines.append("\nBuilt-in changes requested:")
        for c in changes:
            lines.append(f"- {c.get('action')} {c.get('event_type')}: {c.get('reason', '')}")
    unsupported = analysis.get("unsupported_requests") or []
    if unsupported:
        lines.append(f"\nOut of scope (do not attempt): {'; '.join(unsupported)}")
    return "\n".join(lines)


async def design_events(
    env_type: str,
    concerns: str,
    context: str,
    analysis: Optional[dict] = None,
) -> dict:
    """Run the designer. Returns {analysis, custom_events, zones, disabled_events,
    explanation, errors, applied}."""
    if analysis is None:
        analysis = await context_analyst_agent.analyze_context(env_type, concerns, context)

    cfg = environment_config.load_config()
    kinds = _kinds_from_analysis(analysis)
    tools = _build_tools(kinds)

    installed = environment_config.get_custom_events()
    current_note = (
        f"\nAlready installed (replace or keep as appropriate): "
        f"{[e['event_type'] for e in installed]}" if installed else ""
    )

    user_message = (
        f"Environment: {env_type or cfg.get('environment_type', 'generic')}\n"
        f"{_format_analysis(analysis)}"
        f"{current_note}\n\n"
        "Install the detection events this deployment needs."
    )

    messages: list = [
        {"role": "system", "content": _system_prompt(analysis, kinds)},
        {"role": "user", "content": user_message},
    ]

    proposal: Optional[dict] = None
    explanation = ""
    last_errors: List[str] = []

    for round_num in range(_MAX_ROUNDS):
        response = await _get_client().chat.completions.create(
            model=_MODEL,
            messages=messages,
            tools=tools,
            # Force the call: a local model otherwise sometimes replies with
            # nothing at all, which would silently install no rules.
            tool_choice={"type": "function", "function": {"name": "apply_detection_events"}},
            **_provider_kwargs(),
        )
        choice = response.choices[0]
        msg = choice.message

        if not msg.tool_calls:
            print(
                f"[designer] round {round_num + 1}: no tool call "
                f"(finish_reason={choice.finish_reason}), retrying"
            )
            continue

        tool_call = msg.tool_calls[0]
        try:
            fn_args = json.loads(tool_call.function.arguments)
        except json.JSONDecodeError as exc:
            print(f"[designer] round {round_num + 1}: unparseable arguments ({exc}), retrying")
            continue

        if fn_args.get("explanation"):
            explanation = fn_args["explanation"]

        requested = fn_args.get("custom_events") or []
        events, zones, errors = custom_events.validate_batch(
            requested, fn_args.get("zones") or []
        )
        last_errors = errors

        # Accept when at least one rule survived, or when the model deliberately
        # proposed an empty set. Otherwise hand the errors back for a fix.
        if events or (not requested and not errors):
            proposal = fn_args
            break

        print(f"[designer] round {round_num + 1}: all {len(requested)} rule(s) rejected, asking for a fix")
        messages.append({
            "role": "assistant",
            "content": "",
            "tool_calls": [{
                "id": tool_call.id,
                "type": "function",
                "function": {"name": tool_call.function.name, "arguments": tool_call.function.arguments},
            }],
        })
        messages.append({
            "role": "tool",
            "tool_call_id": tool_call.id,
            "content": json.dumps({
                "status": "rejected",
                "errors": errors,
                "instruction": (
                    "Every rule was rejected. Fix these problems and call "
                    "apply_detection_events again. event_type must be snake_case and "
                    "must not match a built-in; object classes must be COCO classes; "
                    "a rule using a zone needs that zone in the zones array."
                ),
            }),
        })

    if proposal is None:
        return {
            "analysis": analysis,
            "custom_events": environment_config.get_custom_events(),
            "zones": environment_config.get_zones(),
            "disabled_events": cfg.get("disabled_events", []),
            "explanation": explanation or (
                "The designer agent could not produce a valid configuration. "
                "Nothing was changed — try again, or simplify the context description."
            ),
            "errors": last_errors,
            "applied": False,
        }

    events, zones, errors = custom_events.validate_batch(
        proposal.get("custom_events") or [], proposal.get("zones") or []
    )

    # Built-in enable/disable — union then subtract, so an event named in both
    # lists ends up enabled (explicit enable wins over a stale suppression).
    disabled = set(cfg.get("disabled_events", []))
    disabled.update(
        e for e in (proposal.get("disable_events") or []) if e in custom_events.BUILTIN_EVENT_TYPES
    )
    disabled.difference_update(proposal.get("enable_events") or [])

    environment_config.save_detection_events(
        custom_event_defs=events,
        zones=zones,
        disabled_events=sorted(disabled),
    )

    return {
        "analysis": analysis,
        "custom_events": events,
        "zones": zones,
        "disabled_events": sorted(disabled),
        "explanation": explanation,
        "errors": errors,
        "applied": True,
    }
