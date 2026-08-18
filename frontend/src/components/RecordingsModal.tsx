import React, { useEffect, useRef, useState } from 'react';
import type { Recording, StoredActivity, StoredExplanation, StoredEvent } from '../hooks/useRecordings';

interface RecordingsModalProps {
  open: boolean;
  onClose: () => void;
  recordings: Recording[];
  loading: boolean;
  onRefresh: () => void;
  onDelete: (id: string) => Promise<void>;
  getVideoUrl: (id: string) => string;
  fetchActivities: (recordingId: string) => Promise<StoredActivity[]>;
}

function fmtDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtDate(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString();
}

function fmtSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const THREAT_COLORS: Record<string, string> = {
  critical: 'text-red-400 bg-red-900/40 border-red-800/50',
  high: 'text-orange-400 bg-orange-900/40 border-orange-800/50',
  medium: 'text-yellow-400 bg-yellow-900/40 border-yellow-800/50',
  low: 'text-blue-400 bg-blue-900/40 border-blue-800/50',
};

const SOURCE_COLORS: Record<string, string> = {
  cv: 'text-purple-400 bg-purple-900/30',
  audio: 'text-teal-400 bg-teal-900/30',
  behavior: 'text-blue-400 bg-blue-900/30',
  custom: 'text-amber-400 bg-amber-900/30',
};

const SOURCE_LABELS: Record<string, string> = {
  cv: 'CV',
  audio: 'AUD',
  behavior: 'BEH',
  custom: 'RULE',
};

