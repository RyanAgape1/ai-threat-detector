export type EventSource = 'cv' | 'audio' | 'behavior' | 'custom';

export interface DetectionEvent {
  id: string;
  timestamp: number;
  source: EventSource;
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

export interface TimeRule {
  label: string;
  description: string;
  start_hour: number;
  end_hour: number;
  days?: number[];  // 0=Mon ... 6=Sun, empty/absent = every day
  thresholds?: Partial<EnvironmentConfig['thresholds']>;
  disabled_events?: string[];
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
  time_rules: TimeRule[];
  custom_events?: CustomEventDef[];
  zones?: Zone[];
}

/* ── Agent-designed detection events ─────────────────────────────────────── */

export type RuleKind =
  | 'dwell'
  | 'zone_count'
  | 'zone_vacant'
  | 'object_present'
  | 'proximity'
  | 'event_rate';

export type Importance = 'routine' | 'notable' | 'important';

export interface CustomEventDef {
  event_type: string;
  label: string;
  description: string;
  kind: RuleKind;
  params: Record<string, unknown>;
  zone: string | null;
  importance: Importance;
  enabled: boolean;
  created_by: string;
}

export interface Zone {
  name: string;
  description: string;
  x: number;
  y: number;
  w: number;
  h: number;
  needs_calibration: boolean;
}

export interface NeededEvent {
  purpose: string;
  /** Optional: a local model occasionally omits or misspells this field. */
  rationale?: string;
  suggested_kind: RuleKind;
  suggested_target: string;
  importance: Importance;
  needs_zone: boolean;
}

export interface BuiltinChange {
  event_type: string;
  action: 'enable' | 'disable';
  reason: string;
}

/** Output of the context analyst agent (read-only stage). */
export interface ContextAnalysis {
  context_understood: string;
  requires_changes: boolean;
  needed_events: NeededEvent[];
  builtin_changes: BuiltinChange[];
  unsupported_requests: string[];
}

/** Output of the event designer agent (writing stage). */
export interface DesignResult {
  analysis: ContextAnalysis;
  custom_events: CustomEventDef[];
  zones: Zone[];
  disabled_events: string[];
  explanation: string;
  errors: string[];
  applied: boolean;
}

/** GET /detection-events */
export interface DetectionEventsState {
  custom_events: CustomEventDef[];
  zones: Zone[];
  disabled_events: string[];
  effective_disabled_events: string[];
  builtin_events: string[];
  rule_kinds: Record<string, string>;
  object_classes: string[];
}

/** One live dwell timer. Display-only — never enters the activities array. */
export interface DwellTimer {
  event_type: string;
  label: string;
  identity: string;
  track_id: number | null;
  global_person_id: string | null;
  elapsed_seconds: number;
  elapsed_human: string;
  min_seconds: number;
  fired_count: number;
  out_of_sight: boolean;
}

export type WSMessage =
  | { type: 'all_activities'; activities: Activity[] }
  | { type: 'activity_opened'; activity: Activity }
  | { type: 'event_added'; activity_id: string; event: DetectionEvent; frame_b64?: string }
  | { type: 'reasoning_update'; activity_id: string; explanation: Explanation }
  | { type: 'activity_closed'; activity_id: string; summary: Explanation }
  | { type: 'dwell_timers'; camera_id: string; timers: DwellTimer[] }
  | ({ type: 'upload_progress' } & UploadProgress);
