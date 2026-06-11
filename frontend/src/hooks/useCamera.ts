import React, { useCallback, useEffect, useRef, useState } from 'react';

export interface CameraDevice {
  deviceId: string;
  label: string;
}

export interface CameraSession {
  sessionId: string;
  deviceId: string;
  label: string;
  stream: MediaStream;
  videoRef: React.RefObject<HTMLVideoElement>;
}

interface SessionInternals {
  deviceId: string;
  stream: MediaStream;
  frameInterval: ReturnType<typeof setInterval> | null;
  mediaRecorder: MediaRecorder | null;
  audioContext: AudioContext | null;
  analyser: AnalyserNode | null;
}

export interface UseCameraReturn {
  cameras: CameraDevice[];
  sessions: CameraSession[];
  startCamera: (deviceId: string) => Promise<void>;
  stopCamera: (sessionId: string) => void;
  stopAllCameras: () => void;
}

export function useCamera(): UseCameraReturn {
  const [cameras, setCameras] = useState<CameraDevice[]>([]);
  const [sessions, setSessions] = useState<CameraSession[]>([]);

  // Internals stored in ref — no re-renders needed
  const internalsRef = useRef<Map<string, SessionInternals>>(new Map());
  // Track active device IDs to prevent duplicate sessions
  const activeDeviceIds = useRef<Set<string>>(new Set());

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
    } catch {
      // Permission not yet granted
    }
  }, []);

  useEffect(() => {
    enumerateCameras();
  }, [enumerateCameras]);

  const stopCamera = useCallback((sessionId: string) => {
    const internals = internalsRef.current.get(sessionId);
    if (!internals) return;

    if (internals.frameInterval !== null) clearInterval(internals.frameInterval);
    if (internals.mediaRecorder?.state !== 'inactive') internals.mediaRecorder?.stop();
    internals.audioContext?.close().catch(() => {});
    internals.stream.getTracks().forEach((t) => t.stop());

    activeDeviceIds.current.delete(internals.deviceId);
    internalsRef.current.delete(sessionId);
    setSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));

    const fd = new FormData();
    fd.append('session_id', sessionId);
    fetch('http://localhost:8000/stream/reset', { method: 'POST', body: fd }).catch(() => {});
  }, []);

  const startCamera = useCallback(async (deviceId: string) => {
    // Non-empty device IDs can be deduplicated immediately; empty IDs
    // (before permission) are resolved to a real ID after getUserMedia.
    if (deviceId && activeDeviceIds.current.has(deviceId)) return;
    if (deviceId) activeDeviceIds.current.add(deviceId);

    try {
      // Acquire media stream (try with audio, fall back to video-only)
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: deviceId ? { deviceId: { exact: deviceId } } : true,
          audio: true,
        });
      } catch {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: deviceId ? { deviceId: { exact: deviceId } } : true,
          });
        } catch (err) {
          if (deviceId) activeDeviceIds.current.delete(deviceId);
          console.error('Camera access failed:', err);
          return;
        }
      }

      // After permission is granted the track exposes the real device ID and label.
      const videoTrack = stream.getVideoTracks()[0];
      const realDeviceId = videoTrack?.getSettings().deviceId ?? deviceId;
      const label = videoTrack?.label || cameras.find((c) => c.deviceId === realDeviceId)?.label || 'Camera';

      if (deviceId !== realDeviceId) {
        // Started with '' — swap placeholder for the real ID.
        activeDeviceIds.current.delete(deviceId);
        // Only now check for duplicates (camera already active via a prior session).
        if (activeDeviceIds.current.has(realDeviceId)) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        activeDeviceIds.current.add(realDeviceId);
      }
      // If deviceId === realDeviceId the slot was already claimed at the top of this
      // function — no add or duplicate check needed.

      // Re-enumerate so the camera list gets real device IDs for future pickers.
      enumerateCameras();

      // Register session with backend
      const startFd = new FormData();
      startFd.append('camera_label', label);
      let sessionId: string;
      try {
        const res = await fetch('http://localhost:8000/stream/start', {
          method: 'POST',
          body: startFd,
        });
        const data = await res.json() as { session_id: string };
        sessionId = data.session_id;
      } catch {
        activeDeviceIds.current.delete(realDeviceId);
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      // Video ref shared between this hook (frame capture) and the rendered component
      const videoRef = React.createRef<HTMLVideoElement>();

      const internals: SessionInternals = {
        deviceId: realDeviceId,
        stream,
        frameInterval: null,
        mediaRecorder: null,
        audioContext: null,
        analyser: null,
      };

      // Audio capture
      try {
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length > 0) {
          const audioCtx = new AudioContext();
          internals.audioContext = audioCtx;
          const source = audioCtx.createMediaStreamSource(stream);
          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 2048;
          source.connect(analyser);
          internals.analyser = analyser;

          const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus'
            : 'audio/webm';
          const mr = new MediaRecorder(stream, { mimeType });
          internals.mediaRecorder = mr;

          mr.ondataavailable = async (e) => {
            if (e.data.size < 500) return;
            const timeBuf = new Float32Array(analyser.fftSize);
            analyser.getFloatTimeDomainData(timeBuf);
            const rms = Math.sqrt(timeBuf.reduce((s, x) => s + x * x, 0) / timeBuf.length);
            const fd = new FormData();
            fd.append('audio', e.data, 'audio.webm');
            fd.append('rms', String(rms));
            fd.append('session_id', sessionId);
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

      // Register internals and add session to state (triggers render → video element created)
      internalsRef.current.set(sessionId, internals);
      const session: CameraSession = { sessionId, deviceId: realDeviceId, label, stream, videoRef };
      setSessions((prev) => [...prev, session]);

      // Wait for the video element to initialize before starting frame capture
      await new Promise<void>((resolve) => setTimeout(resolve, 700));

      internals.frameInterval = setInterval(() => {
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
            form.append('session_id', sessionId);
            try {
              await fetch('http://localhost:8000/stream/frame', { method: 'POST', body: form });
            } catch {
              // Backend unreachable — silently skip
            }
          },
          'image/jpeg',
          0.75,
        );
      }, 500);
    } catch (err) {
      if (deviceId) activeDeviceIds.current.delete(deviceId);
      console.error('startCamera failed:', err);
    }
  }, [cameras, enumerateCameras]);

  const stopAllCameras = useCallback(() => {
    const sessionIds = [...internalsRef.current.keys()];
    sessionIds.forEach(stopCamera);
  }, [stopCamera]);

  // Cleanup all sessions on unmount
  useEffect(() => {
    return () => {
      internalsRef.current.forEach((internals, sessionId) => {
        if (internals.frameInterval !== null) clearInterval(internals.frameInterval);
        if (internals.mediaRecorder?.state !== 'inactive') internals.mediaRecorder?.stop();
        internals.audioContext?.close().catch(() => {});
        internals.stream.getTracks().forEach((t) => t.stop());
        const fd = new FormData();
        fd.append('session_id', sessionId);
        fetch('http://localhost:8000/stream/reset', { method: 'POST', body: fd }).catch(() => {});
      });
      internalsRef.current.clear();
    };
  }, []);

  return { cameras, sessions, startCamera, stopCamera, stopAllCameras };
}
