export interface DetectionEvent {
  id: string;
  timestamp: number;
  source: 'cv' | 'audio' | 'behavior';
  type: string;
  confidence: number;
  metadata: Record<string, unknown>;
}

export interface Explanation {
  summary: string;
  evidence_for: string[];
  evidence_against: string[];
  confidence: number;
  confidence_trend: 'increasing' | 'decreasing' | 'stable';
  threat_level: 'low' | 'medium' | 'high' | 'critical';
  open_questions: string[];
  recommended_action: string;
}

export interface Activity {
  id: string;
  started_at: number;
  closed_at: number | null;
  status: 'active' | 'closed';
  events: DetectionEvent[];
  latest_explanation: Explanation | null;
  summary: Explanation | null;
  camera_id: string | null;
}

export interface UploadProgress {
  job_id: string;
  filename: string;
  current_frame: number;
  total_frames: number;
  status: 'processing' | 'done' | 'error';
  error?: string;
}

export type WSMessage =
  | { type: 'all_activities'; activities: Activity[] }
  | { type: 'activity_opened'; activity: Activity }
  | { type: 'event_added'; activity_id: string; event: DetectionEvent; frame_b64?: string }
  | { type: 'reasoning_update'; activity_id: string; explanation: Explanation }
  | { type: 'activity_closed'; activity_id: string; summary: Explanation }
  | ({ type: 'upload_progress' } & UploadProgress);
