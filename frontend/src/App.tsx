import React, { useEffect, useState } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useCamera } from './hooks/useCamera';
import { useResolutions } from './hooks/useResolutions';
import { useRecordings } from './hooks/useRecordings';
import { TopBar } from './components/TopBar';
import { IncidentFeed } from './components/IncidentFeed';
import { ReasoningPanel } from './components/ReasoningPanel';
import { RecordingsModal } from './components/RecordingsModal';
import { ReportTab } from './components/ReportTab';
import { EnvironmentSetup } from './components/EnvironmentSetup';

const App: React.FC = () => {
  const {
    activities, connected, selectedId, setSelectedId,
    uploadVideo, uploadProgress, videoUrl, snapshots, clearAll,
  } = useWebSocket();

  const {
    cameras, sessions, startCamera, stopCamera,
  } = useCamera();
  const cameraActive = sessions.length > 0;

  const [cameraFilter, setCameraFilter] = useState<string | null>(null);
  // Clear filter if the filtered camera session is stopped
  useEffect(() => {
    if (cameraFilter && !sessions.some((s) => s.sessionId === cameraFilter)) {
      setCameraFilter(null);
    }
  }, [sessions, cameraFilter]);

  const { resolutions, resolve } = useResolutions();
  const { recordings, loading: recordingsLoading, refresh: refreshRecordings, deleteRecording, getVideoUrl, fetchActivities } = useRecordings();
  const [recordingsOpen, setRecordingsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'log' | 'report' | 'env'>('log');

  // Auto-refresh recordings shortly after camera stops so the new recording is available
  useEffect(() => {
    if (!cameraActive) {
      const t = setTimeout(() => void refreshRecordings(), 1500);
      return () => clearTimeout(t);
    }
  }, [cameraActive, refreshRecordings]);

  const selectedActivity = activities.find((a) => a.id === selectedId) ?? null;

  // Find the recording that covers the selected activity's time range.
  // Works for both active and closed activities so seek works before reasoning finishes.
  const matchingRecording =
    selectedActivity !== null && !cameraActive
      ? (recordings.find(
          (r) =>
            r.started_at <= selectedActivity.started_at + 5 &&
            r.ended_at >= (selectedActivity.closed_at ?? selectedActivity.started_at) - 5,
        ) ?? null)
      : null;

  // When a matching recording exists, show it in the video panel instead of the upload blob
  const effectiveVideoUrl = matchingRecording ? getVideoUrl(matchingRecording.id) : videoUrl;
  const recordingStartedAt = matchingRecording?.started_at ?? null;

  return (
    <div className="flex flex-col h-screen bg-dash-bg text-gray-100 overflow-hidden">
      <TopBar
        connected={connected}
        onUploadVideo={uploadVideo}
        uploadProgress={uploadProgress}
        cameras={cameras}
        sessions={sessions}
        onStartCamera={startCamera}
        onStopCamera={stopCamera}
        onClearAll={clearAll}
        onOpenRecordings={() => setRecordingsOpen(true)}
      />
      {/* Tab bar */}
      <div className="flex shrink-0 border-b border-dash-border bg-dash-panel px-4">
        {([
          { id: 'log', label: 'Activity Log' },
          { id: 'report', label: 'Activity Report' },
          { id: 'env', label: 'Environment' },
        ] as const).map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`font-mono text-xs font-semibold tracking-widest uppercase px-4 py-2.5
              border-b-2 transition-colors duration-150 select-none
              ${activeTab === tab.id
                ? 'border-blue-500 text-blue-300'
                : 'border-transparent text-gray-500 hover:text-gray-300'}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex flex-1 overflow-hidden">
        {activeTab === 'log' ? (
          <>
            <IncidentFeed
              activities={activities}
              selectedId={selectedId}
              onSelect={setSelectedId}
              resolutions={resolutions}
              cameraFilter={cameraFilter}
            />
            <ReasoningPanel
              activity={selectedActivity}
              videoUrl={cameraActive ? null : effectiveVideoUrl}
              cameraSessions={sessions}
              snapshots={snapshots}
              resolution={selectedActivity ? (resolutions[selectedActivity.id] ?? null) : null}
              onResolve={(decision) => selectedActivity && resolve(selectedActivity.id, decision)}
              recordingStartedAt={recordingStartedAt}
              cameraFilter={cameraFilter}
              onCameraFilterChange={setCameraFilter}
            />
          </>
        ) : activeTab === 'report' ? (
          <ReportTab />
        ) : (
          <EnvironmentSetup />
        )}
      </div>

      <RecordingsModal
        open={recordingsOpen}
        onClose={() => setRecordingsOpen(false)}
        recordings={recordings}
        loading={recordingsLoading}
        onRefresh={refreshRecordings}
        onDelete={deleteRecording}
        getVideoUrl={getVideoUrl}
        fetchActivities={fetchActivities}
      />
    </div>
  );
};

export default App;
