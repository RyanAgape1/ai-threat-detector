import React, { useEffect, useRef, useState } from 'react';
import type { Recording } from '../hooks/useRecordings';

interface RecordingsModalProps {
  open: boolean;
  onClose: () => void;
  recordings: Recording[];
  loading: boolean;
  onRefresh: () => void;
  onDelete: (id: string) => Promise<void>;
  getVideoUrl: (id: string) => string;
}

function fmtDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtDate(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}

function fmtSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const RecordingsModal: React.FC<RecordingsModalProps> = ({
  open, onClose, recordings, loading, onRefresh, onDelete, getVideoUrl,
}) => {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (open) onRefresh();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Clear selection if selected recording was deleted
  useEffect(() => {
    if (selectedId && !recordings.find((r) => r.id === selectedId)) {
      setSelectedId(null);
    }
  }, [recordings, selectedId]);

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
        className="w-[960px] max-w-[95vw] h-[620px] max-h-[92vh] bg-dash-panel border border-dash-border rounded-lg flex flex-col overflow-hidden"
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

        {/* Body */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left: recording list */}
          <div className="w-72 shrink-0 border-r border-dash-border overflow-y-auto">
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
                    <div className="flex items-center gap-3 font-mono text-[9px] text-gray-600">
                      <span>{fmtDuration(rec.duration_seconds)}</span>
                      <span>·</span>
                      <span>{fmtSize(rec.filesize_bytes)}</span>
                      <span>·</span>
                      <span>{rec.frame_count} frames</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Right: video player */}
          <div className="flex-1 flex flex-col bg-black overflow-hidden">
            {selected ? (
              <>
                {/* Player header */}
                <div className="shrink-0 flex items-center gap-2 px-4 py-1.5 bg-dash-panel border-b border-dash-border">
                  <div className="w-1.5 h-1.5 rounded-full bg-violet-500" />
                  <span className="font-mono text-[9px] font-semibold tracking-widest text-gray-500 uppercase">
                    {fmtDate(selected.started_at)}
                  </span>
                  <span className="font-mono text-[9px] text-gray-700 ml-auto">
                    {fmtDuration(selected.duration_seconds)} · {fmtSize(selected.filesize_bytes)}
                  </span>
                  <button
                    onClick={() => void handleDelete(selected.id)}
                    disabled={deleting === selected.id}
                    className="font-mono text-[10px] text-red-500 hover:text-red-300 hover:bg-red-900/30 px-2 py-0.5 rounded border border-red-800/50 transition-colors disabled:opacity-40 ml-2"
                  >
                    {deleting === selected.id ? 'Deleting…' : 'Delete'}
                  </button>
                </div>
                {/* Video */}
                <video
                  ref={videoRef}
                  key={selected.id}
                  src={getVideoUrl(selected.id)}
                  controls
                  className="w-full flex-1 object-contain bg-black"
                />
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
        </div>
      </div>
    </div>
  );
};
