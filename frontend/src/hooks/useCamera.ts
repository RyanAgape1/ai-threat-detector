import { useCallback, useEffect, useRef, useState } from 'react';

export interface CameraDevice {
  deviceId: string;
  label: string;
}

export interface UseCameraReturn {
  cameras: CameraDevice[];
  selectedCameraId: string;
  setSelectedCameraId: (id: string) => void;
  cameraActive: boolean;
  cameraStream: MediaStream | null;
  videoRef: React.RefObject<HTMLVideoElement>;
  startCamera: () => Promise<void>;
  stopCamera: () => void;
}

export function useCamera(): UseCameraReturn {
  const [cameras, setCameras] = useState<CameraDevice[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string>('');
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const frameNumRef = useRef(0);

  // Audio capture refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);

  const enumerateCameras = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = devices
        .filter((d) => d.kind === 'videoinput')
        .map((d, i) => ({
          deviceId: d.deviceId,
          label: d.label || `Camera ${i + 1}`,
        }));
      setCameras(videoInputs);
      setCameraActive((active) => {
        if (!active && videoInputs.length > 0) {
          setSelectedCameraId((cur) => cur || videoInputs[0].deviceId);
        }
        return active;
      });
    } catch {
      // Permission not yet granted — labels will be empty strings, that's fine
    }
  }, []);

  useEffect(() => {
    enumerateCameras();
  }, [enumerateCameras]);

  const startCamera = useCallback(async () => {
    try {
      // Request video + audio together; fall back to video-only if mic is denied
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: selectedCameraId ? { deviceId: { exact: selectedCameraId } } : true,
          audio: true,
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({
          video: selectedCameraId ? { deviceId: { exact: selectedCameraId } } : true,
        });
      }

      streamRef.current = stream;
      setCameraStream(stream);
      setCameraActive(true);
      enumerateCameras();

      // ── Audio capture (isolated — failures must not prevent frame capture) ──
      try {
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length > 0) {
          const audioCtx = new AudioContext();
          audioContextRef.current = audioCtx;
          const source = audioCtx.createMediaStreamSource(stream);
          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 2048;
          source.connect(analyser);
          analyserRef.current = analyser;

          const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus'
            : 'audio/webm';
          const mr = new MediaRecorder(stream, { mimeType });
          mediaRecorderRef.current = mr;

          mr.ondataavailable = async (e) => {
            if (e.data.size < 500) return;

            const timeBuf = new Float32Array(analyser.fftSize);
            analyser.getFloatTimeDomainData(timeBuf);
            const rms = Math.sqrt(timeBuf.reduce((s, x) => s + x * x, 0) / timeBuf.length);

            const fd = new FormData();
            fd.append('audio', e.data, 'audio.webm');
            fd.append('rms', String(rms));
            try {
              await fetch('http://localhost:8000/stream/audio', { method: 'POST', body: fd });
            } catch {
              // Backend unreachable — skip
            }
          };

          mr.start(2000);
        }
      } catch (audioErr) {
        console.warn('Audio capture setup failed, continuing video-only:', audioErr);
      }

      // ── Video frame capture ────────────────────────────────────────────
      await new Promise<void>((resolve) => setTimeout(resolve, 600));
      frameNumRef.current = 0;

      frameIntervalRef.current = setInterval(() => {
        const video = videoRef.current;
        if (!video || video.readyState < 2 || video.videoWidth === 0) return;

        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(video, 0, 0);

        canvas.toBlob(
          async (blob) => {
            if (!blob) return;
            const form = new FormData();
            form.append('frame', blob, 'frame.jpg');
            try {
              await fetch('http://localhost:8000/stream/frame', { method: 'POST', body: form });
            } catch {
              // Backend unreachable — silently skip
            }
            frameNumRef.current += 1;
          },
          'image/jpeg',
          0.75,
        );
      }, 500); // 2 fps to backend
    } catch (err) {
      console.error('Camera access failed:', err);
    }
  }, [selectedCameraId, enumerateCameras]);

  const stopCamera = useCallback(() => {
    // Stop frame capture
    if (frameIntervalRef.current) {
      clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }

    // Stop audio capture
    if (mediaRecorderRef.current?.state !== 'inactive') {
      mediaRecorderRef.current?.stop();
    }
    mediaRecorderRef.current = null;

    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    analyserRef.current = null;

    // Stop all media tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    setCameraStream(null);
    setCameraActive(false);
    frameNumRef.current = 0;

    fetch('http://localhost:8000/stream/reset', { method: 'POST' }).catch(() => {});
  }, []);

  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, [stopCamera]);

  return {
    cameras,
    selectedCameraId,
    setSelectedCameraId,
    cameraActive,
    cameraStream,
    videoRef,
    startCamera,
    stopCamera,
  };
}
