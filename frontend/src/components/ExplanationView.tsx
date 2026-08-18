import React from 'react';
import type { Explanation } from '../types';
import { getThreatColor, getThreatBg, getThreatBorder } from '../utils';

interface ExplanationViewProps {
  explanation: Explanation;
  isLive: boolean;
}

export const ExplanationView: React.FC<ExplanationViewProps> = ({ explanation, isLive }) => {
  const confidencePct = Math.round(explanation.confidence * 100);

  return (
    <div className="space-y-5">
      {/* Summary + analyzing indicator */}
      <div className="relative">
        <div className="flex items-start justify-between gap-3 mb-1">
          <h3 className="font-mono text-[10px] font-semibold tracking-widest text-gray-600 uppercase">
            AI Summary
          </h3>
          {isLive && (
            <div className="flex items-center gap-1.5 text-[10px] text-blue-400 font-mono animate-pulse-slow">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse-fast" />
              analyzing...
            </div>
          )}
        </div>
        <p className="text-sm text-gray-200 leading-relaxed">{explanation.summary}</p>
      </div>

      {/* Confidence + trend + threat */}
      <div className="flex items-center gap-4">
        {/* Confidence bar */}
        <div className="flex-1">
          <div className="flex items-center justify-between mb-1">
            <span className="font-mono text-[10px] text-gray-600 tracking-widest uppercase">Confidence</span>
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-sm font-bold text-gray-200">{confidencePct}%</span>
              <TrendIndicator trend={explanation.confidence_trend} />
            </div>
          </div>
          <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-700 ease-out ${getConfidenceColor(confidencePct)}`}
              style={{ width: `${confidencePct}%` }}
            />
          </div>
        </div>

        {/* Threat level badge */}
        <div
          className={`
            font-mono text-xs font-bold tracking-widest uppercase px-3 py-1.5 rounded
            border ${getThreatBg(explanation.threat_level)} ${getThreatColor(explanation.threat_level)} ${getThreatBorder(explanation.threat_level)}
          `}
        >
          {getThreatIcon(explanation.threat_level)} {explanation.threat_level}
        </div>
      </div>

      {/* Evidence columns — labelled for operators rather than analysts, but
          still backed by the evidence_for / evidence_against fields. */}
      <div className="grid grid-cols-2 gap-3">
        {/* Evidence for */}
        <div className="border-l-2 border-green-600/70 pl-3 bg-green-950/10 rounded-r py-2 pr-2">
          <h4 className="font-mono text-[10px] font-semibold tracking-widest text-green-500 uppercase mb-2">
            Main Information
          </h4>
          {explanation.evidence_for.length === 0 ? (
            <p className="text-xs text-gray-600 italic">None identified</p>
          ) : (
            <ul className="space-y-1.5">
              {explanation.evidence_for.map((item, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <span className="text-green-600 mt-0.5 text-xs shrink-0">+</span>
                  <span className="text-xs text-gray-300 leading-snug">{item}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Evidence against */}
        <div className="border-l-2 border-red-700/70 pl-3 bg-red-950/10 rounded-r py-2 pr-2">
          <h4 className="font-mono text-[10px] font-semibold tracking-widest text-red-500 uppercase mb-2">
            Side Notes
          </h4>
          {explanation.evidence_against.length === 0 ? (
            <p className="text-xs text-gray-600 italic">None identified</p>
          ) : (
            <ul className="space-y-1.5">
              {explanation.evidence_against.map((item, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <span className="text-red-700 mt-0.5 text-xs shrink-0">−</span>
                  <span className="text-xs text-gray-300 leading-snug">{item}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Open questions */}
      {explanation.open_questions.length > 0 && (
        <div>
          <h4 className="font-mono text-[10px] font-semibold tracking-widest text-gray-600 uppercase mb-2">
            Open Questions
          </h4>
          <ul className="space-y-1.5">
            {explanation.open_questions.map((q, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="text-gray-600 text-xs mt-0.5 shrink-0">?</span>
                <span className="text-xs text-gray-500 italic leading-snug">{q}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Recommended action */}
      <div className={`rounded border ${getThreatBorder(explanation.threat_level)} ${getThreatBg(explanation.threat_level)} px-4 py-3`}>
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-xs">⚡</span>
          <h4 className="font-mono text-[10px] font-semibold tracking-widest text-gray-400 uppercase">
            Recommended Action
          </h4>
        </div>
        <p className={`text-sm font-medium leading-snug ${getThreatColor(explanation.threat_level)}`}>
          {explanation.recommended_action}
        </p>
      </div>
    </div>
  );
};

const TrendIndicator: React.FC<{ trend: Explanation['confidence_trend'] }> = ({ trend }) => {
  if (trend === 'increasing') {
    return <span className="text-green-400 font-mono text-sm font-bold" title="Increasing">↑</span>;
  }
  if (trend === 'decreasing') {
    return <span className="text-red-400 font-mono text-sm font-bold" title="Decreasing">↓</span>;
  }
  return <span className="text-gray-500 font-mono text-sm font-bold" title="Stable">→</span>;
};

function getConfidenceColor(pct: number): string {
  if (pct >= 85) return 'bg-red-500';
  if (pct >= 70) return 'bg-orange-400';
  if (pct >= 50) return 'bg-yellow-400';
  return 'bg-blue-400';
}

function getThreatIcon(level: string): string {
  switch (level) {
    case 'critical': return '🔴';
    case 'high': return '🟠';
    case 'medium': return '🟡';
    case 'low': return '🔵';
    default: return '⚪';
  }
}
