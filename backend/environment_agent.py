"""
AI agent for configuring the detection environment using OpenAI function calling.
"""
import json
import os
from typing import Optional

from openai import AsyncOpenAI

import environment_config

_client: Optional[AsyncOpenAI] = None


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        #_client = AsyncOpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
        _client = AsyncOpenAI(
            base_url="http://localhost:11434/v1",
            api_key="ollama"
        )
    return _client


_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_current_config",
            "description": "Get the current environment detection configuration",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "apply_config",
            "description": "Apply a new environment configuration with adjusted thresholds and custom rules",
            "parameters": {
                "type": "object",
                "properties": {
                    "environment_type": {
                        "type": "string",
                        "description": "Short label: mall, warehouse, airport, parking_lot, school, office, generic, etc.",
                    },
                    "description": {
                        "type": "string",
                        "description": "1-2 sentence explanation of the chosen settings",
                    },
                    "thresholds": {
                        "type": "object",
                        "description": "Threshold overrides (omit to keep default)",
                        "properties": {
                            "person_confidence": {"type": "number", "minimum": 0.1, "maximum": 0.95},
                            "bag_confidence": {"type": "number", "minimum": 0.1, "maximum": 0.95},
                            "vehicle_confidence": {"type": "number", "minimum": 0.1, "maximum": 0.95},
                            "crowd_min_persons": {"type": "integer", "minimum": 2, "maximum": 20},
                            "rapid_motion_threshold": {"type": "number", "minimum": 0.05, "maximum": 0.9},
                            "movement_threshold": {"type": "number", "minimum": 0.02, "maximum": 0.5},
                            "loitering_seconds": {"type": "number", "minimum": 5.0, "maximum": 300.0},
                            "reid_area_gate": {"type": "number", "minimum": 0.01, "maximum": 0.20},
                            "reid_min_frames": {"type": "integer", "minimum": 1, "maximum": 10},
                        },
                    },
                    "disabled_events": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Event types to suppress entirely. Options: movement, rapid_motion, vehicle_detected, person_detected, crowd_or_confrontation, unattended_object, weapon_detected, loitering_detected",
                    },
                    "time_rules": {
                        "type": "array",
                        "description": "Time-of-day threshold overrides. Each rule activates during a specific hour window and merges on top of the base thresholds.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "label": {"type": "string", "description": "Short name shown in the UI, e.g. 'After hours'"},
                                "description": {"type": "string", "description": "Plain-language explanation of what changes and why"},
                                "start_hour": {"type": "integer", "minimum": 0, "maximum": 23, "description": "Local hour (0-23) when this rule activates"},
                                "end_hour": {"type": "integer", "minimum": 0, "maximum": 23, "description": "Local hour (0-23) when this rule deactivates (exclusive). Use end < start for overnight windows."},
                                "thresholds": {
                                    "type": "object",
                                    "description": "Threshold overrides active during this window",
                                    "properties": {
                                        "person_confidence": {"type": "number"},
                                        "bag_confidence": {"type": "number"},
                                        "vehicle_confidence": {"type": "number"},
                                        "crowd_min_persons": {"type": "integer"},
                                        "rapid_motion_threshold": {"type": "number"},
                                        "movement_threshold": {"type": "number"},
                                        "loitering_seconds": {"type": "number"},
                                    },
                                },
                                "days": {
                                    "type": "array",
                                    "items": {"type": "integer", "minimum": 0, "maximum": 6},
                                    "description": "Days of week this rule applies (0=Mon, 1=Tue, 2=Wed, 3=Thu, 4=Fri, 5=Sat, 6=Sun). Empty array or omit for every day.",
                                },
                                "disabled_events": {
                                    "type": "array",
                                    "items": {"type": "string"},
                                    "description": "Additional event types to suppress only during this window",
                                },
                            },
                            "required": ["label", "description", "start_hour", "end_hour"],
                        },
                    },
                },
                "required": ["environment_type", "description", "thresholds", "disabled_events", "time_rules"],
            },
        },
    },
]

