import React, { useState, useRef, useEffect } from 'react';
import type { Report, ReportEvent, PersonJourney } from '../types';
import { useReports } from '../hooks/useReports';

const API = 'http://localhost:8000';

function fmtTs(ts: number) {
  return new Date(ts * 1000).toLocaleString();
}

function fmtDuration(from: number, to: number) {
  const mins = Math.round((to - from) / 60);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

const EVENT_COLORS: Record<string, string> = {
  weapon_detected:       'text-red-400 border-red-700/50 bg-red-900/20',
  loitering_detected:    'text-orange-400 border-orange-700/50 bg-orange-900/20',
  unattended_object:     'text-yellow-400 border-yellow-700/50 bg-yellow-900/20',
  crowd_or_confrontation:'text-orange-400 border-orange-700/50 bg-orange-900/20',
  person_moved_camera:   'text-violet-400 border-violet-700/50 bg-violet-900/20',
  rapid_motion:          'text-blue-400 border-blue-700/50 bg-blue-900/20',
};

const PRESETS = [
  { label: '1h',  hours: 1 },
  { label: '4h',  hours: 4 },
  { label: '8h',  hours: 8 },
  { label: '24h', hours: 24 },
];

interface PlaybackState {
  url: string;
  seekTo: number;
  label: string;
}

function EventRow({
  event,
  onPlay,
}: {
  event: ReportEvent;
  onPlay?: (pb: PlaybackState) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const colorClass = EVENT_COLORS[event.type] ?? 'text-gray-300 border-gray-700/50 bg-gray-900/20';
  const videoSecs = event.metadata.video_time_seconds as number | undefined;
  const canPlay = !!event.recording_id && videoSecs !== undefined;

  return (
    <div className={`border rounded px-3 py-2 text-xs font-mono ${colorClass} mb-1`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="shrink-0 opacity-60 hover:opacity-100"
          >
            {expanded ? '▾' : '▸'}
          </button>
          <span className="font-semibold truncate">{event.type}</span>
          <span className="opacity-60 shrink-0">{Math.round(event.confidence * 100)}%</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="opacity-50 text-[10px]">{fmtTs(event.timestamp)}</span>
          {canPlay && onPlay && (
            <button
              onClick={() => onPlay({
                url: `${API}/recordings/${event.recording_id}/video`,
                seekTo: videoSecs!,
                label: event.type,
              })}
              className="px-2 py-0.5 rounded border border-blue-700/50 bg-blue-900/20 text-blue-300
                hover:bg-blue-900/40 transition-colors text-[10px] tracking-widest uppercase"
            >
              ▶ Play
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="mt-2 pl-4 opacity-80">
          {Object.entries(event.metadata).map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <span className="opacity-60 shrink-0">{k}:</span>
              <span className="truncate">{JSON.stringify(v)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function JourneyCard({
  journey,
  onPlay,
}: {
  journey: PersonJourney;
  onPlay?: (pb: PlaybackState) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const shortId = journey.global_person_id.slice(0, 8);

  return (
    <div className="border border-violet-700/40 rounded bg-violet-900/10 mb-2">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-mono text-violet-300"
      >
        <div className="flex items-center gap-2">
          <span>{expanded ? '▾' : '▸'}</span>
          <span className="font-semibold">Person {shortId}</span>
          <span className="opacity-60">{journey.camera_path.join(' → ')}</span>
        </div>
        <span className="opacity-50">{journey.events.length} event{journey.events.length !== 1 ? 's' : ''}</span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-violet-700/20">
          {journey.events.map((ev) => (
            <EventRow key={ev.id} event={ev} onPlay={onPlay} />
          ))}
        </div>
      )}
    </div>
  );
}

function VideoPlayer({ playback, onClose }: { playback: PlaybackState; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const onLoaded = () => { el.currentTime = playback.seekTo; };
    el.addEventListener('loadedmetadata', onLoaded);
    return () => el.removeEventListener('loadedmetadata', onLoaded);
  }, [playback]);

  return (
    <div className="mt-4 border border-dash-border rounded bg-dash-panel p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="font-mono text-xs text-gray-400 uppercase tracking-widest">{playback.label}</span>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xs font-mono">✕ close</button>
      </div>
      <video
        ref={videoRef}
        src={playback.url}
        controls
        className="w-full rounded max-h-80 bg-black"
      />
    </div>
  );
}

function ReportDetail({
  report,
  onDelete,
}: {
  report: Report;
  onDelete: () => void;
}) {
  const [playback, setPlayback] = useState<PlaybackState | null>(null);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-start justify-between px-5 py-3 border-b border-dash-border shrink-0">
        <div>
          <div className="font-mono text-xs text-gray-500 uppercase tracking-widest">
            {fmtTs(report.time_from)} → {fmtTs(report.time_to)}
            <span className="ml-2 text-gray-600">({fmtDuration(report.time_from, report.time_to)})</span>
          </div>
          <div className="font-mono text-[10px] text-gray-600 mt-0.5">
            Generated {fmtTs(report.generated_at)}
          </div>
        </div>
        <button
          onClick={onDelete}
          className="font-mono text-[10px] text-gray-600 hover:text-red-400 transition-colors uppercase tracking-widest"
        >
          ✕ Delete
        </button>
      </div>

      {/* Summary + video player — pinned, scrolls only within itself if narrative is long */}
      <div className="shrink-0 border-b border-dash-border px-5 py-4 max-h-[42%] overflow-y-auto space-y-4">
        <section>
          <h3 className="font-mono text-xs text-gray-500 uppercase tracking-widest mb-3">Summary</h3>
          <p className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">{report.narrative}</p>
        </section>
        {playback && <VideoPlayer playback={playback} onClose={() => setPlayback(null)} />}
      </div>

      {/* Events — independently scrollable */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">
        {/* Important events */}
        {report.important_events.length > 0 && (
          <section>
            <h3 className="font-mono text-xs text-gray-500 uppercase tracking-widest mb-3">
              Important Events ({report.important_events.length})
            </h3>
            {report.important_events.map((ev) => (
              <EventRow key={ev.id} event={ev} onPlay={setPlayback} />
            ))}
          </section>
        )}

        {/* Person journeys */}
        {report.person_journeys.length > 0 && (
          <section>
            <h3 className="font-mono text-xs text-gray-500 uppercase tracking-widest mb-3">
              Person Journeys ({report.person_journeys.length})
            </h3>
            {report.person_journeys.map((j) => (
              <JourneyCard key={j.global_person_id} journey={j} onPlay={setPlayback} />
            ))}
          </section>
        )}

        {report.important_events.length === 0 && report.person_journeys.length === 0 && (
          <p className="font-mono text-xs text-gray-600">No important events or person journeys in this period.</p>
        )}
      </div>
    </div>
  );
}

export const ReportTab: React.FC = () => {
  const { summaries, generating, error, generateReport, fetchReport, deleteReport } = useReports();

  const [selectedReport, setSelectedReport] = useState<Report | null>(null);
  const [loadingReport, setLoadingReport] = useState(false);
  const [preset, setPreset] = useState<number>(8);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [useCustom, setUseCustom] = useState(false);

  const handleSelect = async (id: string) => {
    if (selectedReport?.id === id) return;
    setLoadingReport(true);
    const report = await fetchReport(id);
    setSelectedReport(report);
    setLoadingReport(false);
  };

  const handleDelete = async (id: string) => {
    await deleteReport(id);
    if (selectedReport?.id === id) setSelectedReport(null);
  };

  const handleGenerate = async () => {
    let timeTo = Date.now() / 1000;
    let timeFrom: number;

    if (useCustom && customFrom && customTo) {
      timeFrom = new Date(customFrom).getTime() / 1000;
      timeTo   = new Date(customTo).getTime() / 1000;
    } else {
      timeFrom = timeTo - preset * 3600;
    }

    const report = await generateReport(timeFrom, timeTo);
    if (report) setSelectedReport(report);
  };

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Left sidebar: report list */}
      <aside className="w-72 shrink-0 border-r border-dash-border flex flex-col overflow-hidden bg-dash-panel">
        {/* Time range + generate */}
        <div className="p-3 border-b border-dash-border space-y-2">
          <div className="font-mono text-[10px] text-gray-500 uppercase tracking-widest mb-1">Time Range</div>
          <div className="flex gap-1 flex-wrap">
            {PRESETS.map((p) => (
              <button
                key={p.hours}
                onClick={() => { setPreset(p.hours); setUseCustom(false); }}
                className={`font-mono text-[10px] px-2 py-1 rounded border transition-colors
                  ${!useCustom && preset === p.hours
                    ? 'bg-blue-900/40 border-blue-600 text-blue-300'
                    : 'border-dash-border text-gray-500 hover:text-gray-300 hover:border-gray-600'}`}
              >
                {p.label}
              </button>
            ))}
            <button
              onClick={() => setUseCustom(true)}
              className={`font-mono text-[10px] px-2 py-1 rounded border transition-colors
                ${useCustom
                  ? 'bg-blue-900/40 border-blue-600 text-blue-300'
                  : 'border-dash-border text-gray-500 hover:text-gray-300 hover:border-gray-600'}`}
            >
              Custom
            </button>
          </div>

          {useCustom && (
            <div className="space-y-1">
              <input
                type="datetime-local"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="w-full font-mono text-[10px] bg-gray-900 border border-dash-border rounded px-2 py-1 text-gray-300"
                placeholder="From"
              />
              <input
                type="datetime-local"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="w-full font-mono text-[10px] bg-gray-900 border border-dash-border rounded px-2 py-1 text-gray-300"
                placeholder="To"
              />
            </div>
          )}

          <button
            onClick={handleGenerate}
            disabled={generating}
            className="w-full font-mono text-xs font-semibold tracking-widest uppercase px-3 py-1.5 rounded
              border transition-all duration-200
              bg-blue-900/30 border-blue-700/50 text-blue-300
              hover:bg-blue-900/50 hover:border-blue-600
              disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {generating && <div className="w-3 h-3 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />}
            {generating ? 'Generating...' : '⬆ Generate Report'}
          </button>

          {error && <div className="font-mono text-[10px] text-red-400">{error}</div>}
        </div>

        {/* Report list */}
        <div className="flex-1 overflow-y-auto">
          {summaries.length === 0 ? (
            <div className="px-4 py-6 font-mono text-xs text-gray-600 text-center">No reports yet</div>
          ) : (
            summaries.map((s) => (
              <button
                key={s.id}
                onClick={() => void handleSelect(s.id)}
                className={`w-full text-left px-3 py-3 border-b border-dash-border transition-colors
                  ${selectedReport?.id === s.id ? 'bg-blue-900/20' : 'hover:bg-gray-800/40'}`}
              >
                <div className="font-mono text-[10px] text-gray-400 uppercase tracking-wider">
                  {fmtTs(s.time_from)}
                </div>
                <div className="font-mono text-[10px] text-gray-600">
                  → {fmtTs(s.time_to)} · {fmtDuration(s.time_from, s.time_to)}
                </div>
                <div className="mt-1 font-mono text-[10px] text-gray-500 line-clamp-2 leading-relaxed">
                  {s.narrative_preview}
                </div>
              </button>
            ))
          )}
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 overflow-hidden bg-dash-bg">
        {loadingReport ? (
          <div className="flex items-center justify-center h-full">
            <div className="w-6 h-6 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
          </div>
        ) : selectedReport ? (
          <ReportDetail
            report={selectedReport}
            onDelete={() => void handleDelete(selectedReport.id)}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-gray-600">
            <div className="font-mono text-sm">No report selected</div>
            <div className="font-mono text-xs">Generate a report or select one from the list</div>
          </div>
        )}
      </div>
    </div>
  );
};
