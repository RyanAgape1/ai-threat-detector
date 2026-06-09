import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Dict, List, Optional
from uuid import uuid4

import reasoning
import recordings_db
from models import DetectionEvent, Activity

ACTIVITY_GAP_SECONDS = 8.0      # quiet window before closing
REASON_EVERY_N_EVENTS = 3       # trigger reasoning every N new events
REASON_INTERVAL_SECONDS = 5.0   # also trigger every 5 s while activity is active
CLEANUP_INTERVAL_SECONDS = 300  # run memory cleanup every 5 minutes
ACTIVITY_MAX_AGE_SECONDS = 3600 # evict closed activities older than 1 hour


class EvidenceBus:
    def __init__(self, broadcast_fn: Callable[[dict], Awaitable[None]]):
        self.activities: Dict[str, Activity] = {}
        self.broadcast = broadcast_fn

        # Per-activity asyncio locks — prevents concurrent reasoning on same activity
        self._locks: Dict[str, asyncio.Lock] = {}

        # Background reasoning tasks (periodic 5-second tick)
        self._reasoning_tasks: Dict[str, asyncio.Task] = {}

        # Delayed close handles
        self._close_timers: Dict[str, asyncio.TimerHandle] = {}

        # Events received since the last reasoning call
        self._event_counts_since_last_reason: Dict[str, int] = {}

        # Rolling buffer of representative frames per activity (last 4 base64 JPEGs)
        self._frames: Dict[str, List[str]] = {}

        self._cleanup_task: Optional[asyncio.Task] = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Start background tasks. Must be called after the event loop is running."""
        self._cleanup_task = asyncio.create_task(self._cleanup_loop())

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def ingest(self, event: DetectionEvent, frame_b64: Optional[str] = None) -> str:
        activity = self._find_active_activity()

        if activity is None:
            activity = self._create_activity()
            await self.broadcast({"type": "activity_opened", "activity": activity.model_dump()})

        activity_id = activity.id
        activity.events.append(event)
        self._event_counts_since_last_reason[activity_id] = (
            self._event_counts_since_last_reason.get(activity_id, 0) + 1
        )

        # Keep a rolling buffer of up to 4 frames for this activity
        if frame_b64 is not None:
            buf = self._frames.setdefault(activity_id, [])
            buf.append(frame_b64)
            if len(buf) > 4:
                buf.pop(0)

        msg: dict = {"type": "event_added", "activity_id": activity_id, "event": event.model_dump()}
        if frame_b64 is not None:
            msg["frame_b64"] = frame_b64
        await self.broadcast(msg)

        # Trigger reasoning if we hit the batch threshold
        if self._event_counts_since_last_reason[activity_id] >= REASON_EVERY_N_EVENTS:
            asyncio.create_task(self._trigger_reasoning(activity_id))

        # Reset the inactivity close timer
        self._reset_close_timer(activity_id)

        # Start the periodic reasoning tick if not already running
        if activity_id not in self._reasoning_tasks:
            self._reasoning_tasks[activity_id] = asyncio.create_task(
                self._periodic_reasoning_tick(activity_id)
            )

        return activity_id

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _find_active_activity(self) -> Optional[Activity]:
        now = time.time()
        for activity in self.activities.values():
            if activity.status != "active":
                continue
            if activity.events:
                last_ts = activity.events[-1].timestamp
                if now - last_ts < ACTIVITY_GAP_SECONDS:
                    return activity
        return None

    def _create_activity(self) -> Activity:
        activity_id = str(uuid4())
        activity = Activity(
            id=activity_id,
            started_at=time.time(),
            status="active",
        )
        self.activities[activity_id] = activity
        self._locks[activity_id] = asyncio.Lock()
        self._event_counts_since_last_reason[activity_id] = 0
        self._frames[activity_id] = []
        return activity

    def _reset_close_timer(self, activity_id: str) -> None:
        existing = self._close_timers.get(activity_id)
        if existing is not None:
            existing.cancel()

        loop = asyncio.get_event_loop()
        handle = loop.call_later(
            ACTIVITY_GAP_SECONDS,
            lambda: asyncio.create_task(self._close_activity(activity_id)),
        )
        self._close_timers[activity_id] = handle

    async def _trigger_reasoning(self, activity_id: str) -> None:
        activity = self.activities.get(activity_id)
        if activity is None or activity.status != "active":
            return

        lock = self._locks.get(activity_id)
        if lock is None:
            return

        if lock.locked():
            return

        async with lock:
            activity = self.activities.get(activity_id)
            if activity is None or activity.status != "active":
                return

            frames = list(self._frames.get(activity_id, []))
            try:
                explanation = await reasoning.explain_live(
                    activity.events, activity.latest_explanation, frames
                )
            except Exception as exc:
                print(f"[reasoning] explain_live failed for {activity_id}: {exc}")
                return

            activity.latest_explanation = explanation
            self._event_counts_since_last_reason[activity_id] = 0

            recordings_db.save_explanation(activity_id, explanation)

            await self.broadcast(
                {
                    "type": "reasoning_update",
                    "activity_id": activity_id,
                    "explanation": explanation.model_dump(),
                }
            )

    async def _periodic_reasoning_tick(self, activity_id: str) -> None:
        """Fire a reasoning update every REASON_INTERVAL_SECONDS while activity is active."""
        while True:
            await asyncio.sleep(REASON_INTERVAL_SECONDS)

            activity = self.activities.get(activity_id)
            if activity is None or activity.status != "active":
                break

            if activity.events and self._event_counts_since_last_reason.get(activity_id, 0) > 0:
                asyncio.create_task(self._trigger_reasoning(activity_id))

    async def _close_activity(self, activity_id: str) -> None:
        activity = self.activities.get(activity_id)
        if activity is None or activity.status != "active":
            return

        tick_task = self._reasoning_tasks.pop(activity_id, None)
        if tick_task is not None:
            tick_task.cancel()

        activity.status = "closed"
        activity.closed_at = time.time()

        frames = list(self._frames.get(activity_id, []))
        try:
            summary = await reasoning.explain_retrospective(activity.events, frames)
        except Exception as exc:
            print(f"[reasoning] explain_retrospective failed for {activity_id}: {exc}")
            summary = reasoning.fallback_explanation("Retrospective analysis unavailable.")
        activity.summary = summary

        recordings_db.save_activity(activity)

        await self.broadcast(
            {
                "type": "activity_closed",
                "activity_id": activity_id,
                "summary": summary.model_dump(),
            }
        )

        self._close_timers.pop(activity_id, None)
        self._event_counts_since_last_reason.pop(activity_id, None)
        self._locks.pop(activity_id, None)
        self._frames.pop(activity_id, None)

    # ------------------------------------------------------------------
    # Memory cleanup
    # ------------------------------------------------------------------

    async def _cleanup_loop(self) -> None:
        while True:
            await asyncio.sleep(CLEANUP_INTERVAL_SECONDS)
            await self._cleanup_old_activities()

    async def _cleanup_old_activities(self) -> None:
        """Remove closed activities older than ACTIVITY_MAX_AGE_SECONDS from memory.
        They are already persisted in the DB so nothing is lost."""
        now = time.time()
        to_remove = [
            aid for aid, activity in self.activities.items()
            if activity.status == "closed"
            and activity.closed_at is not None
            and now - activity.closed_at > ACTIVITY_MAX_AGE_SECONDS
        ]
        if not to_remove:
            return
        for aid in to_remove:
            self.activities.pop(aid, None)
        print(f"[cleanup] evicted {len(to_remove)} closed activities older than 1 hour from memory")
        remaining = [a.model_dump() for a in self.activities.values()]
        await self.broadcast({"type": "all_activities", "activities": remaining})
