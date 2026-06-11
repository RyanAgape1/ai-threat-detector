import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Activity, DetectionEvent, Explanation } from '../types';
import type { CameraSession } from '../hooks/useCamera';
import type { Resolution } from '../hooks/useResolutions';
import { ExplanationView } from './ExplanationView';
import {
  formatRelativeTime,
  formatAbsoluteTime,
  formatDuration,
  getSourceColor,
  getSourceBg,
  getSourceIcon,
  getSourceLabel,
} from '../utils';

interface ReasoningPanelProps {
  activity: Activity | null;
  videoUrl: string | null;
  cameraSessions: CameraSession[];
  snapshots: Record<string, string>;
  resolution: Resolution | null;
  onResolve: (decision: 'all_clear' | 'threat') => void;
  recordingStartedAt: number | null;
  cameraFilter: string | null;
  onCameraFilterChange: (id: string | null) => void;
}

export const ReasoningPanel: React.FC<ReasoningPanelProps> = ({ activity, videoUrl, cameraSessions, snapshots, resolution, onResolve, recordingStartedAt, cameraFilter, onCameraFilterChange }) => {
  // Internal video ref used for seeking in recording/upload playback
  const videoRef = useRef<HTMLVideoElement>(null);
  const [previewSnapshot, setPreviewSnapshot] = useState<string | null>(null);

  // Clear snapshot preview when the selected activity changes
  useEffect(() => {
    setPreviewSnapshot(null);
  }, [activity?.id]);

  const handleEventClick = useCallback((event: DetectionEvent, snapshot?: string) => {
    if (snapshot) {
      setPreviewSnapshot(snapshot);
      return;
    }
    const el = videoRef.current;
    if (!el) return;

    // Recording seek: offset from recording start using event wall-clock timestamp
    if (recordingStartedAt !== null) {
      el.currentTime = Math.max(0, event.timestamp - recordingStartedAt);
      el.play().catch(() => {});
      setPreviewSnapshot(null);
      return;
    }

    // Uploaded video seek: use frame-derived video_time_seconds stored in metadata
    if (videoUrl && typeof event.metadata?.video_time_seconds === 'number') {
      el.currentTime = event.metadata.video_time_seconds as number;
      el.play().catch(() => {});
      setPreviewSnapshot(null);
    }
  }, [videoRef, videoUrl, recordingStartedAt]);

  const clearSnapshot = useCallback(() => setPreviewSnapshot(null), []);

  const hasVideo = cameraSessions.length > 0 || videoUrl !== null;

  if (!activity) {
    return (
      <div className="flex-1 flex flex-col bg-dash-bg overflow-hidden">
        {hasVideo && <VideoPreview videoUrl={videoUrl} cameraSessions={cameraSessions} videoRef={videoRef} snapshotPreview={previewSnapshot} onClearSnapshot={clearSnapshot} isRecording={recordingStartedAt !== null} cameraFilter={cameraFilter} onCameraFilterChange={onCameraFilterChange} />}
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-3">
            <div className="text-4xl opacity-20">⬅</div>
            <p className="font-mono text-sm text-gray-600 tracking-wider">
              Select an activity to view AI reasoning
            </p>
          </div>
        </div>
      </div>
    );
  }

  const explanation = activity.latest_explanation ?? activity.summary;
  const isActive = activity.status === 'active';
  const isLive = isActive && activity.latest_explanation !== null;

  return (
    <div className="flex-1 flex flex-col bg-dash-bg overflow-hidden">
      {/* Activity header */}
      <ActivityHeader activity={activity} />

      {/* Video preview — sits between header and scrollable body */}
      {hasVideo && <VideoPreview videoUrl={videoUrl} cameraSessions={cameraSessions} videoRef={videoRef} snapshotPreview={previewSnapshot} onClearSnapshot={clearSnapshot} isRecording={recordingStartedAt !== null} cameraFilter={cameraFilter} onCameraFilterChange={onCameraFilterChange} />}

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto p-5 space-y-6">
        {/* Evidence timeline */}
        <section>
          {(() => {
            const allEvents = [...activity.events].sort((a, b) => a.timestamp - b.timestamp);
            const displayedEvents = cameraFilter
              ? allEvents.filter((e) => (e.metadata.camera_id as string | undefined) === cameraFilter)
              : allEvents;
            return (
              <>
                <div className="flex items-center gap-2 mb-3">
                  <h2 className="font-mono text-[10px] font-semibold tracking-widest text-gray-600 uppercase">
                    Evidence Timeline
                  </h2>
                  <div className="flex-1 h-px bg-dash-border" />
                  <span className="font-mono text-[10px] text-gray-700">
                    {displayedEvents.length}{cameraFilter && displayedEvents.length !== allEvents.length ? `/${allEvents.length}` : ''} events
                  </span>
                </div>

                {displayedEvents.length === 0 ? (
                  <p className="text-xs text-gray-700 font-mono italic">No events from this camera</p>
                ) : (
                  <div className="space-y-1.5">
                    {displayedEvents.map((event) => (
                      <EventRow
                        key={event.id}
                        event={event}
                        onEventClick={handleEventClick}
                        snapshot={snapshots[event.id]}
                        seekable={(videoUrl !== null || recordingStartedAt !== null) && cameraSessions.length === 0}
                      />
                    ))}
                  </div>
                )}
              </>
            );
          })()}
        </section>

        {/* AI Reasoning */}
        <section>
          <div className="flex items-center gap-2 mb-4">
            <h2 className="font-mono text-[10px] font-semibold tracking-widest text-gray-600 uppercase">
              AI Reasoning
            </h2>
            <div className="flex-1 h-px bg-dash-border" />
            {activity.status === 'closed' && (
              <span className="font-mono text-[10px] text-gray-600 bg-gray-800 px-2 py-0.5 rounded">
                Final Summary
              </span>
            )}
          </div>

          {explanation ? (
            <ExplanationView explanation={explanation} isLive={!!isLive} />
          ) : (
            <div className="flex items-center gap-3 py-6 text-gray-700">
              <div className="w-3 h-3 rounded-full border-2 border-blue-700 border-t-transparent animate-spin-slow" />
              <span className="font-mono text-xs tracking-wider">
                Waiting for AI analysis...
              </span>
            </div>
          )}
        </section>

        {/* Operator decision — only shown once AI has produced an explanation */}
        {explanation && (
          <OperatorDecision
            explanation={explanation}
            activityId={activity.id}
            resolution={resolution}
            onResolve={onResolve}
          />
        )}
      </div>
    </div>
  );
};

