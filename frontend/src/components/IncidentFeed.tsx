import React, { useState } from 'react';
import type { Activity } from '../types';
import type { Resolution } from '../hooks/useResolutions';
import { formatRelativeTime, formatDuration, getThreatColor, getThreatBg } from '../utils';

interface IncidentFeedProps {
  activities: Activity[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  resolutions: Record<string, Resolution>;
  cameraFilter: string | null;
}

export const IncidentFeed: React.FC<IncidentFeedProps> = ({
  activities, selectedId, onSelect, resolutions, cameraFilter,
}) => {
  // When a camera is selected, only show activities owned by that camera
  const visibleActivities = cameraFilter
    ? activities.filter((a) => a.camera_id === cameraFilter)
    : activities;
  const [allClearOpen, setAllClearOpen] = useState(true);
  const [handledOpen, setHandledOpen] = useState(true);

  const unresolved = visibleActivities.filter((a) => !resolutions[a.id]);
  const allClear   = visibleActivities.filter((a) => resolutions[a.id]?.decision === 'all_clear');
  const handled    = visibleActivities.filter((a) => resolutions[a.id]?.decision === 'threat');
  const total = visibleActivities.length;

  return (
    <aside className="w-[35%] min-w-[280px] flex flex-col border-r border-dash-border bg-dash-panel">
      {/* Panel header */}
      <div className="px-4 py-3 border-b border-dash-border flex items-center justify-between shrink-0">
        <span className="font-mono text-xs font-semibold tracking-widest text-gray-500 uppercase">
          Activity Log
        </span>
        <span className="font-mono text-xs text-gray-600 bg-dash-card px-2 py-0.5 rounded">
          {total}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {total === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-gray-600">
            <div className="text-3xl opacity-30">⚡</div>
            <p className="font-mono text-xs tracking-wider">No activity yet</p>
          </div>
        ) : (
          <div>
            {/* ── Unresolved ───────────────────────────────────── */}
            {unresolved.length > 0 && (
              <ul className="p-3 space-y-2">
                {unresolved.map((a) => (
                  <ActivityCard
                    key={a.id}
                    activity={a}
                    selected={selectedId === a.id}
                    resolution={null}
                    onClick={() => onSelect(a.id)}
                  />
                ))}
              </ul>
            )}

            {/* ── All Clear ────────────────────────────────────── */}
            {allClear.length > 0 && (
              <div>
                <button
                  onClick={() => setAllClearOpen((o) => !o)}
                  className="w-full flex items-center gap-2 px-4 py-2 border-y border-emerald-900/40
                    bg-emerald-950/20 hover:bg-emerald-950/30 transition-colors"
                >
                  <span className="text-emerald-500 text-xs">✓</span>
                  <span className="font-mono text-[10px] font-semibold tracking-widest text-emerald-600 uppercase flex-1 text-left">
                    All Clear
                  </span>
                  <span className="font-mono text-[10px] text-emerald-700 bg-emerald-900/40 px-1.5 py-0.5 rounded">
                    {allClear.length}
                  </span>
                  <span className="text-emerald-700 text-xs">{allClearOpen ? '▾' : '▸'}</span>
                </button>
                {allClearOpen && (
                  <ul className="p-3 space-y-2">
                    {allClear.map((a) => (
                      <ActivityCard
                        key={a.id}
                        activity={a}
                        selected={selectedId === a.id}
                        resolution={resolutions[a.id]}
                        onClick={() => onSelect(a.id)}
                      />
                    ))}
                  </ul>
                )}
              </div>
            )}

            {/* ── Handled ──────────────────────────────────────── */}
            {handled.length > 0 && (
              <div>
                <button
                  onClick={() => setHandledOpen((o) => !o)}
                  className="w-full flex items-center gap-2 px-4 py-2 border-y border-orange-900/40
                    bg-orange-950/20 hover:bg-orange-950/30 transition-colors"
                >
                  <span className="text-orange-400 text-xs">⚠</span>
                  <span className="font-mono text-[10px] font-semibold tracking-widest text-orange-600 uppercase flex-1 text-left">
                    Handled
                  </span>
                  <span className="font-mono text-[10px] text-orange-700 bg-orange-900/40 px-1.5 py-0.5 rounded">
                    {handled.length}
                  </span>
                  <span className="text-orange-700 text-xs">{handledOpen ? '▾' : '▸'}</span>
                </button>
                {handledOpen && (
                  <ul className="p-3 space-y-2">
                    {handled.map((a) => (
                      <ActivityCard
                        key={a.id}
                        activity={a}
                        selected={selectedId === a.id}
                        resolution={resolutions[a.id]}
                        onClick={() => onSelect(a.id)}
                      />
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
};

interface ActivityCardProps {
  activity: Activity;
  selected: boolean;
  resolution: Resolution | null;
  onClick: () => void;
}

const ActivityCard: React.FC<ActivityCardProps> = ({ activity, selected, resolution, onClick }) => {
  const isActive = activity.status === 'active';
  const explanation = activity.latest_explanation ?? activity.summary;

  const accentColor = resolution
    ? resolution.decision === 'all_clear' ? 'bg-emerald-600' : 'bg-orange-500'
    : isActive ? 'bg-red-500 animate-pulse-slow' : 'bg-gray-700';

  return (
    <li
      onClick={onClick}
      className={`relative rounded-md border cursor-pointer transition-all duration-200 animate-fade-in select-none
        ${selected
          ? 'border-blue-600/70 bg-blue-950/30 shadow-[0_0_0_1px_rgba(37,99,235,0.3)]'
          : resolution?.decision === 'all_clear'
          ? 'border-emerald-900/50 bg-dash-card hover:border-emerald-800/60 hover:bg-dash-card-hover'
          : resolution?.decision === 'threat'
          ? 'border-orange-900/50 bg-dash-card hover:border-orange-800/60 hover:bg-dash-card-hover'
          : isActive
          ? 'border-dash-border-bright bg-dash-card hover:border-red-900/60 hover:bg-dash-card-hover'
          : 'border-dash-border bg-dash-card hover:border-dash-border-bright hover:bg-dash-card-hover'
        }`}
    >
      <div className={`absolute left-0 top-0 bottom-0 w-0.5 rounded-l-md ${accentColor}`} />

      <div className="pl-3 pr-3 pt-2.5 pb-2.5">
        {/* Header row */}
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <span className="font-mono text-xs font-bold text-gray-200 tracking-wider">
            #{activity.id.slice(0, 8)}
          </span>
          <div className="flex items-center gap-1.5">
            {resolution ? (
              <span className={`font-mono text-[10px] font-bold tracking-widest px-1.5 py-0.5 rounded uppercase
                ${resolution.decision === 'all_clear'
                  ? 'bg-emerald-900/50 text-emerald-400'
                  : 'bg-orange-900/50 text-orange-400'
                }`}
              >
                {resolution.decision === 'all_clear' ? '✓ All Clear' : '⚠ Handled'}
              </span>
            ) : (
              <span className={`font-mono text-[10px] font-bold tracking-widest px-1.5 py-0.5 rounded uppercase
                ${isActive ? 'bg-red-900/50 text-red-400 animate-pulse-slow' : 'bg-gray-800 text-gray-500'}`}
              >
                {isActive ? 'Active' : 'Closed'}
              </span>
            )}
            {explanation && (
              <span className={`font-mono text-[10px] font-bold tracking-widest px-1.5 py-0.5 rounded uppercase
                ${getThreatBg(explanation.threat_level)} ${getThreatColor(explanation.threat_level)}`}
              >
                {explanation.threat_level}
              </span>
            )}
          </div>
        </div>

        {/* Time + duration */}
        <div className="flex items-center gap-2 mb-2">
          <span className="font-mono text-[11px] text-gray-500">
            {formatRelativeTime(activity.started_at)}
          </span>
          {activity.closed_at && (
            <>
              <span className="text-gray-700">·</span>
              <span className="font-mono text-[11px] text-gray-600">
                {formatDuration(activity.started_at, activity.closed_at)}
              </span>
            </>
          )}
          {resolution && (
            <>
              <span className="text-gray-700">·</span>
              <span className="font-mono text-[11px] text-gray-600">{resolution.resolvedAt}</span>
            </>
          )}
        </div>

        {/* Camera source badge */}
        {activity.camera_id && (
          <div className="mb-1.5">
            <span
              className="font-mono text-[9px] bg-violet-900/40 border border-violet-800/50 text-violet-400 px-1.5 py-0.5 rounded"
              title={`Camera session: ${activity.camera_id}`}
            >
              📷 {activity.camera_id.slice(0, 8)}
            </span>
          </div>
        )}

        {/* Stats row */}
        <div className="flex items-center gap-3 mb-2">
          <div className="flex items-center gap-1">
            <span className="text-gray-600 text-[10px]">EVT</span>
            <span className="font-mono text-[11px] text-gray-400 font-semibold">
              {activity.events.length}
            </span>
          </div>
          {explanation && (
            <>
              <div className="flex items-center gap-1">
                <span className="text-gray-600 text-[10px]">CONF</span>
                <span className="font-mono text-[11px] text-gray-400 font-semibold">
                  {Math.round(explanation.confidence * 100)}%
                </span>
              </div>
              <div className="flex-1 h-1 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${getConfidenceBarColor(explanation.threat_level)}`}
                  style={{ width: `${Math.round(explanation.confidence * 100)}%` }}
                />
              </div>
            </>
          )}
        </div>

        {explanation?.summary && (
          <p className="text-[11px] text-gray-500 line-clamp-2 leading-relaxed">
            {explanation.summary}
          </p>
        )}
      </div>
    </li>
  );
};

function getConfidenceBarColor(level: string): string {
  switch (level) {
    case 'critical': return 'bg-red-500';
    case 'high':     return 'bg-orange-400';
    case 'medium':   return 'bg-yellow-400';
    default:         return 'bg-blue-400';
  }
}