_SYSTEM_PROMPT = """You are a security camera system configuration expert. Your job is to tune detection thresholds and create time-based rules for a specific deployment environment.

First call get_current_config to see the baseline, then call apply_config with your recommended settings.

Base threshold guidelines by environment:
- Mall/retail: high foot traffic — raise person_confidence (0.55), raise crowd_min_persons (5), loitering 45s, suppress movement/rapid_motion noise
- Warehouse: vehicles critical — lower vehicle_confidence (0.35), lower person_confidence (0.40) since few workers, loitering 20s
- Airport: security-critical — keep defaults tight, loitering 60s, do NOT disable weapon_detected or unattended_object, crowd_min_persons 10
- Parking lot: vehicles are the main subject — lower vehicle_confidence (0.30), lower rapid_motion_threshold (0.15) to catch vehicle movement, loitering 30s
- School: child safety — loitering 15s, crowd_min_persons 6, suppress vehicle_detected if inside campus
- Office: low baseline activity — loitering 60s, raise rapid_motion_threshold (0.35) to reduce noise, suppress movement

Time-based rules — always create these for environments with varying activity levels. IMPORTANT: if the user provides exact business hours, you MUST use those exact start_hour and end_hour values — do not round or adjust them:
- "Business hours" (e.g. 8-20): normal/relaxed thresholds, more noise suppression
- "After hours" (e.g. 20-8, overnight): lower person_confidence (0.35) so any person is caught, shorten loitering_seconds (10-15s), re-enable events you suppressed during the day (e.g. movement), lower crowd_min_persons (2)
- If the user provides business days (e.g. Mon-Fri), set the days field on time rules accordingly: business hours rule gets those days, after-hours rule gets all days (empty) so closed days are fully covered by after-hours sensitivity
- Environments like malls, offices, schools — after hours any person at all is significant, so make detection very sensitive
- Parking lots at night — lower vehicle_confidence further (0.25), shorter loitering
- 24/7 environments (airports, warehouses) — still create shift-based rules: e.g. overnight shift has fewer workers so crowd threshold lower

After applying, write a 2-3 sentence plain-language explanation of what you changed and why, including the time rules."""


_DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']