/* ── Activity header bar ─────────────────────────────────────────────────── */

const ActivityHeader: React.FC<{ activity: Activity }> = ({ activity }) => {
  const isActive = activity.status === 'active';
  const durationEnd = activity.closed_at ?? Date.now() / 1000;

  return (
    <div className="px-5 py-3 border-b border-dash-border bg-dash-panel shrink-0">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          {/* Status dot */}
          <div
            className={`w-2 h-2 rounded-full shrink-0 ${
              isActive ? 'bg-red-500 animate-pulse-fast' : 'bg-gray-600'
            }`}
          />
          {/* ID */}
          <span className="font-mono text-sm font-bold text-gray-100 tracking-wider">
            #{activity.id.slice(0, 8)}
          </span>
          <span className="font-mono text-[10px] text-gray-700 hidden sm:block truncate">
            {activity.id}
          </span>
        </div>

        <div className="flex items-center gap-4 shrink-0">
          <StatPill label="Started" value={formatAbsoluteTime(activity.started_at)} />
          <StatPill label="Age" value={formatRelativeTime(activity.started_at)} />
          <StatPill label="Duration" value={formatDuration(activity.started_at, durationEnd)} />
          <StatPill label="Events" value={String(activity.events.length)} />
          <span
            className={`font-mono text-[10px] font-bold tracking-widest uppercase px-2 py-1 rounded ${
              isActive
                ? 'bg-red-900/40 text-red-400 border border-red-800/50 animate-pulse-slow'
                : 'bg-gray-800 text-gray-500 border border-gray-700'
            }`}
          >
            {isActive ? 'Active' : 'Closed'}
          </span>
        </div>
      </div>
    </div>
  );
};

const StatPill: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="text-center hidden lg:block">
    <div className="font-mono text-[9px] text-gray-700 uppercase tracking-widest">{label}</div>
    <div className="font-mono text-[11px] text-gray-400 font-semibold">{value}</div>
  </div>
);

