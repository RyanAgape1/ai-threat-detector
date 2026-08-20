# Anomaly Explanation Engine

A security camera system that detects, tracks, and then **reasons about** what it saw — producing written explanations with evidence for and against its own conclusion.

Most camera systems tell you *that* something happened. This one tells you what it thinks is happening, why it thinks so, what would change its mind, and what you should do about it.

---

## Contents

- [What it does](#what-it-does)
- [Stack](#stack)
- [Quick start](#quick-start)
- [The signal path](#the-signal-path)
- [Detection](#detection)
- [Identity across cameras](#identity-across-cameras)
- [Custom detection events](#custom-detection-events)
- [The agents](#the-agents)
- [Activities and reasoning](#activities-and-reasoning)
- [Configuration](#configuration)
- [Audio](#audio)
- [Storage and reports](#storage-and-reports)
- [Frontend](#frontend)
- [API reference](#api-reference)
- [Project layout](#project-layout)
- [The idea underneath all of it](#the-idea-underneath-all-of-it)
- [Known constraints](#known-constraints)

---

## What it does

- Watches one or more live cameras (or an uploaded video) and detects people, vehicles, bags, weapons, crowds, and motion.
- Tracks each person and re-identifies them **across cameras**, so one individual keeps one identity as they move around.
- Lets you describe your deployment in plain English; AI agents then tune the detection thresholds and **build custom detection rules** specific to your site.
- Groups related detections into *activities* and has a vision model explain each one as it unfolds, then summarise it once it ends.
- Records continuously, stores everything in SQLite, and generates shift reports over any time range — including reconstructed journeys for each person seen.

---

## Stack

| Layer | Technology |
|---|---|
| Backend | FastAPI, Python 3.9, uvicorn |
| Frontend | React 18, TypeScript, Vite, Tailwind CSS |
| Object detection | YOLOv8n via ultralytics (auto-downloads ~6 MB on first run) |
| Person Re-ID | OSNet x0.25 via torchreid |
| Reasoning | OpenAI `gpt-4o` (vision) |
| Transcription | OpenAI `whisper-1` |
| Storage | SQLite, local video files, optional S3 backup |

Roughly 5,100 lines of Python across 17 modules and 5,500 lines of TypeScript across 20 files.

---

## Quick start

### Prerequisites

- Python 3.9+
- Node 18+
- An OpenAI API key with credits
- `ffmpeg` on PATH (optional — only needed for audio analysis of *uploaded* videos)

### Backend

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

Create `backend/.env`:

```bash
OPENAI_API_KEY=sk-...

# Optional — enables hourly DB snapshots and recording upload to S3
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_S3_BUCKET=
AWS_REGION=

# Optional — frames attached to the closing summary of an activity (default 120)
RETRO_FRAME_LIMIT=120
```

Run it:

```bash
python main.py          # http://localhost:8000
```

The server starts with `reload=False`, so **restart it manually after backend edits**.

### Frontend

```bash
cd frontend
npm install
npm run dev             # http://localhost:5173
```

The backend URL is hardcoded to `http://localhost:8000` in the frontend.

### First run

Open the app and pick one of two paths:

- **Quick Start** — turns your camera on and drops you straight into the activity log with current settings.
- **Setup** — a plain-language guide, then a walkthrough that highlights each field on the environment page until configuration is complete.

---

## The signal path

```
browser camera ──2 fps JPEG──►  POST /stream/frame
                                      │
                            detector.detect()          ← YOLO + optical flow
                                      │  events + raw detections
                     StreamProcessor._apply_person_tracking()
                                      │  identity attached
                     StreamProcessor._evaluate_custom_events()
                                      │  your rules
                              EvidenceBus.ingest()
                                      │  grouped into activities
                            reasoning.explain_live()   ← gpt-4o vision
                                      │
                              WebSocket ──► live UI
```

The browser owns the camera. `useCamera.ts` grabs a frame every 500 ms, encodes it at 640 px wide as JPEG, and POSTs it. In parallel it records 2-second audio chunks and posts those to a separate endpoint.

---

## Detection

`detector.py` → `detect(frame, prev_gray, frame_num, fps)` returns **two** things, and the second is the interesting one:

```python
return events, detections
```

`events` are the gated built-in detections. `detections` is **every** YOLO box above a floor of 0.30 — including classes the built-ins ignore — carrying both pixel bbox and frame-normalised centroid. That is what lets custom rules reach all 80 COCO classes **without a second inference pass**. One YOLO call feeds both systems.

### Built-in event types

| Event | Source | Fires when |
|---|---|---|
| `person_detected` | cv | A new tracked person appears |
| `weapon_detected` | cv | COCO knife or scissors |
| `vehicle_detected` | cv | Car, motorcycle, bus, or truck |
| `unattended_object` | cv | A bag with no person within 1.5× its own diagonal |
| `crowd_or_confrontation` | behavior | Person count ≥ configured minimum |
| `loitering_detected` | behavior | A track persists past the loitering threshold |
| `rapid_motion` | behavior | Frame-difference ratio above the rapid threshold |
| `movement` | behavior | Frame-difference ratio above the movement threshold |
| `person_moved_camera` | behavior | Re-ID recognises someone on a different camera |
| `elevated_noise` | audio | Sustained volume above threshold |
| `shouting_detected` | audio | Volume peak plus a keyword in the transcript |

### Details worth knowing

**Two-pass structure.** Persons and bags are collected into separate lists first, then emitted — `unattended_object` needs to know about persons before it can decide anything.

**Scale-aware proximity.** A bag counts as unattended only when no person is within `1.5 × the bag's own diagonal`. Using the object's own size rather than a fixed pixel distance means the rule behaves the same for a suitcase in the foreground and a handbag across the room.

**Confidence is derived, not passed through.** Unattended objects get `conf × 0.8` — the classification is certain, the *inference* is not. Crowds get `min(0.88, 0.50 + n × 0.08)`. Rapid motion gets `min(0.90, 0.55 + motion × 1.5)`. Each is capped, so nothing ever reports near-certainty.

**Motion** is `absdiff(prev_gray, gray)` → threshold at 25 → ratio of changed pixels. `rapid_motion` and `movement` are an `if/elif`, so they are mutually exclusive.

Thresholds and the disabled-event set are re-read **every frame** from the in-memory config cache, which is why agent retuning takes effect live with no restart.

---

## Identity across cameras

Two layers: local tracking within one camera, and global re-identification across all of them.

### `_apply_person_tracking()` — `video_processor.py`

Raw `person_detected` events are **replaced**, not augmented. The function returns `other_events + tracking_events + reid_events`.

1. **Expire** tracks unseen for 5 s.
2. **Greedy nearest-neighbour match** — for each detection, find the closest unmatched track; accept if within 0.35 of the frame diagonal (normalised, so resolution-independent).
3. **Create** tracks for unmatched detections.
4. **Deferred Re-ID.**

### The Re-ID triple gate

```python
if track.reid_done or track.frames_seen < reid_min_frames:  continue
if bb_area < frame_area * reid_area_gate or track.confidence < 0.55:  continue
```

Three conditions before an embedding is ever extracted: the track must have survived ≥3 consecutive frames, the bounding box must be ≥4 % of frame area, and detection confidence ≥0.55. A blurry 30 px crop of a half-occluded person produces a garbage embedding that would poison the registry permanently — so it waits, and simply tries again next frame.

`reid.extract_embedding()` adds its own floor (`w < 20 or h < 40 → None`) and keeps a module-level `_available` flag: if torchreid fails to load once, Re-ID disables itself for the whole process rather than throwing on every frame.

### `GlobalPersonRegistry.identify(embedding, camera_id) → (gid, moved_from)`

Thread-safe via `threading.Lock` — it is called from the executor thread that runs frame processing.

Embeddings are L2-normalised at extraction, so cosine similarity is just `np.dot`. Linear scan across identities; **≥0.65 is a match**. On a match it does three things:

- Detects a **camera change** by comparing `last_camera` and appends to `camera_path` — this is what produces `person_moved_camera`.
- **EMA-updates the stored embedding** at α = 0.2 and renormalises, so the identity drifts toward how the person currently looks (lighting, angle) instead of being frozen at first sighting.
- Refreshes `last_seen`; identities silent for 300 s are expired.

**Event emission per track:** `person_detected` fires **once** per track (an `announced` flag); `loitering_detected` then repeats every `loitering_seconds`. A person standing still generates one arrival plus periodic escalation, not a flood.

---

## Custom detection events

`custom_events.py` (~1,000 lines) owns the catalogue, the validator, **and** the runtime evaluator — so the description the agents read and the behaviour that executes cannot drift apart.

### The six primitives

| Primitive | Measures |
|---|---|
| `dwell` | How long an individual stays — turnover, wait time |
| `zone_count` | How many at once — queue length, crowding |
| `zone_vacant` | Nothing there for N seconds — unmanned post |
| `object_present` | Any COCO class the built-ins ignore |
| `proximity` | One class lingering near another |
| `event_rate` | A built-in event firing too often in a window |

A primitive is a template, not an event. `dwell` becomes `table_dwell` (person, 900 s, presence mode) in a restaurant and `loiter_by_door` (person, 120 s, stationary mode) in a car park. Same primitive, completely different events.

### `CustomEventEngine.evaluate()`

**Rules-signature check.** It hashes `(event_type, kind, zone, sorted params)` for every rule plus zone geometry. If that changed since the last frame it calls `reset()` — otherwise a timer started under the old parameters would report a duration that means nothing.

**Dispatch by convention:** `getattr(self, f'_eval_{kind}')`. Adding a primitive is adding a method.

**Per-rule `try/except`.** A broken rule prints and is skipped; it can never take down the frame.

### Dwell identity resolution — the hardest problem here

A timer must survive three things that do not mean "different person": Re-ID attaching a `global_person_id` only after several frames, the local tracker dropping and recreating a track, and the centroid moving.

`_resolve_dwell_identity()` handles all three:

- **Global key exists** → fold any local-track timer into it, keeping the **earliest** `since`.
- **Global id just learned** → carry the local timer over under the new key.
- **Neither** → `_find_resumable()` looks for a timer for this rule that went quiet within the grace window and whose last known position is within 0.25 of the frame diagonal. Nearest-in-time wins.

**Stationary mode measures drift in multiples of the person's own body height**, not fixed units — so one rule behaves identically near and far from the camera. Drift must also persist for `drift_grace_seconds` before resetting the clock, so a gesture or a shift of weight cannot wipe out twenty minutes of timing.

**`_expire_dwell` reports `last_seen − since`, not `now − since`.** The trailing grace period is trimmed, so a 90-second grace does not inflate every reported duration by 90 seconds.

**`active_timers()` is deliberately separate from `evaluate()`.** The live UI counter is a display snapshot that never enters the event stream — emitting an event per frame to drive a counter would trigger reasoning every couple of seconds, keep activities from ever closing, and flood the database.

### Validation

`normalize_definition()` coerces every param to its declared type and **clamps it to catalogue bounds**; anything omitted gets the default, so a half-specified rule comes out complete rather than broken. Then per-kind semantic checks:

- `zone_vacant` requires a zone — an empty whole frame is not meaningful
- `dwell` in `zone` mode requires a zone
- `object_present` needs at least one valid COCO class
- `event_rate` needs at least one valid built-in event type
- targets must be real COCO classes; names must be snake_case and must not collide with a built-in

Zone normalisation clamps to 0–1 **and enforces a minimum area**, so garbage input cannot produce a zero-area rectangle pinned to the frame edge.

### Zones

Zones are rectangles in frame fractions (0–1), so they are resolution-independent. The agent cannot see your camera, so it guesses a plausible rectangle, sets `needs_calibration: true`, and says so in its explanation. You then adjust it on the environment page against a live preview of the camera feed, with a draggable and resizable box.

---

## The agents

Three agents, split by what they are allowed to change.

### 1. Environment agent — `environment_agent.py`

OpenAI function calling with `get_current_config` / `apply_config`. Tunes **numbers only**: confidence gates, motion sensitivity, loitering seconds, plus time rules that swap thresholds outside business hours. It can never change *what* is detected.

### 2. Context analyst — `context_analyst_agent.py`

Read-only. A forced single tool call to `submit_analysis` returns:

- `context_understood` — its restatement of what you are monitoring, so you can tell whether it misread you
- `needed_events` — intent-level descriptions with a suggested primitive, but no parameters
- `builtin_changes` — built-ins to suppress as noise or re-enable
- `unsupported_requests` — the honest list. Face recognition, reading text, identifying named people, emotion detection all land here rather than becoming a rule that only *looks* like it satisfies the ask.

It retries up to three times, because a dropped tool call would otherwise read as "nothing to change" — a silent wrong answer.

### 3. Event designer — `event_designer_agent.py`

Turns those findings into installed rules. It authors declarative specs only, never code, and everything passes `validate_batch` before saving.

**Validation failure is a conversation.** If every rule is rejected, the errors go back as a `tool` message and the model gets another round (up to three) to fix them.

`_kinds_from_analysis()` narrows both the catalogue text and the tool schema enum to only the primitives the analyst asked for — originally a context-budget measure for a local model, now also a useful scope constraint.

Splitting analyst from designer means you review what the system thinks you asked for **before** any detection logic changes.

---

## Activities and reasoning

`evidence_bus.py` groups events into **activities** — one per camera, closed after 8 seconds of quiet. Uploads use `camera_id=None` and get their own slot.

**Frame dedup.** Callers ingest each event on a frame separately, handing over the same image every time, so it is stored once. At 600 frames the buffer thins with `del buf[1::2]` — halving the frame rate rather than dropping the oldest, because a long incident still needs its beginning in the summary.

**Reasoning cadence.** Every 3 events, plus a 5-second periodic tick. `_trigger_reasoning` takes a per-activity `asyncio.Lock` and **returns immediately if it is locked**, so a burst of events cannot stack overlapping inference on the same activity.

**Closing is instant, summarising is not.** `_close_activity` marks the activity closed and broadcasts immediately, then hands off to `_finalize_activity` as a background task. The UI closes the incident instantly; the retrospective summary arrives later via `reasoning_update`. Slow inference never blocks the interface.

**Memory.** `_cleanup_loop` evicts closed activities older than an hour — they are already in SQLite, so nothing is lost.

### `reasoning.py`

Every explanation is a structured `Explanation`:

```
summary, evidence_for, evidence_against, confidence,
confidence_trend, threat_level, open_questions, recommended_action
```

`_build_user_content()` returns a plain string when there are no frames and a vision content list when there are — one function, both shapes. The live pass attaches the most recent 3 frames; the **closing pass attaches the whole incident**, up to `RETRO_FRAME_LIMIT`, with `_sample_evenly()` keeping first and last so a long activity is represented end to end rather than truncated to its tail.

`_parse_explanation()` strips markdown fences before `json.loads`, and `fallback_explanation()` wraps unparseable output as a zero-confidence `Explanation` — so a malformed model response degrades instead of throwing.

The system prompt injects deployment context from config and instructs the model to treat custom events as **measurements rather than inferences**, and to lower confidence when the frames contradict a detection label.

---

## Configuration

`environment_config.py` reads and writes `backend/environment_config.json` (gitignored — it is runtime state, not source).

```jsonc
{
  "environment_type": "mall",
  "description": "...",
  "thresholds": { "person_confidence": 0.45, "loitering_seconds": 30.0, ... },
  "time_rules":  [ { "start_hour": 22, "end_hour": 6, "days": [0,1,2,3,4],
                     "thresholds": {...}, "disabled_events": [...] } ],
  "disabled_events": ["movement"],
  "custom_events": [ /* designer-authored rule specs */ ],
  "zones":         [ /* named frame regions */ ]
}
```

`load_config()` caches in memory; every hot path reads the cache, so per-frame threshold lookups never hit disk.

`get_active_time_rule()` returns the first rule whose hour window and weekday set cover now. `start == end` is the all-day sentinel, and windows that wrap midnight (`start > end`) are handled explicitly.

- `get_effective_thresholds()` = base merged with the active rule's overrides
- `get_effective_disabled_events()` = base **∪** the active rule's additions
- `get_environment_context()` = the plain-text block injected into every reasoning prompt

---

## Audio

Loudness is measured **in the browser** — Python cannot decode WebM, so the browser's Web Audio analyser is polled every 50 ms and accumulated across each 2-second chunk, producing both a mean RMS and the loudest window inside it. Transcription happens server-side via Whisper.

| Gate | Uses | Threshold |
|---|---|---|
| Silence (skip Whisper entirely) | `max(mean, peak)` | 0.005 |
| `elevated_noise` | mean | 0.035 |
| `shouting_detected` | peak **and** a keyword in the transcript | 0.09 |

Mean drives sustained loudness; peak drives the shout gate, because a two-second mean washes out a one-second shout. The two events are checked in order with an early return, so a chunk produces **one event or none**, never both.

MediaRecorder runs in discrete start/stop cycles rather than timeslice mode: in timeslice mode only the first blob carries the WebM header, so Whisper accepts chunk 1 of a session and rejects every one after it.

Uploaded video takes a different path — `ffmpeg` extracts a WAV, `_split_wav()` cuts it into 2-second segments, and RMS is computed server-side from the actual samples.

---

## Storage and reports

**SQLite schema:** `recordings`, `activities`, `detection_events`, `explanations`, `reports`.

**Recording checkpoints every 30 minutes.** `_do_checkpoint()` releases the writer, saves metadata, and resets for a fresh segment, so a crash can lose at most half an hour. `MIN_FRAMES_TO_SAVE` deletes segments too short to be worth keeping. `_rec_frame_offset` keeps `frame_id` relative to the current segment so UI seek still works after a checkpoint.

**Shift reports** — `report_generator.py` runs gpt-4o over any time range:

- `_is_important()` **defers to the custom event's own `importance` field** for designer-authored events, rather than a hardcoded list — a table timer installed last week does not need an entry here.
- `_enrich_with_recording()` matches events to footage in two tiers: `session_id` + time window first, then time window alone as a fallback (±5 s), so events from older or mismatched sessions still link to video.
- `_build_person_journeys()` reconstructs each person's camera path from `person_moved_camera` from/to pairs plus `person_detected` camera ids, deduping consecutive repeats.
- `_build_llm_prompt()` compresses each activity to summary + threat level + **event type counts** rather than dumping raw events, keeping a long shift inside the context window.

**S3 backup** is optional and off unless all AWS variables are set: hourly DB snapshots, and recordings uploaded as they are saved.

---

## Frontend

Three tabs — **Activity Log**, **Activity Report**, **Environment** — behind a landing screen offering Quick Start or Setup.

| Hook | Responsibility |
|---|---|
| `useCamera` | Device enumeration, getUserMedia, frame capture loop, audio capture |
| `useWebSocket` | Live activity stream, snapshots, upload progress, dwell timers |
| `useRecordings` | Recording list, playback URLs, deletion |
| `useReports` | Shift report generation and history |
| `useResolutions` | Operator verdicts on activities |

**`useCamera.ts`** dedupes by device id, resolves the real device id after permission is granted (it is empty before), runs a 500 ms frame loop and a 50 ms RMS accumulation poll, and drives per-chunk MediaRecorder cycles.

**`useWebSocket.ts`** keeps `snapshots` keyed by event id and deliberately **does not clear them on reconnect**, since `all_activities` restores the events but not their frame data.

WebSocket message types: `all_activities`, `activity_opened`, `event_added`, `reasoning_update`, `activity_closed`, `dwell_timers`, `upload_progress`.

---

## API reference

### Streaming

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/stream/start` | Register a camera session, returns `session_id` |
| `POST` | `/stream/frame` | One JPEG frame — runs the full detection pipeline |
| `POST` | `/stream/audio` | One 2-second audio chunk plus `rms` and `rms_peak` |
| `POST` | `/stream/reset` | Finalise the recording and tear down the session |
| `WS` | `/ws` | Live activity, reasoning, and timer stream |

### Activities

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/activities` | All in-memory activities |
| `GET` | `/activities/{id}` | One activity with events and explanations |
| `POST` | `/activities/clear` | Clear the in-memory feed |
| `POST` | `/events` | Inject a detection event manually |

### Video upload

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/upload` | Upload a video for background analysis |
| `GET` | `/upload/{job_id}` | Job progress |

### Recordings

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/recordings` | List saved recordings |
| `GET` | `/recordings/{id}/video` | Stream the video file |
| `GET` | `/recordings/{id}/activities` | Activities that fall inside a recording |
| `DELETE` | `/recordings/{id}` | Delete recording and its activities |

### Reports

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/reports/generate` | Generate a shift report for a time range |
| `GET` | `/reports` | List reports |
| `GET` | `/reports/{id}` | One report |
| `DELETE` | `/reports/{id}` | Delete a report |

### Environment and detection events

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/environment/config` | Current configuration |
| `POST` | `/environment/configure` | Run the environment agent |
| `GET` | `/detection-events` | Custom events, zones, primitives, class list |
| `POST` | `/detection-events/analyze` | Agent 1 — read-only findings |
| `POST` | `/detection-events/apply` | Agent 2 — design and install rules |
| `PATCH` | `/detection-events/{event_type}` | Enable/disable or retune a rule |
| `DELETE` | `/detection-events/{event_type}` | Delete a rule |
| `PATCH` | `/detection-events/zones/{zone_name}` | Recalibrate a zone |

---

## Project layout

```
backend/
  main.py                     FastAPI app, all routes, WebSocket hub
  detector.py                 YOLOv8n + optical-flow motion analysis
  video_processor.py          StreamProcessor, person tracking, recording
  reid.py                     OSNet embedding extraction
  global_person_registry.py   Cross-camera identity matching
  custom_events.py            Primitive catalogue, validation, runtime engine
  environment_agent.py        Agent — thresholds and time rules
  context_analyst_agent.py    Agent 1 — reads context, reports findings
  event_designer_agent.py     Agent 2 — designs and installs rules
  reasoning.py                Live and retrospective explanations
  report_generator.py         Shift reports and person journeys
  audio_analyzer.py           RMS gating and Whisper transcription
  evidence_bus.py             Activity lifecycle and reasoning cadence
  environment_config.py       Config cache, time rules, effective values
  recordings_db.py            SQLite persistence
  s3_backup.py                Optional off-site backup
  models.py                   DetectionEvent, Explanation, Activity

frontend/src/
  App.tsx                     Screen routing, tabs, camera wiring
  components/                 StartScreen, SetupGuide, EnvironmentSetup,
                              DetectionEventsPanel, IncidentFeed,
                              ReasoningPanel, ReportTab, RecordingsModal, ...
  hooks/                      useCamera, useWebSocket, useRecordings, ...
```

---

## The idea underneath all of it

The model is kept away from anything it could get subtly wrong. It tunes numbers and composes rules from a fixed catalogue; it never writes executable logic. Detection stays deterministic and reproducible, and a bad model output produces a validation error rather than unpredictable behaviour.

The same instinct shows up everywhere else: confidence values are capped, distances are measured relative to the object's own size, timers report elapsed time rather than wall clock, and every irreversible step is gated behind something that can fail safely.

The model's judgment is spent where judgment actually belongs — explaining what the deterministic layer observed.

---

## Known constraints

- **Cannot** recognise faces, read text or number plates, identify named individuals, or judge emotion. The context analyst says so explicitly rather than building a rule that only looks like it satisfies the request.
- **Detection is limited to the 80 COCO classes** YOLOv8n was trained on.
- **`dwell` needs person tracking**, which only exists on live camera sessions — dwell rules stay dormant on uploaded video by design.
- **Agent-guessed zones need calibrating** before you trust them. `zone_vacant` in particular fails loudly in both directions if the rectangle is wrong.
- **Normal conversation produces no audio events** by design; only elevated noise does. If your microphone runs quiet, lower `ELEVATED_RMS` in `audio_analyzer.py` — the backend logs the measured RMS and the gate values on every chunk, so you can pick a threshold from evidence.
- **The backend runs with `reload=False`** — restart it after editing Python.
- **Log lines must stay ASCII.** The process inherits its shell's stdout encoding, and on a latin-1 terminal a non-ASCII character in a `print()` raises inside the request handler and turns into a 500.
