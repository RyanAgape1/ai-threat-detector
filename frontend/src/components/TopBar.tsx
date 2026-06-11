import React, { useRef, useState } from 'react';
import type { CameraDevice, CameraSession } from '../hooks/useCamera';
import type { UploadProgress } from '../types';

interface TopBarProps {
  connected: boolean;
  onUploadVideo: (file: File) => void;
  uploadProgress: UploadProgress | null;
  cameras: CameraDevice[];
  sessions: CameraSession[];
  onStartCamera: (deviceId: string) => Promise<void>;
  onStopCamera: (sessionId: string) => void;
  onClearAll: () => void;
  onOpenRecordings: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  connected,
  onUploadVideo,
  uploadProgress,
  cameras,
  sessions,
  onStartCamera,
  onStopCamera,
  onClearAll,
  onOpenRecordings,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [starting, setStarting] = useState(false);

  // Cameras not currently in an active session
  const activeDeviceIds = new Set(sessions.map((s) => s.deviceId));
  const inactiveCameras = cameras.filter((c) => !activeDeviceIds.has(c.deviceId));

  // True when no more cameras are available to start
  const allCamerasActive = cameras.length > 0 && inactiveCameras.length === 0;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onUploadVideo(file);
      e.target.value = '';
    }
  };

  const handleStartCamera = async () => {
    if (starting) return;
    setStarting(true);
    try {
      // Use the first known inactive device ID, or '' to let the browser pick
      await onStartCamera(inactiveCameras[0]?.deviceId ?? '');
    } finally {
      setStarting(false);
    }
  };

  const isUploading = uploadProgress !== null && uploadProgress.status === 'processing';
  const pct =
    uploadProgress && uploadProgress.total_frames > 0
      ? Math.round((uploadProgress.current_frame / uploadProgress.total_frames) * 100)
      : null;

  const cameraActive = sessions.length > 0;

  return (
    <header className="flex items-center justify-between px-6 py-3 bg-dash-panel border-b border-dash-border shrink-0 gap-4 flex-wrap">
      {/* Left: title */}
      <div className="flex items-center gap-3 shrink-0">
        <div className="w-2 h-8 bg-red-500 rounded-sm opacity-90" />
        <h1 className="font-mono text-sm font-bold tracking-[0.2em] text-gray-100 uppercase select-none">
          Anomaly Explanation Engine
        </h1>
      </div>

      {/* Right: status + controls */}
      <div className="flex items-center gap-4 flex-wrap">
        {/* Upload progress indicator */}
        {uploadProgress && (
          <div className="flex items-center gap-2 min-w-0">
            {isUploading && (
              <div className="w-3 h-3 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />
            )}
            {uploadProgress.status === 'done' && <span className="text-emerald-400 text-xs">✓</span>}
            {uploadProgress.status === 'error' && <span className="text-red-400 text-xs">✗</span>}
            <div className="flex flex-col gap-0.5 max-w-[160px]">
              <span className="font-mono text-[10px] text-gray-400 truncate">
                {uploadProgress.status === 'done'
                  ? 'Analysis complete'
                  : uploadProgress.status === 'error'
                  ? 'Upload failed'
                  : uploadProgress.filename}
              </span>
              {isUploading && pct !== null && (
                <div className="w-full h-1 bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-500 rounded-full transition-all duration-300"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              )}
            </div>
            {isUploading && pct !== null && (
              <span className="font-mono text-[10px] text-gray-600">{pct}%</span>
            )}
          </div>
        )}

        {/* Connection status */}
        <div className="flex items-center gap-2">
          <div
            className={`w-2.5 h-2.5 rounded-full transition-colors duration-300 ${
              connected
                ? 'bg-green-400 shadow-[0_0_6px_2px_rgba(74,222,128,0.5)]'
                : 'bg-red-500 shadow-[0_0_6px_2px_rgba(248,113,113,0.4)] animate-pulse-slow'
            }`}
          />
          <span className="font-mono text-xs tracking-widest text-gray-400 uppercase">
            {connected ? 'Connected' : 'Disconnected'}
          </span>
        </div>

        {/* Divider */}
        <div className="w-px h-5 bg-dash-border-bright shrink-0" />

        {/* Camera controls */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Active session stop buttons */}
          {sessions.map((session) => (
            <button
              key={session.sessionId}
              onClick={() => onStopCamera(session.sessionId)}
              className="flex items-center gap-2 font-mono text-xs font-semibold tracking-widest uppercase px-4 py-1.5 rounded
                border transition-all duration-200 select-none
                bg-red-900/40 border-red-700/60 text-red-300 hover:bg-red-900/60"
              title={`Stop ${session.label}`}
            >
              <div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse shrink-0" />
              <span className="max-w-[100px] truncate normal-case">{session.label}</span>
              <span>⏹ Stop</span>
            </button>
          ))}

          {/* Start Camera button — always visible; disabled only when all cameras already active */}
          <button
            onClick={handleStartCamera}
            disabled={starting || allCamerasActive}
            className="font-mono text-xs font-semibold tracking-widest uppercase px-4 py-1.5 rounded
              border transition-all duration-200 select-none
              bg-violet-900/30 border-violet-700/50 text-violet-300
              hover:bg-violet-900/50 hover:border-violet-600
              disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {starting ? '...' : '📷 Start Camera'}
          </button>
        </div>

        {/* Upload video */}
        <input
          ref={fileInputRef}
          type="file"
          accept="video/mp4,video/avi,video/mov,video/webm,video/quicktime"
          className="hidden"
          onChange={handleFileChange}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={isUploading || cameraActive}
          className="font-mono text-xs font-semibold tracking-widest uppercase px-4 py-1.5 rounded
            border transition-all duration-200 select-none
            bg-blue-900/30 border-blue-700/50 text-blue-300
            hover:bg-blue-900/50 hover:border-blue-600
            disabled:opacity-40 disabled:cursor-not-allowed"
        >
          ⬆ Upload Video
        </button>

        {/* Clear all incidents */}
        <button
          onClick={onClearAll}
          disabled={!connected}
          className="font-mono text-xs font-semibold tracking-widest uppercase px-4 py-1.5 rounded
            border transition-all duration-200 select-none
            bg-gray-900 border-gray-700 text-gray-500
            hover:border-gray-500 hover:text-gray-300
            disabled:opacity-30 disabled:cursor-not-allowed"
        >
          ✕ Clear All
        </button>

        {/* Recordings browser */}
        <button
          onClick={onOpenRecordings}
          className="font-mono text-xs font-semibold tracking-widest uppercase px-4 py-1.5 rounded
            border transition-all duration-200 select-none
            bg-violet-900/30 border-violet-700/50 text-violet-300
            hover:bg-violet-900/50 hover:border-violet-600"
        >
          ◉ Recordings
        </button>
      </div>
    </header>
  );
};