async def configure_environment(
    env_type: str,
    concerns: str,
    context: str,
    business_hours_open: Optional[str] = None,
    business_hours_close: Optional[str] = None,
    business_days: Optional[list] = None,
) -> dict:
    """Run the agent to configure the environment. Returns {config, explanation}."""
    client = _get_client()

    # Parse business hours into integer hours for the agent
    hours_instruction = ""
    open_hour: Optional[int] = None
    close_hour: Optional[int] = None
    if business_hours_open and business_hours_close:
        try:
            open_hour = int(business_hours_open.split(":")[0])
            close_hour = int(business_hours_close.split(":")[0])
            days_str = ""
            days_instruction = ""
            if business_days:
                day_names = [_DAY_NAMES[d] for d in business_days if 0 <= d <= 6]
                days_str = f", open days: {', '.join(day_names)} (days={business_days})"
                days_instruction = (
                    f" You MUST set days={business_days} exactly on the business hours rule — do not change these values keep these EXACT values. "
                    f"Leave days=[] (empty) on the after-hours rule so it applies on all days including closed days."
                )
            hours_instruction = (
                f"\nBusiness hours (EXACT — you MUST use these exact values{days_str}): "
                f"open={open_hour:02d}:00 (start_hour={open_hour}), "
                f"close={close_hour:02d}:00 (end_hour={close_hour}). "
                f"Do not adjust these hours and do not adjust these days. Use start_hour={open_hour} end_hour={close_hour} "
                f"for the business hours rule, and start_hour={close_hour} end_hour={open_hour} "
                f"for the after-hours rule.{days_instruction}"
            )
        except (ValueError, IndexError):
            pass
    elif business_days:
        # Days provided without hours — just pass them as context
        day_names = [_DAY_NAMES[d] for d in business_days if 0 <= d <= 6]
        hours_instruction = (
            f"\nBusiness days: {', '.join(day_names)} (days={business_days}). "
            f"Set these days on business hours time rules. Leave after-hours rule days=[] so it covers all days."
        )

    user_message = (
        f"Environment type: {env_type}\n"
        f"Primary security concerns: {concerns or 'not specified'}\n"
        f"Additional context: {context or 'none'}"
        f"{hours_instruction}\n\n"
        "Please configure the detection system for this environment."
    )

    messages: list = [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {"role": "user", "content": user_message},
    ]

    applied_config = None
    final_explanation = ""

    for _ in range(6):
        response = await client.chat.completions.create(
            #model="gpt-4o",
            model="gemma4:12b",
            messages=messages,
            tools=_TOOLS,
            tool_choice="auto",
        )

        msg = response.choices[0].message

        # Add assistant message to history
        msg_dict: dict = {"role": "assistant", "content": msg.content or ""}
        if msg.tool_calls:
            msg_dict["tool_calls"] = [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {"name": tc.function.name, "arguments": tc.function.arguments},
                }
                for tc in msg.tool_calls
            ]
        messages.append(msg_dict)

        if msg.content:
            final_explanation = msg.content

        if not msg.tool_calls:
            break

        for tool_call in msg.tool_calls:
            fn_name = tool_call.function.name
            try:
                fn_args = json.loads(tool_call.function.arguments)
            except json.JSONDecodeError:
                fn_args = {}

            if fn_name == "get_current_config":
                result = json.dumps(environment_config.load_config())

            elif fn_name == "apply_config":
                new_config = {
                    "environment_type": fn_args.get("environment_type", "generic"),
                    "description": fn_args.get("description", ""),
                    "thresholds": {
                        **environment_config.DEFAULT_CONFIG["thresholds"],
                        **fn_args.get("thresholds", {}),
                    },
                    "disabled_events": fn_args.get("disabled_events", []),
                    "time_rules": fn_args.get("time_rules", []),
                }
                environment_config.save_config(new_config)
                applied_config = new_config
                result = json.dumps({"status": "applied"})

            else:
                result = json.dumps({"error": f"Unknown function: {fn_name}"})

            messages.append({
                "role": "tool",
                "tool_call_id": tool_call.id,
                "content": result,
            })

    if applied_config is None:
        applied_config = environment_config.load_config()

    # Server-side enforcement: if business_days provided, force days onto the business hours
    # rule regardless of what the LLM wrote, then add a closed-day all-day rule.
    if business_days is not None and len(business_days) < 7:
        closed_days = [d for d in range(7) if d not in business_days]
        if closed_days:
            time_rules = applied_config.get("time_rules", [])

            # Force business_days onto the business hours rule (identified by open_hour start)
            for rule in time_rules:
                if open_hour is not None and rule.get("start_hour") == open_hour:
                    rule["days"] = business_days
                    break

            # Find the after-hours rule: match by close_hour start, else any overnight rule
            after_hours_rule = None
            if close_hour is not None:
                after_hours_rule = next(
                    (r for r in time_rules if r.get("start_hour") == close_hour), None
                )
            if after_hours_rule is None:
                after_hours_rule = next(
                    (r for r in time_rules
                     if r.get("start_hour", 0) > r.get("end_hour", 1)),
                    None,
                )

            closed_rule: dict = {
                "label": "Closed day",
                "description": "After-hours sensitivity applied all day when the business is closed.",
                "start_hour": 0,
                "end_hour": 0,  # sentinel: all-day rule
                "days": closed_days,
            }
            if after_hours_rule:
                if "thresholds" in after_hours_rule:
                    closed_rule["thresholds"] = after_hours_rule["thresholds"]
                if "disabled_events" in after_hours_rule:
                    closed_rule["disabled_events"] = after_hours_rule["disabled_events"]

            applied_config["time_rules"].append(closed_rule)
            environment_config.save_config(applied_config)

    return {
        "config": applied_config,
        "explanation": final_explanation,
    }