export const RecordingsModal: React.FC<RecordingsModalProps> = ({
  open, onClose, recordings, loading, onRefresh, onDelete, getVideoUrl, fetchActivities,
}) => {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [activities, setActivities] = useState<StoredActivity[]>([]);
  const [activitiesLoading, setActivitiesLoading] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (open) onRefresh();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Clear selection if selected recording was deleted
  useEffect(() => {
    if (selectedId && !recordings.find((r) => r.id === selectedId)) {
      setSelectedId(null);
      setActivities([]);
    }
  }, [recordings, selectedId]);

  // Load activities when selection changes
  useEffect(() => {
    if (!selectedId) {
      setActivities([]);
      return;
    }
    setActivitiesLoading(true);
    fetchActivities(selectedId).then((acts) => {
      setActivities(acts);
      setActivitiesLoading(false);
    });
  }, [selectedId, fetchActivities]);

  if (!open) return null;

  const selected = recordings.find((r) => r.id === selectedId) ?? null;

  const handleDelete = async (id: string) => {
    setDeleting(id);
    await onDelete(id);
    setDeleting(null);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={onClose}
    >
      <div
        className="w-[1100px] max-w-[96vw] h-[680px] max-h-[94vh] bg-dash-panel border border-dash-border rounded-lg flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-dash-border shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-2 h-6 bg-violet-500 rounded-sm opacity-80" />
            <span className="font-mono text-sm font-bold tracking-[0.18em] text-gray-100 uppercase">
              Recordings
            </span>
            {loading && (
              <div className="w-3 h-3 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />
            )}
            <span className="font-mono text-[10px] text-gray-600">
              {recordings.length} {recordings.length === 1 ? 'session' : 'sessions'}
            </span>
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={onRefresh}
              className="font-mono text-[10px] text-gray-500 hover:text-gray-300 tracking-widest uppercase transition-colors"
            >
              ↻ Refresh
            </button>
            <button
              onClick={onClose}
              className="font-mono text-[10px] text-gray-500 hover:text-gray-300 tracking-widest uppercase transition-colors"
            >
              ✕ Close
            </button>
          </div>
        </div>

        {/* Body: 3-column layout */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left: recording list */}
          <div className="w-64 shrink-0 border-r border-dash-border overflow-y-auto">
            {recordings.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-3 px-6 text-center">
                <div className="text-3xl opacity-20">📹</div>
                <p className="font-mono text-xs text-gray-600 leading-relaxed">
                  {loading ? 'Loading...' : 'No recordings yet.\nStart a camera session to begin recording.'}
                </p>
              </div>
            ) : (
              <div className="p-2 space-y-1.5">
                {recordings.map((rec) => (
                  <div
                    key={rec.id}
                    onClick={() => setSelectedId(rec.id)}
                    className={`rounded border p-3 cursor-pointer transition-colors duration-150 ${
                      selectedId === rec.id
                        ? 'border-violet-600 bg-violet-900/20'
                        : 'border-dash-border bg-dash-card hover:border-dash-border-bright'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2 mb-1.5">
                      <span className="font-mono text-[10px] text-gray-300 leading-snug">
                        {fmtDate(rec.started_at)}
                      </span>
                      <button
                        onClick={(e) => { e.stopPropagation(); void handleDelete(rec.id); }}
                        disabled={deleting === rec.id}
                        className="font-mono text-[10px] text-red-500 hover:text-red-300 hover:bg-red-900/30 px-1.5 py-0.5 rounded transition-colors shrink-0 disabled:opacity-40"
                        title="Delete recording"
                      >
                        {deleting === rec.id ? '…' : '✕'}
                      </button>
                    </div>
                    <div className="flex items-center gap-2 font-mono text-[9px] text-gray-600 flex-wrap">
                      <span>{fmtDuration(rec.duration_seconds)}</span>
                      <span>·</span>
                      <span>{fmtSize(rec.filesize_bytes)}</span>
                      <span>·</span>
                      <span>{rec.frame_count} fr</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Center: video player */}
          <div className="w-[380px] shrink-0 border-r border-dash-border flex flex-col bg-black overflow-hidden">
            {selected ? (
              <>
                <div className="shrink-0 flex items-center gap-2 px-4 py-1.5 bg-dash-panel border-b border-dash-border">
                  <div className="w-1.5 h-1.5 rounded-full bg-violet-500" />
                  <span className="font-mono text-[9px] font-semibold tracking-widest text-gray-500 uppercase flex-1 truncate">
                    {fmtDate(selected.started_at)}
                  </span>
                  <button
                    onClick={() => void handleDelete(selected.id)}
                    disabled={deleting === selected.id}
                    className="font-mono text-[10px] text-red-500 hover:text-red-300 hover:bg-red-900/30 px-2 py-0.5 rounded border border-red-800/50 transition-colors disabled:opacity-40 ml-2 shrink-0"
                  >
                    {deleting === selected.id ? 'Deleting…' : 'Delete'}
                  </button>
                </div>
                <video
                  ref={videoRef}
                  key={selected.id}
                  src={getVideoUrl(selected.id)}
                  controls
                  className="w-full flex-1 object-contain bg-black"
                />
                <div className="shrink-0 flex items-center gap-3 px-4 py-1.5 bg-dash-panel border-t border-dash-border font-mono text-[9px] text-gray-600">
                  <span>{fmtDuration(selected.duration_seconds)}</span>
                  <span>·</span>
                  <span>{fmtSize(selected.filesize_bytes)}</span>
                  <span>·</span>
                  <span>{selected.frame_count} frames</span>
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center justify-center h-full gap-3">
                <div className="text-4xl opacity-20">⬅</div>
                <p className="font-mono text-xs text-gray-600 tracking-wider">
                  Select a recording to play
                </p>
              </div>
            )}
          </div>

          {/* Right: activities + events + explanations */}
          <div className="flex-1 flex flex-col overflow-hidden bg-dash-bg">
            <div className="shrink-0 px-4 py-2 border-b border-dash-border bg-dash-panel flex items-center gap-2">
              <span className="font-mono text-[10px] font-semibold tracking-widest text-gray-500 uppercase">
                Activities
              </span>
              {activitiesLoading && (
                <div className="w-3 h-3 rounded-full border-2 border-violet-400 border-t-transparent animate-spin" />
              )}
              {!activitiesLoading && selected && (
                <span className="font-mono text-[10px] text-gray-700">
                  {activities.length} {activities.length === 1 ? 'activity' : 'activities'}
                </span>
              )}
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              {!selected ? (
                <div className="flex items-center justify-center h-full">
                  <p className="font-mono text-xs text-gray-700">Select a recording</p>
                </div>
              ) : activitiesLoading ? (
                <div className="flex items-center justify-center h-full">
                  <p className="font-mono text-xs text-gray-600">Loading activities…</p>
                </div>
              ) : activities.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full gap-2">
                  <p className="font-mono text-xs text-gray-700">No saved activities for this recording</p>
                  <p className="font-mono text-[10px] text-gray-800 text-center leading-relaxed max-w-48">
                    Activities are saved when they close. Older recordings may not have data yet.
                  </p>
                </div>
              ) : (
                activities.map((act) => (
                  <ActivityCard key={act.id} activity={act} videoRef={videoRef} recordingStartedAt={selected.started_at} />
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

/* ── Activity card ────────────────────────────────────────────────────────── */

const ActivityCard: React.FC<{
  activity: StoredActivity;
  videoRef: React.RefObject<HTMLVideoElement>;
  recordingStartedAt: number;
}> = ({ activity, videoRef, recordingStartedAt }) => {
  const [expanded, setExpanded] = useState(true);
  const [showEvents, setShowEvents] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const summary = activity.summary;
  const threatClass = summary ? (THREAT_COLORS[summary.threat_level] ?? THREAT_COLORS.low) : '';

  return (
    <div className="rounded border border-dash-border bg-dash-card overflow-hidden">
      {/* Activity header */}
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-dash-card-hover transition-colors"
        onClick={() => setExpanded((e) => !e)}
      >
        <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${summary ? 'bg-gray-500' : 'bg-gray-700'}`} />
        <span className="font-mono text-[10px] font-bold text-gray-300">
          #{activity.id.slice(0, 8)}
        </span>
        <span className="font-mono text-[9px] text-gray-600 flex-1">
          {fmtTime(activity.started_at)}
          {activity.closed_at ? ` – ${fmtTime(activity.closed_at)}` : ''}
        </span>
        <span className="font-mono text-[9px] text-gray-700">
          {activity.events.length} evt
        </span>
        {summary && (
          <span className={`font-mono text-[9px] font-bold px-1.5 py-0.5 rounded border uppercase ${threatClass}`}>
            {summary.threat_level}
          </span>
        )}
        <span className={`text-gray-600 text-[10px] transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}>▶</span>
      </div>

      {expanded && (
        <div className="border-t border-dash-border">
          {/* Summary */}
          {summary ? (
            <div className="px-3 py-2.5 space-y-2">
              <p className="font-mono text-[10px] text-gray-400 leading-relaxed">{summary.summary}</p>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[9px] text-gray-600">
                  Confidence: {Math.round(summary.confidence * 100)}%
                </span>
                <span className="font-mono text-[9px] text-gray-700">·</span>
                <span className="font-mono text-[9px] text-gray-600 italic">{summary.confidence_trend}</span>
              </div>
              {summary.recommended_action && (
                <div className="font-mono text-[10px] text-gray-500 bg-dash-bg rounded px-2 py-1.5 border border-dash-border">
                  ↳ {summary.recommended_action}
                </div>
              )}
              {summary.evidence_for.length > 0 && (
                <div className="space-y-0.5">
                  <p className="font-mono text-[9px] text-emerald-700 uppercase tracking-widest">Main information</p>
                  {summary.evidence_for.map((e, i) => (
                    <p key={i} className="font-mono text-[9px] text-gray-600 pl-2">· {e}</p>
                  ))}
                </div>
              )}
              {summary.evidence_against.length > 0 && (
                <div className="space-y-0.5">
                  <p className="font-mono text-[9px] text-red-800 uppercase tracking-widest">Side notes</p>
                  {summary.evidence_against.map((e, i) => (
                    <p key={i} className="font-mono text-[9px] text-gray-600 pl-2">· {e}</p>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="px-3 py-2 font-mono text-[10px] text-gray-700 italic">No summary available</div>
          )}

          {/* Events toggle */}
          {activity.events.length > 0 && (
            <div className="border-t border-dash-border">
              <button
                onClick={() => setShowEvents((s) => !s)}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-dash-card-hover transition-colors text-left"
              >
                <span className="font-mono text-[9px] font-semibold tracking-widest text-gray-600 uppercase flex-1">
                  Detection Events ({activity.events.length})
                </span>
                <span className={`text-gray-600 text-[10px] transition-transform duration-150 ${showEvents ? 'rotate-90' : ''}`}>▶</span>
              </button>
              {showEvents && (
                <div className="space-y-0.5 px-2 pb-2">
                  {activity.events.map((ev) => (
                    <EventRow
                      key={ev.id}
                      event={ev}
                      videoRef={videoRef}
                      recordingStartedAt={recordingStartedAt}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Reasoning history toggle */}
          {activity.explanations.length > 0 && (
            <div className="border-t border-dash-border">
              <button
                onClick={() => setShowHistory((s) => !s)}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-dash-card-hover transition-colors text-left"
              >
                <span className="font-mono text-[9px] font-semibold tracking-widest text-gray-600 uppercase flex-1">
                  Reasoning History ({activity.explanations.length})
                </span>
                <span className={`text-gray-600 text-[10px] transition-transform duration-150 ${showHistory ? 'rotate-90' : ''}`}>▶</span>
              </button>
              {showHistory && (
                <div className="space-y-2 px-2 pb-2">
                  {activity.explanations.map((expl, i) => (
                    <ExplanationHistoryRow key={i} explanation={expl} index={i} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/* ── Event row ───────────────────────────────────────────────────────────── */

const EventRow: React.FC<{
  event: StoredEvent;
  videoRef: React.RefObject<HTMLVideoElement>;
  recordingStartedAt: number;
}> = ({ event, videoRef, recordingStartedAt }) => {
  const sourceClass = SOURCE_COLORS[event.source] ?? 'text-gray-400 bg-gray-800';
  const sourceLabel = SOURCE_LABELS[event.source] ?? event.source.toUpperCase();
  const pct = Math.round(event.confidence * 100);

  const handleClick = () => {
    const el = videoRef.current;
    if (!el) return;
    const videoSecs = typeof event.metadata?.video_time_seconds === 'number'
      ? event.metadata.video_time_seconds
      : Math.max(0, event.timestamp - recordingStartedAt);
    el.currentTime = videoSecs;
    el.pause();
  };

  return (
    <div
      className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer hover:bg-dash-bg transition-colors group"
      onClick={handleClick}
      title="Click to jump to this frame in the recording"
    >
      <span className={`font-mono text-[9px] font-bold px-1 py-0.5 rounded shrink-0 ${sourceClass}`}>
        {sourceLabel}
      </span>
      <code className="font-mono text-[10px] text-gray-400 flex-1 truncate">{event.type}</code>
      <span className="font-mono text-[9px] text-gray-600 shrink-0">{pct}%</span>
      <span className="font-mono text-[9px] text-violet-800 group-hover:text-violet-400 transition-colors shrink-0">⤳</span>
    </div>
  );
};

/* ── Reasoning history row ───────────────────────────────────────────────── */

const ExplanationHistoryRow: React.FC<{ explanation: StoredExplanation; index: number }> = ({ explanation, index }) => {
  const [expanded, setExpanded] = useState(false);
  const threatClass = THREAT_COLORS[explanation.threat_level] ?? THREAT_COLORS.low;
  const timeStr = explanation.created_at ? fmtTime(explanation.created_at) : `Update ${index + 1}`;

  return (
    <div className="rounded border border-dash-border bg-dash-bg overflow-hidden">
      <div
        className="flex items-center gap-2 px-2 py-1.5 cursor-pointer hover:bg-dash-card-hover transition-colors"
        onClick={() => setExpanded((e) => !e)}
      >
        <span className="font-mono text-[9px] text-gray-600 flex-1">{timeStr}</span>
        <span className={`font-mono text-[9px] font-bold px-1.5 py-0.5 rounded border uppercase ${threatClass}`}>
          {explanation.threat_level}
        </span>
        <span className="font-mono text-[9px] text-gray-600">
          {Math.round(explanation.confidence * 100)}%
        </span>
        <span className={`text-gray-600 text-[10px] transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}>▶</span>
      </div>
      {expanded && (
        <div className="px-2 py-2 border-t border-dash-border space-y-1">
          <p className="font-mono text-[9px] text-gray-500 leading-relaxed">{explanation.summary}</p>
          {explanation.recommended_action && (
            <p className="font-mono text-[9px] text-gray-600 italic">↳ {explanation.recommended_action}</p>
          )}
        </div>
      )}
    </div>
  );
};
