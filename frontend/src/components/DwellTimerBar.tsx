import React from 'react';
import type { DwellTimer } from '../types';

interface Props {
  /** camera_id -> timers, straight from the WebSocket. */
  dwellTimers: Record<string, DwellTimer[]>;
  /** When set, only show timers for this camera session. */
  cameraFilter: string | null;
  /** sessionId -> friendly camera label. */
  cameraLabels: Record<string, string>;
}

/**
 * Always-visible strip of live dwell counters.
 *
 * These come from their own WebSocket message, not from detection events — a
 * per-frame event stream would trigger AI reasoning every couple of seconds and
 * prevent activities from ever closing. So this counts up continuously while the
 * durable events still fire only at their configured milestones.
 */
export const DwellTimerBar: React.FC<Props> = ({ dwellTimers, cameraFilter, cameraLabels }) => {
  const entries = Object.entries(dwellTimers).filter(
    ([camId]) => !cameraFilter || camId === cameraFilter,
  );
  const flat = entries.flatMap(([camId, timers]) =>
    timers.map((t) => ({ ...t, camId })),
  );

  if (flat.length === 0) return null;

  const multiCamera = entries.length > 1;

  return (
    <div className="shrink-0 border-b border-dash-border bg-amber-950/20 px-4 py-2">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="font-mono text-[9px] font-semibold tracking-widest text-amber-600/80 uppercase">
          Live Timers
        </span>
        <div className="flex-1 h-px bg-amber-900/30" />
        <span className="font-mono text-[9px] text-amber-700">
          {flat.length} being timed
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        {flat.map((t) => {
          const pct = t.min_seconds > 0
            ? Math.min(100, (t.elapsed_seconds / t.min_seconds) * 100)
            : 100;
          const reached = t.fired_count > 0;

          return (
            <div
              key={`${t.camId}:${t.event_type}:${t.identity}`}
              className={`rounded border px-2.5 py-1.5 min-w-[168px] transition-colors
                ${reached
                  ? 'border-amber-600/60 bg-amber-500/10'
                  : 'border-dash-border bg-dash-panel'}`}
            >
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className="text-[10px]">⏱</span>
                <span className="font-mono text-[9px] text-gray-500 truncate flex-1">
                  {t.label}
                </span>
                {t.out_of_sight && (
                  <span
                    className="font-mono text-[8px] text-yellow-600"
                    title="Out of sight — the timer keeps running until the grace period expires"
                  >
                    ◌
                  </span>
                )}
              </div>

              {/* The counter itself */}
              <div className="flex items-baseline gap-1.5">
                <span
                  className={`font-mono text-base font-bold tabular-nums leading-none
                    ${reached ? 'text-amber-300' : 'text-gray-300'}`}
                >
                  {t.elapsed_human}
                </span>
                {!reached && (
                  <span className="font-mono text-[9px] text-gray-600">
                    / {formatTarget(t.min_seconds)}
                  </span>
                )}
                {reached && (
                  <span className="font-mono text-[9px] text-amber-600">
                    ×{t.fired_count}
                  </span>
                )}
              </div>

              {/* Progress toward the milestone */}
              <div className="h-0.5 bg-gray-800 rounded-full overflow-hidden mt-1">
                <div
                  className={`h-full rounded-full transition-all duration-1000 ease-linear
                    ${reached ? 'bg-amber-500' : 'bg-gray-600'}`}
                  style={{ width: `${pct}%` }}
                />
              </div>

              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="font-mono text-[8px] text-gray-700">
                  {t.global_person_id
                    ? `person ${t.global_person_id.slice(0, 6)}`
                    : `track #${t.track_id ?? '?'}`}
                </span>
                {multiCamera && (
                  <span className="font-mono text-[8px] text-violet-700 truncate">
                    {cameraLabels[t.camId] ?? t.camId.slice(0, 6)}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

function formatTarget(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `${hrs}h ${rem}m` : `${hrs}h`;
}
