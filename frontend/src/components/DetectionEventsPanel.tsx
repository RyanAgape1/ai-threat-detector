import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ContextAnalysis,
  CustomEventDef,
  DesignResult,
  DetectionEventsState,
  Zone,
} from '../types';
import type { CameraSession } from '../hooks/useCamera';

const API = 'http://localhost:8000';

const KIND_LABELS: Record<string, string> = {
  dwell: 'Timer',
  zone_count: 'Occupancy',
  zone_vacant: 'Vacancy',
  object_present: 'Object',
  proximity: 'Proximity',
  event_rate: 'Frequency',
};

const IMPORTANCE_CLASSES: Record<string, string> = {
  important: 'bg-red-500/10 text-red-400 border-red-500/25',
  notable: 'bg-amber-500/10 text-amber-400 border-amber-500/25',
  routine: 'bg-gray-700/30 text-gray-500 border-gray-600/30',
};

/** Params worth surfacing without expanding, per kind. */
function summarizeParams(ev: CustomEventDef): string {
  const p = ev.params as Record<string, unknown>;
  const secs = (v: unknown) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n >= 60 ? `${Math.round(n / 60)}m` : `${Math.round(n)}s`;
  };
  switch (ev.kind) {
    case 'dwell': {
      const parts = [`after ${secs(p.min_seconds) ?? '?'}`];
      const rep = secs(p.repeat_seconds);
      if (rep) parts.push(`repeat ${rep}`);
      parts.push(p.mode === 'zone' ? 'in zone' : 'stationary');
      return parts.join(' · ');
    }
    case 'zone_count': {
      const parts = [`${p.target} ≥ ${p.min_count}`];
      const sus = secs(p.sustained_seconds);
      if (sus) parts.push(`held ${sus}`);
      return parts.join(' · ');
    }
    case 'zone_vacant':
      return `no ${p.target} for ${secs(p.min_seconds) ?? '?'}`;
    case 'object_present':
      return `${(p.object_classes as string[] | undefined)?.join(', ') ?? '?'} · conf ≥ ${p.min_confidence}`;
    case 'proximity':
      return `${p.target} near ${p.near} · ${secs(p.min_seconds) ?? '0s'}`;
    case 'event_rate':
      return `${(p.event_types as string[] | undefined)?.join(', ') ?? '?'} ×${p.min_count} in ${secs(p.window_seconds) ?? '?'}`;
    default:
      return '';
  }
}

interface Props {
  envType: string;
  concerns: string;
  context: string;
  /** Called after the designer writes config, so the panels above can refresh. */
  onConfigChanged?: () => void | Promise<void>;
  /** Live camera sessions — zone calibration draws over the real camera view. */
  cameraSessions?: CameraSession[];
}

