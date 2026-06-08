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

export interface StoredEvent {
  id: string;
  activity_id: string;
  timestamp: number;
  source: string;
  type: string;
  confidence: number;
  metadata: Record<string, unknown>;
}

export interface StoredExplanation {
  summary: string;
  confidence: number;
  threat_level: 'low' | 'medium' | 'high' | 'critical';
  evidence_for: string[];
  evidence_against: string[];
  recommended_action: string;
  open_questions: string[];
  confidence_trend: string;
  created_at?: number;
}

export interface StoredActivity {
  id: string;
  started_at: number;
  closed_at: number | null;
  status: string;
  summary: StoredExplanation | null;
  events: StoredEvent[];
  explanations: StoredExplanation[];
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

  const fetchActivities = useCallback(async (recordingId: string): Promise<StoredActivity[]> => {
    try {
      const res = await fetch(`http://localhost:8000/recordings/${recordingId}/activities`);
      if (res.ok) return await res.json() as StoredActivity[];
      return [];
    } catch {
      return [];
    }
  }, []);

  return { recordings, loading, refresh, deleteRecording, getVideoUrl, fetchActivities };
}
