import React, { useEffect, useState } from 'react';
import { EnvironmentConfig, TimeRule } from '../types';
import type { CameraSession } from '../hooks/useCamera';
import { DetectionEventsPanel } from './DetectionEventsPanel';
import { GuideHighlight } from './GuideHighlight';

function isRuleActive(rule: TimeRule): boolean {
  const now = new Date();
  const hour = now.getHours();
  // getDay() returns 0=Sun ... 6=Sat; convert to 0=Mon ... 6=Sun to match backend
  const weekday = (now.getDay() + 6) % 7;
  const { start_hour: s, end_hour: e } = rule;

  // Check days first — empty/absent means every day
  if (rule.days && rule.days.length > 0 && !rule.days.includes(weekday)) return false;

  // start === end is the all-day sentinel
  if (s === e) return true;
  return s < e ? hour >= s && hour < e : hour >= s || hour < e;
}

function fmtHour(h: number): string {
  const ampm = h < 12 ? 'AM' : 'PM';
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}${ampm}`;
}

const API = 'http://localhost:8000';
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const ENV_TYPES = [
  { id: 'mall', label: 'Shopping Mall', desc: 'High foot traffic retail' },
  { id: 'warehouse', label: 'Warehouse', desc: 'Industrial, vehicles, packages' },
  { id: 'airport', label: 'Airport', desc: 'Transit hub, security-critical' },
  { id: 'parking_lot', label: 'Parking Lot', desc: 'Vehicles, low foot traffic' },
  { id: 'school', label: 'School / Campus', desc: 'After-hours monitoring' },
  { id: 'office', label: 'Office Building', desc: 'Corporate, low baseline' },
  { id: 'generic', label: 'Generic', desc: 'Balanced default settings' },
  { id: 'other', label: 'Other', desc: 'Describe your own environment' },
];

const THRESHOLD_LABELS: Record<string, string> = {
  person_confidence: 'Person confidence',
  bag_confidence: 'Bag confidence',
  vehicle_confidence: 'Vehicle confidence',
  crowd_min_persons: 'Crowd min persons',
  rapid_motion_threshold: 'Rapid motion threshold',
  movement_threshold: 'Movement threshold',
  loitering_seconds: 'Loitering (seconds)',
  reid_area_gate: 'Re-ID area gate',
  reid_min_frames: 'Re-ID min frames',
};


const GUIDE_STEPS = ['type', 'hours', 'notes', 'configure', 'events'] as const;
type GuideStep = (typeof GUIDE_STEPS)[number];

/** What the operator is being asked to do, in their language rather than ours. */
const GUIDE_LABELS: Record<GuideStep, string> = {
  type: 'Pick the kind of place these cameras are watching.',
  hours: 'Add the hours you are open and the days you trade.',
  notes: 'Say what you actually want watched, in your own words.',
  configure: 'Press "Configure with AI" to apply all of that.',
  events: 'Analyse what you wrote, then install the alerts it suggests.',
};

interface EnvironmentSetupProps {
  /** Live camera sessions, so zone calibration can preview against the real view. */
  cameraSessions?: CameraSession[];
  /** Arrived here from the setup guide — walk them through the fields in order. */
  guided?: boolean;
}

export const EnvironmentSetup: React.FC<EnvironmentSetupProps> = ({
  cameraSessions = [], guided = false,
}) => {
  const [currentConfig, setCurrentConfig] = useState<EnvironmentConfig | null>(null);
  const [selectedEnvType, setSelectedEnvType] = useState('');
  const [customEnvType, setCustomEnvType] = useState('');
  const [businessOpen, setBusinessOpen] = useState('');
  const [businessClose, setBusinessClose] = useState('');
  const [businessDays, setBusinessDays] = useState<number[]>([]);
  const [concerns, setConcerns] = useState('');
  const [context, setContext] = useState('');
  const [loading, setLoading] = useState(false);
  const [explanation, setExplanation] = useState('');
  const [error, setError] = useState('');

  // Walkthrough progress. A step counts as done when the operator has actually
  // acted on it — the optional ones can also be waved past with Skip, so nobody
  // is stuck on a field they do not want to fill.
  const [typeTouched, setTypeTouched] = useState(false);
  const [configuredOnce, setConfiguredOnce] = useState(false);
  const [eventsInstalled, setEventsInstalled] = useState(false);
  const [skipped, setSkipped] = useState<GuideStep[]>([]);
  const [guideOn, setGuideOn] = useState(guided);

  const fetchConfig = async () => {
    try {
      const res = await fetch(`${API}/environment/config`);
      if (res.ok) {
        const cfg: EnvironmentConfig = await res.json();
        setCurrentConfig(cfg);
        setSelectedEnvType(cfg.environment_type);
      }
    } catch {
      // backend may not be running yet
    }
  };

  useEffect(() => { void fetchConfig(); }, []);

  const handleConfigure = async () => {
    if (!selectedEnvType) { setError('Select an environment type first.'); return; }
    if (selectedEnvType === 'other' && !customEnvType.trim()) {
      setError('Describe your environment in the text field below.');
      return;
    }
    const envType = selectedEnvType === 'other' ? customEnvType.trim() : selectedEnvType;
    setLoading(true);
    setError('');
    setExplanation('');
    try {
      const res = await fetch(`${API}/environment/configure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          env_type: envType,
          concerns,
          context,
          business_hours_open: businessOpen || null,
          business_hours_close: businessClose || null,
          business_days: businessDays.length > 0 ? businessDays : null,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text);
      }
      const data: { config: EnvironmentConfig; explanation: string } = await res.json();
      setCurrentConfig(data.config);
      setExplanation(data.explanation);
      setConfiguredOnce(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  // environment_type comes back as 'generic' by default, so a fetched value is
  // not evidence the operator chose anything.
  const stepDone: Record<GuideStep, boolean> = {
    type: typeTouched || (!!currentConfig && currentConfig.environment_type !== 'generic'),
    hours: !!(businessOpen && businessClose) || businessDays.length > 0,
    notes: !!(concerns.trim() || context.trim()),
    configure: configuredOnce,
    events: eventsInstalled,
  };
  const activeStep = guideOn
    ? GUIDE_STEPS.find((step) => !stepDone[step] && !skipped.includes(step)) ?? null
    : null;
  const stepNumber = activeStep ? GUIDE_STEPS.indexOf(activeStep) + 1 : GUIDE_STEPS.length;

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* ── Left: questionnaire ── */}
      <div className="w-1/2 flex flex-col gap-5 p-6 overflow-y-auto border-r border-dash-border">
        <div>
          <h2 className="font-mono text-xs font-semibold text-gray-300 tracking-widest uppercase mb-1">
            Environment Setup
          </h2>
          <p className="text-xs text-gray-500">
            Tell the AI agent what environment this system monitors and it will tune detection
            thresholds and create custom rules accordingly.
          </p>
        </div>

        {guideOn && (
          <div className="rounded border border-blue-500/30 bg-blue-500/5 p-3 flex items-start gap-3">
            <span className="font-mono text-xs text-blue-300 shrink-0 pt-0.5">
              {activeStep ? `${stepNumber}/${GUIDE_STEPS.length}` : 'done'}
            </span>
            <p className="text-xs text-gray-300 flex-1 leading-relaxed">
              {activeStep
                ? GUIDE_LABELS[activeStep]
                : 'That is everything — the system is set up for this place.'}
            </p>
            {activeStep && (
              <button
                onClick={() => setSkipped((prev) => [...prev, activeStep])}
                className="text-xs font-mono text-gray-500 hover:text-gray-300 transition-colors shrink-0"
              >
                skip
              </button>
            )}
            <button
              onClick={() => setGuideOn(false)}
              className="text-xs font-mono text-gray-600 hover:text-gray-400 transition-colors shrink-0"
            >
              {activeStep ? 'exit' : 'dismiss'}
            </button>
          </div>
        )}

        {/* Environment type grid */}
        <GuideHighlight active={activeStep === 'type'} className="p-1 -m-1">
          <p className="text-xs text-gray-400 mb-2">Select environment type</p>
          <div className="grid grid-cols-2 gap-2">
            {ENV_TYPES.map((et) => (
              <button
                key={et.id}
                onClick={() => { setSelectedEnvType(et.id); setTypeTouched(true); }}
                className={`p-3 rounded border text-left transition-colors duration-100 select-none ${
                  selectedEnvType === et.id
                    ? 'border-blue-500 bg-blue-500/10 text-blue-300'
                    : 'border-dash-border bg-dash-panel text-gray-300 hover:border-gray-500 hover:text-gray-200'
                }`}
              >
                <div className="text-xs font-semibold">{et.label}</div>
                <div className="text-xs text-gray-500 mt-0.5">{et.desc}</div>
              </button>
            ))}
          </div>
          {selectedEnvType === 'other' && (
            <input
              autoFocus
              type="text"
              value={customEnvType}
              onChange={(e) => setCustomEnvType(e.target.value)}
              placeholder="e.g. hotel lobby, casino floor, hospital, train station..."
              className="mt-2 w-full bg-dash-bg border border-blue-500/50 rounded p-2 text-xs text-gray-200 focus:outline-none focus:border-blue-400 placeholder-gray-600"
            />
          )}
        </GuideHighlight>

        {/* Business hours */}
        <GuideHighlight active={activeStep === 'hours'} className="p-1 -m-1">
          <label className="text-xs text-gray-400 block mb-1">
            Business hours <span className="text-gray-600">(optional — if set, the agent will use these exact hours for time rules)</span>
          </label>
          <div className="flex items-center gap-2">
            <input
              type="time"
              value={businessOpen}
              onChange={(e) => setBusinessOpen(e.target.value)}
              className="bg-dash-bg border border-dash-border rounded p-2 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
            />
            <span className="text-xs text-gray-500">to</span>
            <input
              type="time"
              value={businessClose}
              onChange={(e) => setBusinessClose(e.target.value)}
              className="bg-dash-bg border border-dash-border rounded p-2 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
            />
            {(businessOpen || businessClose) && (
              <button
                onClick={() => { setBusinessOpen(''); setBusinessClose(''); setBusinessDays([]); }}
                className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
              >
                clear
              </button>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-2 flex-wrap">
            {DAY_LABELS.map((label, i) => (
              <button
                key={i}
                onClick={() => setBusinessDays((prev) =>
                  prev.includes(i) ? prev.filter((d) => d !== i) : [...prev, i].sort()
                )}
                className={`px-2 py-0.5 rounded text-xs font-mono border transition-colors select-none ${
                  businessDays.includes(i)
                    ? 'border-blue-500 bg-blue-500/15 text-blue-300'
                    : 'border-dash-border text-gray-500 hover:border-gray-500 hover:text-gray-300'
                }`}
              >
                {label}
              </button>
            ))}
            <button
              onClick={() => setBusinessDays([0, 1, 2, 3, 4])}
              className="px-2 py-0.5 rounded text-xs border border-dash-border text-gray-600 hover:text-gray-400 hover:border-gray-500 transition-colors select-none"
            >
              Weekdays
            </button>
          </div>
        </GuideHighlight>

        {/* Concerns and context — one step, since the agents read them together */}
        <GuideHighlight active={activeStep === 'notes'} className="flex flex-col gap-5 p-1 -m-1">
        <div>
          <label className="text-xs text-gray-400 block mb-1">
            Primary security concerns <span className="text-gray-600">(optional)</span>
          </label>
          <textarea
            value={concerns}
            onChange={(e) => setConcerns(e.target.value)}
            placeholder="e.g. shoplifting, after-hours intrusion, package theft, vehicle break-ins..."
            className="w-full bg-dash-bg border border-dash-border rounded p-2 text-xs text-gray-200 h-16 resize-none focus:outline-none focus:border-blue-500 placeholder-gray-600"
          />
        </div>

        {/* Context */}
        <div>
          <label className="text-xs text-gray-400 block mb-1">
            Additional context <span className="text-gray-600">(optional)</span>
          </label>
          <textarea
            value={context}
            onChange={(e) => setContext(e.target.value)}
            placeholder="e.g. cameras cover main entrance and parking lot, high theft risk area, near public transit..."
            className="w-full bg-dash-bg border border-dash-border rounded p-2 text-xs text-gray-200 h-16 resize-none focus:outline-none focus:border-blue-500 placeholder-gray-600"
          />
        </div>
        </GuideHighlight>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <GuideHighlight active={activeStep === 'configure'} className="self-start p-1 -m-1">
          <button
            onClick={() => void handleConfigure()}
            disabled={loading || !selectedEnvType}
            className="px-4 py-2 bg-blue-600 text-white text-xs font-semibold rounded hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? 'Configuring...' : 'Configure with AI'}
          </button>
        </GuideHighlight>

        {explanation && (
          <div className="bg-dash-panel border border-dash-border rounded p-3 mt-1">
            <p className="text-xs text-gray-400 mb-1.5 font-semibold uppercase tracking-wider">Agent explanation</p>
            <p className="text-xs text-gray-300 leading-relaxed whitespace-pre-wrap">{explanation}</p>
          </div>
        )}
      </div>

      {/* ── Right: current config ── */}
      <div className="w-1/2 flex flex-col gap-5 p-6 overflow-y-auto">
        {currentConfig ? (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="font-mono text-xs font-semibold text-gray-300 tracking-widest uppercase">
                Current Configuration
              </h2>
              <span className="px-2 py-0.5 bg-blue-500/15 text-blue-300 text-xs rounded font-mono border border-blue-500/20">
                {currentConfig.environment_type}
              </span>
            </div>

            {currentConfig.description && (
              <p className="text-xs text-gray-400 leading-relaxed -mt-2">{currentConfig.description}</p>
            )}

            {/* Thresholds */}
            <div>
              <p className="text-xs font-semibold text-gray-400 mb-2 uppercase tracking-wider">Thresholds</p>
              <div className="bg-dash-panel border border-dash-border rounded overflow-hidden">
                {Object.entries(currentConfig.thresholds).map(([key, val], i, arr) => (
                  <div
                    key={key}
                    className={`flex justify-between items-center px-3 py-2 text-xs ${
                      i < arr.length - 1 ? 'border-b border-dash-border' : ''
                    }`}
                  >
                    <span className="text-gray-400">{THRESHOLD_LABELS[key] ?? key.replace(/_/g, ' ')}</span>
                    <span className="text-gray-200 font-mono font-semibold tabular-nums">{val}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Disabled events */}
            {currentConfig.disabled_events.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-gray-400 mb-2 uppercase tracking-wider">Suppressed Events</p>
                <div className="flex flex-wrap gap-1.5">
                  {currentConfig.disabled_events.map((e) => (
                    <span
                      key={e}
                      className="px-2 py-0.5 bg-red-500/10 text-red-400 text-xs rounded border border-red-500/20 font-mono"
                    >
                      {e}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Time rules */}
            {currentConfig.time_rules.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-gray-400 mb-2 uppercase tracking-wider">Time-Based Rules</p>
                <div className="space-y-2">
                  {currentConfig.time_rules.map((rule, i) => {
                    const active = isRuleActive(rule);
                    return (
                      <div
                        key={i}
                        className={`rounded border p-3 ${
                          active
                            ? 'border-green-500/40 bg-green-500/8'
                            : 'border-dash-border bg-dash-panel'
                        }`}
                      >
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className="text-xs font-semibold text-gray-200">{rule.label}</span>
                          <span className="text-xs text-gray-500 font-mono">
                            {rule.start_hour === 0 && rule.end_hour === 0
                              ? 'all day'
                              : `${fmtHour(rule.start_hour)} – ${fmtHour(rule.end_hour)}`}
                          </span>
                          {rule.days && rule.days.length > 0 && (
                            <span className="text-xs text-gray-500 font-mono">
                              {rule.days.map((d) => DAY_LABELS[d]).join(' ')}
                            </span>
                          )}
                          {active && (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/15 text-green-400 border border-green-500/30">
                              active now
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-gray-400 mb-2">{rule.description}</p>
                        {rule.thresholds && Object.keys(rule.thresholds).length > 0 && (
                          <div className="flex flex-wrap gap-x-4 gap-y-1">
                            {Object.entries(rule.thresholds).map(([k, v]) => (
                              <span key={k} className="text-xs font-mono text-gray-500">
                                {k.replace(/_/g, ' ')}:{' '}
                                <span className="text-gray-300">{String(v)}</span>
                              </span>
                            ))}
                          </div>
                        )}
                        {rule.disabled_events && rule.disabled_events.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {rule.disabled_events.map((e) => (
                              <span key={e} className="text-xs px-1.5 py-0.5 bg-red-500/10 text-red-400 rounded border border-red-500/20 font-mono">
                                {e}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Detection events — driven by its own pair of agents */}
            <div className="border-t border-dash-border pt-5">
              <DetectionEventsPanel
                envType={selectedEnvType === 'other' ? customEnvType.trim() : selectedEnvType}
                concerns={concerns}
                context={context}
                onConfigChanged={fetchConfig}
                cameraSessions={cameraSessions}
                guideActive={activeStep === 'events'}
                onDesignApplied={() => setEventsInstalled(true)}
              />
            </div>
          </>
        ) : (
          <p className="text-xs text-gray-500">Loading configuration...</p>
        )}
      </div>
    </div>
  );
};
