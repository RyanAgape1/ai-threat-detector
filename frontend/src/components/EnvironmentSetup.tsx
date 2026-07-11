import React, { useEffect, useState } from 'react';
import { EnvironmentConfig, TimeRule } from '../types';

function isRuleActive(rule: TimeRule): boolean {
  const hour = new Date().getHours();
  const { start_hour: s, end_hour: e } = rule;
  if (s === e) return false;
  return s < e ? hour >= s && hour < e : hour >= s || hour < e;
}

function fmtHour(h: number): string {
  const ampm = h < 12 ? 'AM' : 'PM';
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}${ampm}`;
}

const API = 'http://localhost:8000';

const ENV_TYPES = [
  { id: 'mall', label: 'Shopping Mall', desc: 'High foot traffic retail' },
  { id: 'warehouse', label: 'Warehouse', desc: 'Industrial, vehicles, packages' },
  { id: 'airport', label: 'Airport', desc: 'Transit hub, security-critical' },
  { id: 'parking_lot', label: 'Parking Lot', desc: 'Vehicles, low foot traffic' },
  { id: 'school', label: 'School / Campus', desc: 'After-hours monitoring' },
  { id: 'office', label: 'Office Building', desc: 'Corporate, low baseline' },
  { id: 'generic', label: 'Generic', desc: 'Balanced default settings' },
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


export const EnvironmentSetup: React.FC = () => {
  const [currentConfig, setCurrentConfig] = useState<EnvironmentConfig | null>(null);
  const [selectedEnvType, setSelectedEnvType] = useState('');
  const [concerns, setConcerns] = useState('');
  const [context, setContext] = useState('');
  const [loading, setLoading] = useState(false);
  const [explanation, setExplanation] = useState('');
  const [error, setError] = useState('');

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
    setLoading(true);
    setError('');
    setExplanation('');
    try {
      const res = await fetch(`${API}/environment/configure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ env_type: selectedEnvType, concerns, context }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text);
      }
      const data: { config: EnvironmentConfig; explanation: string } = await res.json();
      setCurrentConfig(data.config);
      setExplanation(data.explanation);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

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

        {/* Environment type grid */}
        <div>
          <p className="text-xs text-gray-400 mb-2">Select environment type</p>
          <div className="grid grid-cols-2 gap-2">
            {ENV_TYPES.map((et) => (
              <button
                key={et.id}
                onClick={() => setSelectedEnvType(et.id)}
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
        </div>

        {/* Concerns */}
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
            placeholder="e.g. 24/7 operation, cameras cover main entrance and parking, busy weekends..."
            className="w-full bg-dash-bg border border-dash-border rounded p-2 text-xs text-gray-200 h-16 resize-none focus:outline-none focus:border-blue-500 placeholder-gray-600"
          />
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <button
          onClick={() => void handleConfigure()}
          disabled={loading || !selectedEnvType}
          className="px-4 py-2 bg-blue-600 text-white text-xs font-semibold rounded hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors self-start"
        >
          {loading ? 'Configuring...' : 'Configure with AI'}
        </button>

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
                            {fmtHour(rule.start_hour)} – {fmtHour(rule.end_hour)}
                          </span>
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

          </>
        ) : (
          <p className="text-xs text-gray-500">Loading configuration...</p>
        )}
      </div>
    </div>
  );
};
