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

Time-based rules — always create these for environments with varying activity levels:
- "Business hours" (e.g. 8-20): normal/relaxed thresholds, more noise suppression
- "After hours" (e.g. 20-8, overnight): lower person_confidence (0.35) so any person is caught, shorten loitering_seconds (10-15s), re-enable events you suppressed during the day (e.g. movement), lower crowd_min_persons (2)
- Environments like malls, offices, schools — after hours any person at all is significant, so make detection very sensitive
- Parking lots at night — lower vehicle_confidence further (0.25), shorter loitering
- 24/7 environments (airports, warehouses) — still create shift-based rules: e.g. overnight shift has fewer workers so crowd threshold lower

After applying, write a 2-3 sentence plain-language explanation of what you changed and why, including the time rules."""


async def configure_environment(env_type: str, concerns: str, context: str) -> dict:
    """Run the agent to configure the environment. Returns {config, explanation}."""
    client = _get_client()

    user_message = (
        f"Environment type: {env_type}\n"
        f"Primary security concerns: {concerns or 'not specified'}\n"
        f"Additional context: {context or 'none'}\n\n"
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

    return {
        "config": applied_config,
        "explanation": final_explanation,
    }
