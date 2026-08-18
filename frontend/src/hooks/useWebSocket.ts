import { useEffect, useRef, useState, useCallback } from 'react';
import type { Activity, DwellTimer, UploadProgress, WSMessage } from '../types';

const WS_URL = 'ws://localhost:8000/ws';
const RECONNECT_DELAY = 3000;

export interface UseWebSocketReturn {
  activities: Activity[];
  connected: boolean;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  uploadVideo: (file: File) => Promise<void>;
  uploadProgress: UploadProgress | null;
  videoUrl: string | null;
  snapshots: Record<string, string>;
  dwellTimers: Record<string, DwellTimer[]>;
  clearAll: () => Promise<void>;
}

export function useWebSocket(): UseWebSocketReturn {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [connected, setConnected] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<Record<string, string>>({});
  // camera_id -> live dwell timers. Separate from activities on purpose.
  const [dwellTimers, setDwellTimers] = useState<Record<string, DwellTimer[]>>({});
  const videoBlobRef = useRef<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  // True only for the very first connection after page load.
  // On that first sync we ignore backend history so the UI starts clean.
  // On subsequent reconnects (same session) we DO restore state.
  const isPageLoadRef = useRef(true);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;
    if (wsRef.current && wsRef.current.readyState === WebSocket.CONNECTING) return;

    try {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mountedRef.current) return;
        setConnected(true);
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
      };

      ws.onmessage = (event: MessageEvent) => {
        if (!mountedRef.current) return;
        let msg: WSMessage;
        try {
          msg = JSON.parse(event.data as string) as WSMessage;
        } catch {
          console.error('Failed to parse WS message:', event.data);
          return;
        }

        switch (msg.type) {
          case 'all_activities':
            if (isPageLoadRef.current) {
              // First sync after page load — start with a clean slate
              isPageLoadRef.current = false;
              setActivities([]);
            } else {
              // Reconnect during the same session — restore live state
              setActivities([...msg.activities].reverse());
            }
            break;

          case 'activity_opened':
            setActivities((prev) => [msg.activity, ...prev]);
            break;

          case 'event_added':
            setActivities((prev) =>
              prev.map((a) =>
                a.id === msg.activity_id
                  ? { ...a, events: [...a.events, msg.event] }
                  : a
              )
            );
            if (msg.frame_b64) {
              setSnapshots((prev) => ({ ...prev, [msg.event.id]: msg.frame_b64! }));
            }
            break;

          case 'reasoning_update':
            setActivities((prev) =>
              prev.map((a) =>
                a.id === msg.activity_id
                  ? { ...a, latest_explanation: msg.explanation }
                  : a
              )
            );
            break;

          case 'activity_closed':
            setActivities((prev) =>
              prev.map((a) =>
                a.id === msg.activity_id
                  ? {
                      ...a,
                      status: 'closed',
                      summary: msg.summary,
                      closed_at: a.closed_at ?? Date.now() / 1000,
                    }
                  : a
              )
            );
            break;

          case 'dwell_timers':
            // Kept in its own state, deliberately NOT merged into activities —
            // these arrive every second and are display-only.
            setDwellTimers((prev) => {
              const next = { ...prev };
              if (msg.timers.length === 0) delete next[msg.camera_id];
              else next[msg.camera_id] = msg.timers;
              return next;
            });
            break;

          case 'upload_progress':
            setUploadProgress({
              job_id: msg.job_id,
              filename: msg.filename,
              current_frame: msg.current_frame,
              total_frames: msg.total_frames,
              status: msg.status,
              error: msg.error,
            });
            if (msg.status === 'done' || msg.status === 'error') {
              setTimeout(() => setUploadProgress(null), 3000);
            }
            break;
        }
      };

      ws.onerror = () => {
        // error will be followed by close
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;
        setConnected(false);
        setActivities([]);
        setSelectedId(null);
        setDwellTimers({});
        // Don't clear snapshots here — if the WS reconnects during the same
        // session, all_activities restores the events but frame data isn't
        // re-sent. Keeping snapshots means clicking events still shows frames.
        wsRef.current = null;
        reconnectTimerRef.current = setTimeout(() => {
          connect();
        }, RECONNECT_DELAY);
      };
    } catch (err) {
      console.error('WS connection error:', err);
      reconnectTimerRef.current = setTimeout(() => {
        connect();
      }, RECONNECT_DELAY);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, [connect]);

  const uploadVideo = useCallback(async (file: File) => {
    if (videoBlobRef.current) {
      URL.revokeObjectURL(videoBlobRef.current);
    }
    const url = URL.createObjectURL(file);
    videoBlobRef.current = url;
    setVideoUrl(url);

    const formData = new FormData();
    formData.append('file', file);
    setUploadProgress({
      job_id: '',
      filename: file.name,
      current_frame: 0,
      total_frames: 0,
      status: 'processing',
    });
    try {
      await fetch('http://localhost:8000/upload', { method: 'POST', body: formData });
    } catch (err) {
      console.error('Upload failed:', err);
      setUploadProgress(null);
    }
  }, []);

  const clearAll = useCallback(async () => {
    setActivities([]);
    setSelectedId(null);
    setSnapshots({});
    setDwellTimers({});
    try {
      const res = await fetch('http://localhost:8000/activities/clear', { method: 'POST' });
      if (!res.ok) console.error('Clear failed:', res.status, await res.text());
    } catch (err) {
      console.error('Clear request failed:', err);
    }
  }, []);

  return { activities, connected, selectedId, setSelectedId, uploadVideo, uploadProgress, videoUrl, snapshots, dwellTimers, clearAll };
}
