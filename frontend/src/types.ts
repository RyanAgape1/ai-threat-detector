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

export interface ReportEvent {
  id: string;
  activity_id: string;
  timestamp: number;
  source: string;
  type: string;
  confidence: number;
  metadata: Record<string, unknown>;
  recording_id?: string;
}

export interface PersonJourney {
  global_person_id: string;
  camera_path: string[];
  events: ReportEvent[];
}

export interface Report {
  id: string;
  generated_at: number;
  time_from: number;
  time_to: number;
  narrative: string;
  important_events: ReportEvent[];
  person_journeys: PersonJourney[];
}

export interface ReportSummary {
  id: string;
  generated_at: number;
  time_from: number;
  time_to: number;
  narrative_preview: string;
}

export interface EnvironmentConfig {
  environment_type: string;
  description: string;
  thresholds: {
    person_confidence: number;
    bag_confidence: number;
    vehicle_confidence: number;
    crowd_min_persons: number;
    rapid_motion_threshold: number;
    movement_threshold: number;
    loitering_seconds: number;
    reid_area_gate: number;
    reid_min_frames: number;
  };
  disabled_events: string[];
}

export type WSMessage =
  | { type: 'all_activities'; activities: Activity[] }
  | { type: 'activity_opened'; activity: Activity }
  | { type: 'event_added'; activity_id: string; event: DetectionEvent; frame_b64?: string }
  | { type: 'reasoning_update'; activity_id: string; explanation: Explanation }
  | { type: 'activity_closed'; activity_id: string; summary: Explanation }
  | ({ type: 'upload_progress' } & UploadProgress);
