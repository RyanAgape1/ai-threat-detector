import { useState, useCallback } from 'react';

export interface Recording {
  id: string;
  started_at: number;
  ended_at: number;
  filename: string;
  duration_seconds: number;
  frame_count: number;
  filesize_bytes: number;
}

export function useRecordings() {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('http://localhost:8000/recordings');
      if (res.ok) {
        setRecordings(await res.json() as Recording[]);
      }
    } catch (err) {
      console.error('Failed to fetch recordings:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const deleteRecording = useCallback(async (id: string) => {
    try {
      const res = await fetch(`http://localhost:8000/recordings/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setRecordings((prev) => prev.filter((r) => r.id !== id));
      }
    } catch (err) {
      console.error('Failed to delete recording:', err);
    }
  }, []);

  const getVideoUrl = useCallback(
    (id: string) => `http://localhost:8000/recordings/${id}/video`,
    [],
  );

  return { recordings, loading, refresh, deleteRecording, getVideoUrl };
}
