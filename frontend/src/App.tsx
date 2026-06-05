import React, { useEffect, useState } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useCamera } from './hooks/useCamera';
import { useResolutions } from './hooks/useResolutions';
import { useRecordings } from './hooks/useRecordings';
import { TopBar } from './components/TopBar';
import { IncidentFeed } from './components/IncidentFeed';
import { ReasoningPanel } from './components/ReasoningPanel';
import { RecordingsModal } from './components/RecordingsModal';

const App: React.FC = () => {
  const {
    activities, connected, selectedId, setSelectedId,
    uploadVideo, uploadProgress, videoUrl, snapshots, clearAll,
  } = useWebSocket();

  const {
    cameras, selectedCameraId, setSelectedCameraId,
    cameraActive, cameraStream, videoRef,
    startCamera, stopCamera,
  } = useCamera();

  const { resolutions, resolve } = useResolutions();
  const { recordings, loading: recordingsLoading, refresh: refreshRecordings, deleteRecording, getVideoUrl } = useRecordings();
  const [recordingsOpen, setRecordingsOpen] = useState(false);

  // Auto-refresh recordings shortly after camera stops so the new recording is available
  useEffect(() => {
    if (!cameraActive) {
      const t = setTimeout(() => void refreshRecordings(), 1500);
      return () => clearTimeout(t);
    }
  }, [cameraActive, refreshRecordings]);

  const selectedActivity = activities.find((a) => a.id === selectedId) ?? null;

  // Find the recording that covers the selected (closed) activity's time range
  const matchingRecording =
    selectedActivity?.status === 'closed' && !cameraActive
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
        selectedCameraId={selectedCameraId}
        onSelectCamera={setSelectedCameraId}
        cameraActive={cameraActive}
        onStartCamera={startCamera}
        onStopCamera={stopCamera}
        onClearAll={clearAll}
        onOpenRecordings={() => setRecordingsOpen(true)}
      />
      <div className="flex flex-1 overflow-hidden">
        <IncidentFeed
          activities={activities}
          selectedId={selectedId}
          onSelect={setSelectedId}
          resolutions={resolutions}
        />
        <ReasoningPanel
          activity={selectedActivity}
          videoUrl={cameraActive ? null : effectiveVideoUrl}
          cameraStream={cameraStream}
          videoRef={videoRef}
          snapshots={snapshots}
          resolution={selectedActivity ? (resolutions[selectedActivity.id] ?? null) : null}
          onResolve={(decision) => selectedActivity && resolve(selectedActivity.id, decision)}
          recordingStartedAt={recordingStartedAt}
        />
      </div>

      <RecordingsModal
        open={recordingsOpen}
        onClose={() => setRecordingsOpen(false)}
        recordings={recordings}
        loading={recordingsLoading}
        onRefresh={refreshRecordings}
        onDelete={deleteRecording}
        getVideoUrl={getVideoUrl}
      />
    </div>
  );
};

export default App;