/* ── Event row ───────────────────────────────────────────────────────────── */

const EventRow: React.FC<{
  event: DetectionEvent;
  onEventClick: (event: DetectionEvent, snapshot?: string) => void;
  snapshot?: string;
  seekable?: boolean;
}> = ({ event, onEventClick, snapshot, seekable = false }) => {
  const [expanded, setExpanded] = useState(false);
  const hasMetadata = Object.keys(event.metadata).length > 0;
  const confidencePct = Math.round(event.confidence * 100);

  const videoTime = typeof event.metadata?.video_time_seconds === 'number'
    ? event.metadata.video_time_seconds as number
    : null;

  const isClickable = hasMetadata || !!snapshot || seekable;

  const handleRowClick = () => {
    onEventClick(event, snapshot);
    if (hasMetadata) setExpanded((p) => !p);
  };

  return (
    <div className="rounded border border-dash-border bg-dash-card transition-colors duration-150 hover:border-dash-border-bright animate-fade-in">
      <div
        className={`flex items-center gap-3 px-3 py-2 ${isClickable ? 'cursor-pointer' : ''}`}
        onClick={isClickable ? handleRowClick : undefined}
      >
        {/* Source badge */}
        <div
          className={`
            flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-mono font-bold shrink-0
            ${getSourceBg(event.source)} ${getSourceColor(event.source)}
          `}
        >
          <span>{getSourceIcon(event.source)}</span>
          <span>{getSourceLabel(event.source)}</span>
        </div>

        {/* Event type */}
        <code className="font-mono text-xs text-gray-300 flex-1 truncate">
          {event.type}
        </code>

        {/* Confidence bar + value */}
        <div className="flex items-center gap-2 w-28 shrink-0">
          <div className="flex-1 h-1 bg-gray-800 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full ${getConfidenceBarClass(confidencePct)}`}
              style={{ width: `${confidencePct}%` }}
            />
          </div>
          <span className="font-mono text-[10px] text-gray-500 w-7 text-right">{confidencePct}%</span>
        </div>

        {/* Timestamp */}
        <span className="font-mono text-[10px] text-gray-600 shrink-0 w-16 text-right">
          {formatRelativeTime(event.timestamp)}
        </span>

        {/* Video time indicator (for uploaded video) or snapshot/seek indicator */}
        {videoTime !== null && !snapshot && (
          <span className="font-mono text-[9px] text-gray-700 shrink-0">
            {String(Math.floor(videoTime / 60)).padStart(2, '0')}:{String(Math.floor(videoTime % 60)).padStart(2, '0')}
          </span>
        )}
        {seekable && videoTime === null && !snapshot && (
          <span className="font-mono text-[9px] text-violet-700 shrink-0" title="Click to seek to this moment in the recording">⤳</span>
        )}
        {snapshot && (
          <span className="font-mono text-[9px] text-blue-600 shrink-0" title="Click to view captured frame">◉</span>
        )}

        {/* Expand toggle for metadata */}
        {hasMetadata && (
          <span className={`text-gray-600 text-xs transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}>
            ▶
          </span>
        )}
      </div>

      {/* Metadata expansion */}
      {expanded && hasMetadata && (
        <div className="border-t border-dash-border px-3 py-2.5 animate-fade-in">
          <pre className="font-mono text-[10px] text-gray-500 overflow-x-auto leading-relaxed whitespace-pre-wrap break-all">
            {JSON.stringify(event.metadata, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
};

/* ── Video preview ───────────────────────────────────────────────────────── */

interface VideoPreviewProps {
  videoUrl: string | null;
  cameraSessions: CameraSession[];
  videoRef: React.RefObject<HTMLVideoElement>;
  snapshotPreview: string | null;
  onClearSnapshot: () => void;
  isRecording?: boolean;
  cameraFilter: string | null;
  onCameraFilterChange: (id: string | null) => void;
}

const VideoPreview: React.FC<VideoPreviewProps> = ({
  videoUrl,
  cameraSessions,
  videoRef,
  snapshotPreview,
  onClearSnapshot,
  isRecording = false,
  cameraFilter,
  onCameraFilterChange,
}) => {
  const isLive = cameraSessions.length > 0;
  // Only show sessions that match the filter (or all if no filter)
  const visibleSessions = cameraFilter
    ? cameraSessions.filter((s) => s.sessionId === cameraFilter)
    : cameraSessions;

  // Wire up the recording video element when not in camera mode
  useEffect(() => {
    if (isLive) return;
    const el = videoRef.current;
    if (!el) return;
    if (videoUrl) {
      el.srcObject = null;
      el.src = videoUrl;
      el.play().catch(() => {});
    } else {
      el.srcObject = null;
      el.removeAttribute('src');
    }
  }, [isLive, videoUrl, videoRef]);

  const headerLabel = snapshotPreview
    ? 'Captured Frame'
    : isLive
    ? cameraFilter
      ? (cameraSessions.find((s) => s.sessionId === cameraFilter)?.label ?? 'Live Camera')
      : cameraSessions.length === 1
      ? 'Live Camera'
      : `Live — ${cameraSessions.length} cameras`
    : isRecording
    ? 'Recording'
    : 'Video Feed';

  return (
    <div className="shrink-0 border-b border-dash-border bg-black">
      <div className="flex items-center justify-between px-4 py-1.5 bg-dash-panel border-b border-dash-border">
        <div className="flex items-center gap-2">
          <div
            className={`w-1.5 h-1.5 rounded-full ${
              snapshotPreview ? 'bg-yellow-500' : isLive ? 'bg-red-500 animate-pulse' : 'bg-gray-600'
            }`}
          />
          <span className="font-mono text-[9px] font-semibold tracking-widest text-gray-500 uppercase">
            {headerLabel}
          </span>
        </div>

        <div className="flex items-center gap-3">
          {/* Camera filter dropdown — only when multiple cameras are live */}
          {isLive && cameraSessions.length > 1 && !snapshotPreview && (
            <select
              value={cameraFilter ?? ''}
              onChange={(e) => onCameraFilterChange(e.target.value || null)}
              className="font-mono text-[9px] bg-gray-900 border border-dash-border text-gray-400
                rounded px-2 py-0.5 focus:outline-none focus:border-gray-600 cursor-pointer"
            >
              <option value="">All Cameras</option>
              {cameraSessions.map((s) => (
                <option key={s.sessionId} value={s.sessionId}>
                  {s.label}
                </option>
              ))}
            </select>
          )}

          {snapshotPreview && (
            <button
              onClick={onClearSnapshot}
              className="font-mono text-[9px] text-gray-500 hover:text-gray-300 tracking-widest uppercase transition-colors"
            >
              {isLive ? '← Back to Live' : '← Back to Video'}
            </button>
          )}
        </div>
      </div>

      {/* Snapshot preview */}
      {snapshotPreview && (
        <img
          src={`data:image/jpeg;base64,${snapshotPreview}`}
          alt="Detected event frame"
          className="w-full max-h-48 object-contain bg-black block"
        />
      )}

      {/* Camera grid — ALL sessions always mounted so frame capture keeps running.
          Filter (visibleSessions) only controls which tiles are displayed. */}
      {isLive && (
        <div className={snapshotPreview ? 'hidden' : ''}>
          {/* Hidden tiles for sessions filtered out — keeps video elements alive */}
          {cameraSessions
            .filter((s) => !visibleSessions.includes(s))
            .map((session) => (
              <div key={session.sessionId} className="hidden">
                <CameraFeedItem session={session} />
              </div>
            ))}
          {/* Visible grid */}
          <div
            className={`grid ${visibleSessions.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}
          >
            {visibleSessions.map((session) => (
              <CameraFeedItem key={session.sessionId} session={session} />
            ))}
          </div>
        </div>
      )}

      {/* Recording / upload playback */}
      {!isLive && !snapshotPreview && (
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          controls
          loop
          className="w-full max-h-48 object-contain bg-black block"
        />
      )}
    </div>
  );
};

/* Individual live camera feed tile */
const CameraFeedItem: React.FC<{ session: CameraSession }> = ({ session }) => {
  useEffect(() => {
    const el = session.videoRef.current;
    if (!el) return;
    el.srcObject = session.stream;
    el.play().catch(() => {});
    return () => {
      if (el.srcObject) el.srcObject = null;
    };
  }, [session]);

  return (
    <div className="relative bg-black">
      <video
        ref={session.videoRef}
        autoPlay
        muted
        playsInline
        className="w-full max-h-48 object-contain block"
      />
      <div className="absolute bottom-1 left-1">
        <span className="font-mono text-[9px] bg-black/70 text-gray-300 px-1.5 py-0.5 rounded truncate max-w-[120px] block">
          {session.label}
        </span>
      </div>
    </div>
  );
};

/* ── Operator decision ───────────────────────────────────────────────────── */

interface FurtherActions {
  immediate: string[];
  followUp: string[];
}

function buildFurtherActions(explanation: Explanation): FurtherActions {
  const immediate: string[] = [];
  const followUp: string[] = [];

  if (explanation.recommended_action) {
    immediate.push(explanation.recommended_action);
  }

  switch (explanation.threat_level) {
    case 'critical':
      immediate.push('Call emergency services immediately (911)');
      immediate.push('Initiate full facility lockdown');
      immediate.push('Evacuate the affected area now');
      followUp.push('Preserve all camera footage and system logs');
      followUp.push('Secure the perimeter — prevent entry/exit');
      followUp.push('Brief responding officers on last known location and description');
      followUp.push('Document all witness accounts with timestamps');
      break;
    case 'high':
      immediate.push('Deploy security personnel to the location immediately');
      immediate.push('Alert law enforcement — prepare to call 911');
      immediate.push('Clear bystanders from the immediate area');
      followUp.push('Review adjacent camera feeds for fuller context');
      followUp.push('Document the incident with frame numbers and timestamps');
      followUp.push('Notify supervisory staff and on-call manager');
      break;
    case 'medium':
      immediate.push('Alert the on-site security team');
      immediate.push('Increase monitoring frequency for this area');
      followUp.push('Pull footage from nearby cameras');
      followUp.push('Prepare a preliminary incident report');
      followUp.push('Identify and interview any available witnesses');
      break;
    case 'low':
    default:
      immediate.push('Continue passive monitoring of the situation');
      followUp.push('Log the event in the incident reporting system');
      followUp.push('Review footage for additional context before closing');
      break;
  }

  // Surface open questions as investigation items
  explanation.open_questions.forEach((q) => {
    followUp.push(`Investigate: ${q}`);
  });

  return { immediate, followUp };
}

interface OperatorDecisionProps {
  explanation: Explanation;
  activityId: string;
  resolution: Resolution | null;
  onResolve: (decision: 'all_clear' | 'threat') => void;
}

const OperatorDecision: React.FC<OperatorDecisionProps> = ({ explanation, activityId, resolution, onResolve }) => {
  const [decision, setDecision] = useState<'none' | 'all_clear' | 'threat'>(
    resolution?.decision ?? 'none'
  );

  // Sync local decision UI state when activity or resolution changes
  useEffect(() => {
    setDecision(resolution?.decision ?? 'none');
  }, [activityId, resolution]);

  const isResolved = resolution !== null;
  const actions = decision === 'threat' ? buildFurtherActions(explanation) : null;

  return (
    <section className="border-t border-dash-border pt-5">
      {/* Section header */}
      <div className="flex items-center gap-2 mb-4">
        <h2 className="font-mono text-[10px] font-semibold tracking-widest text-gray-600 uppercase">
          Operator Decision
        </h2>
        <div className="flex-1 h-px bg-dash-border" />
        {isResolved && (
          <span className="font-mono text-[10px] text-emerald-500 bg-emerald-900/30 border border-emerald-800/50 px-2 py-0.5 rounded">
            ✓ Resolved {resolution.resolvedAt}
          </span>
        )}
      </div>

      {/* Choice buttons */}
      {!isResolved && (
        <div className="flex gap-3 mb-4">
          <button
            onClick={() => setDecision('all_clear')}
            className={`flex-1 py-2.5 rounded border font-mono text-xs font-semibold tracking-widest uppercase transition-all duration-150
              ${decision === 'all_clear'
                ? 'bg-emerald-900/50 border-emerald-600 text-emerald-300'
                : 'bg-gray-900 border-dash-border text-gray-500 hover:border-emerald-800 hover:text-emerald-400'
              }`}
          >
            ✓ All Clear
          </button>
          <button
            onClick={() => setDecision('threat')}
            className={`flex-1 py-2.5 rounded border font-mono text-xs font-semibold tracking-widest uppercase transition-all duration-150
              ${decision === 'threat'
                ? 'bg-red-900/50 border-red-600 text-red-300'
                : 'bg-gray-900 border-dash-border text-gray-500 hover:border-red-800 hover:text-red-400'
              }`}
          >
            ⚠ Threat Confirmed
          </button>
        </div>
      )}

      {/* All clear expansion */}
      {decision === 'all_clear' && !isResolved && (
        <div className="rounded border border-emerald-800/40 bg-emerald-900/10 p-4 space-y-3 animate-fade-in">
          <p className="font-mono text-xs text-emerald-400">
            Situation assessed as safe. No further action required.
          </p>
          <button
            onClick={() => onResolve('all_clear')}
            className="font-mono text-xs font-semibold tracking-widest uppercase px-5 py-2 rounded
              bg-emerald-700/40 border border-emerald-600 text-emerald-300
              hover:bg-emerald-700/60 transition-all duration-150"
          >
            ✓ Mark as Resolved
          </button>
        </div>
      )}

      {/* Threat confirmed expansion */}
      {decision === 'threat' && !isResolved && actions && (
        <div className="space-y-4 animate-fade-in">
          {/* Immediate actions */}
          <div className="rounded border border-red-800/40 bg-red-900/10 p-4">
            <p className="font-mono text-[10px] font-semibold tracking-widest text-red-400 uppercase mb-3">
              Immediate Actions
            </p>
            <ul className="space-y-2">
              {actions.immediate.map((action, i) => (
                <ActionItem key={i} text={action} color="red" />
              ))}
            </ul>
          </div>

          {/* Follow-up actions */}
          <div className="rounded border border-orange-800/40 bg-orange-900/10 p-4">
            <p className="font-mono text-[10px] font-semibold tracking-widest text-orange-400 uppercase mb-3">
              Follow-Up Steps
            </p>
            <ul className="space-y-2">
              {actions.followUp.map((action, i) => (
                <ActionItem key={i} text={action} color="orange" />
              ))}
            </ul>
          </div>

          <button
            onClick={() => onResolve('threat')}
            className="w-full font-mono text-xs font-semibold tracking-widest uppercase px-5 py-2 rounded
              bg-gray-800 border border-gray-600 text-gray-300
              hover:bg-gray-700 transition-all duration-150"
          >
            ✓ Mark as Handled
          </button>
        </div>
      )}

      {/* Resolved state */}
      {isResolved && (
        <div className="rounded border border-emerald-800/40 bg-emerald-900/10 p-4 animate-fade-in">
          <p className="font-mono text-xs text-emerald-400">
            {resolution.decision === 'all_clear'
              ? 'Incident closed — assessed as safe by operator.'
              : 'Incident closed — threat response actions initiated by operator.'}
          </p>
        </div>
      )}
    </section>
  );
};

const ActionItem: React.FC<{ text: string; color: 'red' | 'orange' }> = ({ text, color }) => {
  const [checked, setChecked] = useState(false);
  return (
    <li
      className="flex items-start gap-2.5 cursor-pointer group"
      onClick={() => setChecked((c) => !c)}
    >
      <div className={`mt-0.5 w-4 h-4 rounded shrink-0 border flex items-center justify-center transition-all duration-150
        ${checked
          ? color === 'red' ? 'bg-red-700 border-red-500' : 'bg-orange-700 border-orange-500'
          : 'border-gray-600 group-hover:border-gray-400'
        }`}
      >
        {checked && <span className="text-white text-[10px]">✓</span>}
      </div>
      <span className={`font-mono text-xs leading-relaxed transition-colors duration-150
        ${checked ? 'line-through text-gray-600' : color === 'red' ? 'text-red-200' : 'text-orange-200'}`}
      >
        {text}
      </span>
    </li>
  );
};

function getConfidenceBarClass(pct: number): string {
  if (pct >= 85) return 'bg-red-500';
  if (pct >= 70) return 'bg-orange-400';
  if (pct >= 50) return 'bg-yellow-400';
  return 'bg-blue-400';
}