export const DetectionEventsPanel: React.FC<Props> = ({
  envType, concerns, context, onConfigChanged, cameraSessions = [],
}) => {
  const [state, setState] = useState<DetectionEventsState | null>(null);
  const [analysis, setAnalysis] = useState<ContextAnalysis | null>(null);
  const [explanation, setExplanation] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${API}/detection-events`);
      if (res.ok) setState(await res.json() as DetectionEventsState);
    } catch {
      // backend may not be running yet
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const hasContext = concerns.trim().length > 0 || context.trim().length > 0;

  const handleAnalyze = async () => {
    setAnalyzing(true);
    setError('');
    setExplanation('');
    setErrors([]);
    try {
      const res = await fetch(`${API}/detection-events/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ env_type: envType, concerns, context }),
      });
      if (!res.ok) throw new Error(await res.text());
      setAnalysis(await res.json() as ContextAnalysis);
    } catch (e) {
      setError(String(e));
    } finally {
      setAnalyzing(false);
    }
  };

  const handleApply = async () => {
    setApplying(true);
    setError('');
    try {
      const res = await fetch(`${API}/detection-events/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ env_type: envType, concerns, context, analysis }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json() as DesignResult;
      setAnalysis(data.analysis);
      setExplanation(data.explanation);
      setErrors(data.errors ?? []);
      await refresh();
      // The designer can also change which built-ins are suppressed, which the
      // config panels above render — keep them in sync.
      await onConfigChanged?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setApplying(false);
    }
  };

  const toggleEvent = async (ev: CustomEventDef) => {
    try {
      await fetch(`${API}/detection-events/${ev.event_type}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !ev.enabled }),
      });
      await refresh();
    } catch {
      setError('Could not reach backend');
    }
  };

  const updateParams = async (ev: CustomEventDef, params: Record<string, number>) => {
    try {
      const res = await fetch(`${API}/detection-events/${ev.event_type}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ params }),
      });
      if (!res.ok) setError(await res.text());
      await refresh();
    } catch {
      setError('Could not reach backend');
    }
  };

  const removeEvent = async (ev: CustomEventDef) => {
    try {
      await fetch(`${API}/detection-events/${ev.event_type}`, { method: 'DELETE' });
      await refresh();
    } catch {
      setError('Could not reach backend');
    }
  };

  const installed = state?.custom_events ?? [];
  const zones = state?.zones ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="font-mono text-xs font-semibold text-gray-300 tracking-widest uppercase">
          Detection Events
        </h2>
        <span className="px-2 py-0.5 bg-amber-500/15 text-amber-300 text-xs rounded font-mono border border-amber-500/20">
          {installed.length} custom
        </span>
      </div>

      <p className="text-xs text-gray-500 leading-relaxed">
        A second pair of agents reads your concerns and context to decide whether this deployment
        needs different detection events — then builds them. The environment agent above only tunes
        thresholds; these agents change <em>what</em> gets detected.
      </p>

      {/* ── Stage 1 / 2 controls ── */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => void handleAnalyze()}
          disabled={analyzing || applying || !hasContext}
          className="px-3 py-1.5 bg-dash-panel border border-amber-600/50 text-amber-300 text-xs font-semibold rounded
            hover:bg-amber-500/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {analyzing ? 'Analyzing...' : '1 · Analyze context'}
        </button>
        <button
          onClick={() => void handleApply()}
          disabled={applying || analyzing || !hasContext}
          className="px-3 py-1.5 bg-amber-600 text-white text-xs font-semibold rounded
            hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {applying ? 'Designing...' : analysis ? '2 · Build these events' : '2 · Design & install'}
        </button>
      </div>

      {!hasContext && (
        <p className="text-xs text-gray-600 italic">
          Fill in “primary security concerns” or “additional context” on the left — these agents work
          from what you write there.
        </p>
      )}

      {(analyzing || applying) && (
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full border-2 border-amber-400 border-t-transparent animate-spin shrink-0" />
          <p className="text-xs text-gray-500">
            {analyzing ? 'Reading your context' : 'Designing detection events'} — the local model
            takes a minute or two.
          </p>
        </div>
      )}

      {error && <p className="text-xs text-red-400 break-all">{error}</p>}

      {/* ── Analyst findings ── */}
      {analysis && (
        <div className="bg-dash-panel border border-dash-border rounded p-3 space-y-3">
          <div className="flex items-center gap-2">
            <p className="text-xs text-gray-400 font-semibold uppercase tracking-wider">
              Analyst reading
            </p>
            <span className={`text-xs px-1.5 py-0.5 rounded border font-mono ${
              analysis.requires_changes
                ? 'bg-amber-500/10 text-amber-400 border-amber-500/25'
                : 'bg-green-500/10 text-green-400 border-green-500/25'
            }`}>
              {analysis.requires_changes ? 'changes recommended' : 'built-ins sufficient'}
            </span>
          </div>

          {analysis.context_understood && (
            <p className="text-xs text-gray-300 leading-relaxed">{analysis.context_understood}</p>
          )}

          {analysis.needed_events.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs text-gray-500 uppercase tracking-wider">Proposed events</p>
              {analysis.needed_events.map((ne, i) => (
                <div key={i} className="border-l-2 border-amber-600/50 pl-2.5 py-0.5">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs text-gray-200">{ne.purpose}</span>
                    <span className="text-xs font-mono text-amber-500/80">
                      {KIND_LABELS[ne.suggested_kind] ?? ne.suggested_kind}
                    </span>
                    {ne.needs_zone && (
                      <span className="text-xs px-1 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">
                        needs zone
                      </span>
                    )}
                  </div>
                  {ne.rationale && (
                    <p className="text-xs text-gray-500 italic mt-0.5">“{ne.rationale}”</p>
                  )}
                </div>
              ))}
            </div>
          )}

          {analysis.builtin_changes.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-gray-500 uppercase tracking-wider">Built-in events</p>
              {analysis.builtin_changes.map((bc, i) => (
                <div key={i} className="flex items-start gap-1.5">
                  <span className={`text-xs font-mono px-1 rounded shrink-0 ${
                    bc.action === 'disable'
                      ? 'bg-red-500/10 text-red-400'
                      : 'bg-green-500/10 text-green-400'
                  }`}>
                    {bc.action}
                  </span>
                  <span className="text-xs font-mono text-gray-300">{bc.event_type}</span>
                  <span className="text-xs text-gray-500">— {bc.reason}</span>
                </div>
              ))}
            </div>
          )}

          {analysis.unsupported_requests.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-gray-500 uppercase tracking-wider">Cannot be detected</p>
              {analysis.unsupported_requests.map((u, i) => (
                <p key={i} className="text-xs text-gray-500">· {u}</p>
              ))}
            </div>
          )}
        </div>
      )}

      {explanation && (
        <div className="bg-dash-panel border border-amber-700/30 rounded p-3">
          <p className="text-xs text-gray-400 mb-1.5 font-semibold uppercase tracking-wider">
            Designer explanation
          </p>
          <p className="text-xs text-gray-300 leading-relaxed whitespace-pre-wrap">{explanation}</p>
        </div>
      )}

      {errors.length > 0 && (
        <div className="bg-red-500/5 border border-red-500/20 rounded p-3 space-y-1">
          <p className="text-xs text-red-400 font-semibold uppercase tracking-wider">
            Rejected by validation
          </p>
          {errors.map((e, i) => (
            <p key={i} className="text-xs text-gray-400 font-mono break-all">· {e}</p>
          ))}
        </div>
      )}

      {/* ── Installed custom events ── */}
      {installed.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Installed</p>
          {installed.map((ev) => (
            <EventCard
              key={ev.event_type}
              event={ev}
              suppressed={(state?.effective_disabled_events ?? []).includes(ev.event_type)}
              onToggle={() => void toggleEvent(ev)}
              onDelete={() => void removeEvent(ev)}
              onUpdateParams={(p) => void updateParams(ev, p)}
            />
          ))}
        </div>
      )}

      {/* ── Zones ── */}
      {zones.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Zones</p>
          {zones.map((z) => (
            <ZoneRow
              key={z.name}
              zone={z}
              onSaved={refresh}
              cameraSessions={cameraSessions}
            />
          ))}
        </div>
      )}
    </div>
  );
};

/* ── Installed event card ─────────────────────────────────────────────────── */

/** Numeric params worth exposing as tuning controls, in display order. */
const TUNABLE: Record<string, string> = {
  min_seconds: 'Fires after (s)',
  repeat_seconds: 'Repeat every (s)',
  max_drift: 'Movement allowance',
  min_count: 'Minimum count',
  sustained_seconds: 'Sustained for (s)',
  cooldown_seconds: 'Cooldown (s)',
  min_confidence: 'Min confidence',
  max_distance_ratio: 'Max distance',
  window_seconds: 'Window (s)',
};

const EventCard: React.FC<{
  event: CustomEventDef;
  suppressed: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onUpdateParams: (params: Record<string, number>) => void;
}> = ({ event, suppressed, onToggle, onDelete, onUpdateParams }) => {
  const [showRaw, setShowRaw] = useState(false);
  const [tuning, setTuning] = useState(false);
  const [draft, setDraft] = useState<Record<string, number>>({});
  const dim = !event.enabled || suppressed;

  const tunableKeys = Object.keys(TUNABLE).filter(
    (k) => typeof (event.params as Record<string, unknown>)[k] === 'number',
  );

  const startTuning = () => {
    const initial: Record<string, number> = {};
    tunableKeys.forEach((k) => { initial[k] = Number((event.params as Record<string, unknown>)[k]); });
    setDraft(initial);
    setTuning(true);
  };

  return (
    <div className={`rounded border p-3 transition-opacity ${
      dim ? 'border-dash-border bg-dash-panel opacity-50' : 'border-amber-700/30 bg-amber-500/5'
    }`}>
      <div className="flex items-center gap-2 flex-wrap mb-1">
        <span className="text-xs font-semibold text-gray-200">{event.label}</span>
        <code className="text-xs font-mono text-amber-500/80">{event.event_type}</code>
        <span className="text-xs px-1.5 py-0.5 rounded bg-gray-700/40 text-gray-400 border border-gray-600/30 font-mono">
          {KIND_LABELS[event.kind] ?? event.kind}
        </span>
        <span className={`text-xs px-1.5 py-0.5 rounded border font-mono ${
          IMPORTANCE_CLASSES[event.importance] ?? IMPORTANCE_CLASSES.notable
        }`}>
          {event.importance}
        </span>
        {event.zone && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20 font-mono">
            zone: {event.zone}
          </span>
        )}
        {suppressed && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/20">
            suppressed by a time rule
          </span>
        )}

        <div className="flex-1" />
        <button
          onClick={onToggle}
          className="text-xs font-mono text-gray-500 hover:text-gray-300 transition-colors"
          title={event.enabled ? 'Disable this event' : 'Enable this event'}
        >
          {event.enabled ? 'disable' : 'enable'}
        </button>
        <button
          onClick={onDelete}
          className="text-xs font-mono text-gray-600 hover:text-red-400 transition-colors"
          title="Delete this event"
        >
          ✕
        </button>
      </div>

      <p className="text-xs text-gray-400 leading-relaxed">{event.description}</p>

      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
        <span className="text-xs font-mono text-gray-500">{summarizeParams(event)}</span>
        {tunableKeys.length > 0 && (
          <button
            onClick={() => (tuning ? setTuning(false) : startTuning())}
            className="text-xs font-mono text-amber-600 hover:text-amber-400 transition-colors"
          >
            {tuning ? 'cancel' : 'tune'}
          </button>
        )}
        <button
          onClick={() => setShowRaw((v) => !v)}
          className="text-xs font-mono text-gray-600 hover:text-gray-400 transition-colors"
        >
          {showRaw ? '− params' : '+ params'}
        </button>
      </div>

      {tuning && (
        <div className="mt-2 bg-dash-bg border border-dash-border rounded p-2 space-y-2">
          <div className="flex flex-wrap gap-x-3 gap-y-2">
            {tunableKeys.map((k) => (
              <label key={k} className="flex items-center gap-1.5">
                <span className="text-xs text-gray-500">{TUNABLE[k]}</span>
                <input
                  type="number"
                  step="any"
                  value={draft[k] ?? 0}
                  onChange={(e) => setDraft((p) => ({ ...p, [k]: Number(e.target.value) }))}
                  className="w-20 bg-dash-panel border border-dash-border rounded px-1.5 py-0.5
                    text-xs text-gray-200 font-mono focus:outline-none focus:border-amber-500"
                />
              </label>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { onUpdateParams(draft); setTuning(false); }}
              className="px-2 py-0.5 bg-amber-600 text-white text-xs rounded hover:bg-amber-500 transition-colors"
            >
              save
            </button>
            <span className="text-xs text-gray-600">
              Values are clamped to safe bounds. Lower “fires after” to test quickly.
            </span>
          </div>
        </div>
      )}

      {showRaw && (
        <pre className="mt-2 text-xs font-mono text-gray-500 bg-dash-bg border border-dash-border rounded p-2 overflow-x-auto">
          {JSON.stringify(event.params, null, 2)}
        </pre>
      )}
    </div>
  );
};

/* ── Zone calibration row ────────────────────────────────────────────────── */

/** Zone rectangle, as fractions of the frame. */
type Rect = { x: number; y: number; w: number; h: number };

/** Which part of the rectangle a pointer drag is moving. */
type DragMode = 'move' | 'nw' | 'ne' | 'sw' | 'se';

/** Smallest zone a drag may produce. The backend floor is 0.01; staying above
 *  it keeps the handles from overlapping into an ungrabbable knot. */
const MIN_SIZE = 0.03;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Match the backend, which rounds to 4dp in normalize_zone. */
const round4 = (v: number) => Math.round(v * 10000) / 10000;

/**
 * Apply a pointer drag to the rectangle it started from.
 *
 * dx/dy are already expressed as fractions of the frame, and the original rect
 * is the one captured at pointer-down — deriving from that rather than from the
 * live value means a drag cannot accumulate rounding error frame by frame.
 */
function applyDrag(orig: Rect, mode: DragMode, dx: number, dy: number): Rect {
  if (mode === 'move') {
    // Moving preserves size: the offset is bounded so the box stays in frame
    // instead of being clipped at the edge.
    return {
      x: Math.max(0, Math.min(orig.x + dx, 1 - orig.w)),
      y: Math.max(0, Math.min(orig.y + dy, 1 - orig.h)),
      w: orig.w,
      h: orig.h,
    };
  }

  const right = orig.x + orig.w;
  const bottom = orig.y + orig.h;
  const next = { ...orig };

  if (mode === 'nw' || mode === 'sw') {
    // Dragging a left handle moves the left edge; the right edge is anchored.
    next.x = Math.max(0, Math.min(orig.x + dx, right - MIN_SIZE));
    next.w = right - next.x;
  } else {
    next.w = Math.max(MIN_SIZE, Math.min(orig.w + dx, 1 - orig.x));
  }

  if (mode === 'nw' || mode === 'ne') {
    next.y = Math.max(0, Math.min(orig.y + dy, bottom - MIN_SIZE));
    next.h = bottom - next.y;
  } else {
    next.h = Math.max(MIN_SIZE, Math.min(orig.h + dy, 1 - orig.y));
  }

  return next;
}

const HANDLES: { mode: DragMode; className: string; cursor: string }[] = [
  { mode: 'nw', className: '-top-1.5 -left-1.5', cursor: 'nwse-resize' },
  { mode: 'ne', className: '-top-1.5 -right-1.5', cursor: 'nesw-resize' },
  { mode: 'sw', className: '-bottom-1.5 -left-1.5', cursor: 'nesw-resize' },
  { mode: 'se', className: '-bottom-1.5 -right-1.5', cursor: 'nwse-resize' },
];

/**
 * The camera view with the zone drawn over it, draggable and resizable.
 *
 * Zone coordinates are fractions of the *frame*, so the preview must show the
 * whole frame at its true aspect ratio — a letterboxed or cropped view would
 * put the rectangle somewhere the engine doesn't agree with. The aspect is read
 * off the stream rather than assumed to be 16:9.
 */
const ZonePreview: React.FC<{
  stream: MediaStream | null;
  vals: Rect;
  onChange: (r: Rect) => void;
  label: string;
}> = ({ stream, vals, onChange, label }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [aspect, setAspect] = useState(16 / 9);

  // The stream is already playing in the log tab; a second <video> is just
  // another consumer of it, and needs muting to autoplay.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) return;
    video.srcObject = stream;
    void video.play().catch(() => {});
    return () => { video.srcObject = null; };
  }, [stream]);

  const drag = useRef<{ mode: DragMode; px: number; py: number; box: DOMRect; orig: Rect } | null>(null);

  const startDrag = (mode: DragMode) => (e: React.PointerEvent) => {
    const box = frameRef.current?.getBoundingClientRect();
    if (!box) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { mode, px: e.clientX, py: e.clientY, box, orig: { ...vals } };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const next = applyDrag(
      d.orig,
      d.mode,
      (e.clientX - d.px) / d.box.width,
      (e.clientY - d.py) / d.box.height,
    );
    onChange({ x: round4(next.x), y: round4(next.y), w: round4(next.w), h: round4(next.h) });
  };

  const endDrag = (e: React.PointerEvent) => {
    if (drag.current) (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    drag.current = null;
  };

  return (
    <div
      ref={frameRef}
      className="relative w-full max-w-md bg-dash-bg border border-dash-border rounded overflow-hidden select-none"
      style={{ aspectRatio: String(aspect) }}
    >
      {stream ? (
        <video
          ref={videoRef}
          muted
          playsInline
          autoPlay
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            if (v.videoWidth && v.videoHeight) setAspect(v.videoWidth / v.videoHeight);
          }}
          className="absolute inset-0 w-full h-full object-cover"
        />
      ) : (
        <p className="absolute inset-0 flex items-center justify-center text-xs text-gray-600 text-center px-4">
          Start a camera to calibrate against the live view
        </p>
      )}

      {/* The zone. The huge spread shadow dims everything outside it, which is
          what makes an off-target box obvious at a glance. */}
      <div
        onPointerDown={startDrag('move')}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="absolute border-2 border-blue-400 bg-blue-400/10 cursor-move touch-none"
        style={{
          left: `${clamp01(vals.x) * 100}%`,
          top: `${clamp01(vals.y) * 100}%`,
          width: `${clamp01(vals.w) * 100}%`,
          height: `${clamp01(vals.h) * 100}%`,
          boxShadow: '0 0 0 9999px rgba(0,0,0,0.5)',
        }}
      >
        <span className="absolute -top-0.5 left-0 -translate-y-full text-xs font-mono text-blue-300 bg-dash-bg/80 px-1 rounded-t whitespace-nowrap">
          {label}
        </span>
        {HANDLES.map((handle) => (
          <div
            key={handle.mode}
            onPointerDown={startDrag(handle.mode)}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            style={{ cursor: handle.cursor }}
            className={`absolute w-3 h-3 bg-blue-400 border border-dash-bg rounded-sm touch-none ${handle.className}`}
          />
        ))}
      </div>
    </div>
  );
};

const ZoneRow: React.FC<{
  zone: Zone;
  onSaved: () => Promise<void>;
  cameraSessions?: CameraSession[];
}> = ({ zone, onSaved, cameraSessions = [] }) => {
  const [edit, setEdit] = useState(false);
  const [vals, setVals] = useState({ x: zone.x, y: zone.y, w: zone.w, h: zone.h });
  const [saving, setSaving] = useState(false);
  const [previewSession, setPreviewSession] = useState('');

  // Zones are global, so with several cameras running the operator picks which
  // view to calibrate against.
  const activeSession =
    cameraSessions.find((s) => s.sessionId === previewSession) ?? cameraSessions[0] ?? null;

  // Re-sync when the underlying zone changes (e.g. the agent re-ran)
  useEffect(() => {
    setVals({ x: zone.x, y: zone.y, w: zone.w, h: zone.h });
  }, [zone.x, zone.y, zone.w, zone.h]);

  const save = async () => {
    setSaving(true);
    try {
      await fetch(`${API}/detection-events/zones/${zone.name}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(vals),
      });
      await onSaved();
      setEdit(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded border border-dash-border bg-dash-panel p-3">
      <div className="flex items-center gap-2 flex-wrap mb-1">
        <code className="text-xs font-mono text-blue-300">{zone.name}</code>
        {zone.needs_calibration && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-500/10 text-yellow-400 border border-yellow-500/25">
            needs calibration
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={() => setEdit((v) => !v)}
          className="text-xs font-mono text-gray-500 hover:text-gray-300 transition-colors"
        >
          {edit ? 'cancel' : 'adjust'}
        </button>
      </div>

      {zone.description && <p className="text-xs text-gray-500 mb-1">{zone.description}</p>}

      {!edit ? (
        <p className="text-xs font-mono text-gray-500">
          x {zone.x} · y {zone.y} · w {zone.w} · h {zone.h}
          <span className="text-gray-700"> (fractions of the frame, 0,0 = top-left)</span>
        </p>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            {(['x', 'y', 'w', 'h'] as const).map((k) => (
              <label key={k} className="flex items-center gap-1">
                <span className="text-xs font-mono text-gray-500">{k}</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="1"
                  value={vals[k]}
                  onChange={(e) => setVals((p) => ({ ...p, [k]: Number(e.target.value) }))}
                  className="w-16 bg-dash-bg border border-dash-border rounded px-1.5 py-0.5 text-xs
                    text-gray-200 font-mono focus:outline-none focus:border-blue-500"
                />
              </label>
            ))}
            <button
              onClick={() => void save()}
              disabled={saving}
              className="px-2 py-0.5 bg-blue-600 text-white text-xs rounded hover:bg-blue-500
                disabled:opacity-40 transition-colors"
            >
              {saving ? '...' : 'save'}
            </button>
          </div>
          {cameraSessions.length > 1 && (
            <label className="flex items-center gap-1.5">
              <span className="text-xs text-gray-500">Preview camera</span>
              <select
                value={activeSession?.sessionId ?? ''}
                onChange={(e) => setPreviewSession(e.target.value)}
                className="bg-dash-bg border border-dash-border rounded px-1.5 py-0.5 text-xs
                  text-gray-200 font-mono focus:outline-none focus:border-blue-500"
              >
                {cameraSessions.map((s) => (
                  <option key={s.sessionId} value={s.sessionId}>{s.label}</option>
                ))}
              </select>
            </label>
          )}

          <ZonePreview
            stream={activeSession?.stream ?? null}
            vals={vals}
            onChange={setVals}
            label={zone.name}
          />

          <p className="text-xs text-gray-600">
            {activeSession
              ? 'Drag the box to move it, corners to resize. The numbers above follow along — nothing is saved until you press save.'
              : 'No camera running. Start one from the log tab to position this against the real view.'}
          </p>
        </div>
      )}
    </div>
  );
};
