/**
 * Format a Unix timestamp as a relative time string ("2m ago", "just now", etc.)
 */
export function formatRelativeTime(unixSeconds: number): string {
  const now = Date.now() / 1000;
  const diff = now - unixSeconds;

  if (diff < 5) return 'just now';
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/**
 * Format a duration between two Unix timestamps as "Xm Ys"
 */
export function formatDuration(startUnix: number, endUnix: number): string {
  const diff = endUnix - startUnix;
  if (diff < 1) return '<1s';
  if (diff < 60) return `${Math.floor(diff)}s`;
  const mins = Math.floor(diff / 60);
  const secs = Math.floor(diff % 60);
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`;
}

/**
 * Format a Unix timestamp as a short absolute time string
 */
export function formatAbsoluteTime(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

type ThreatLevel = 'low' | 'medium' | 'high' | 'critical';

export function getThreatColor(level: ThreatLevel | string): string {
  switch (level) {
    case 'critical': return 'text-red-400';
    case 'high': return 'text-orange-400';
    case 'medium': return 'text-yellow-400';
    case 'low': return 'text-blue-400';
    default: return 'text-gray-400';
  }
}

export function getThreatBg(level: ThreatLevel | string): string {
  switch (level) {
    case 'critical': return 'bg-red-950/60';
    case 'high': return 'bg-orange-950/60';
    case 'medium': return 'bg-yellow-950/60';
    case 'low': return 'bg-blue-950/60';
    default: return 'bg-gray-900';
  }
}

export function getThreatBorder(level: ThreatLevel | string): string {
  switch (level) {
    case 'critical': return 'border-red-700/50';
    case 'high': return 'border-orange-700/50';
    case 'medium': return 'border-yellow-700/50';
    case 'low': return 'border-blue-700/50';
    default: return 'border-gray-700';
  }
}

export function getSourceColor(source: 'cv' | 'audio' | 'behavior'): string {
  switch (source) {
    case 'cv': return 'text-purple-400';
    case 'audio': return 'text-cyan-400';
    case 'behavior': return 'text-green-400';
  }
}

export function getSourceBg(source: 'cv' | 'audio' | 'behavior'): string {
  switch (source) {
    case 'cv': return 'bg-purple-950/60 border-purple-800/40';
    case 'audio': return 'bg-cyan-950/60 border-cyan-800/40';
    case 'behavior': return 'bg-green-950/60 border-green-800/40';
  }
}

export function getSourceIcon(source: 'cv' | 'audio' | 'behavior'): string {
  switch (source) {
    case 'cv': return '👁';
    case 'audio': return '🔊';
    case 'behavior': return '🚶';
  }
}

export function getSourceLabel(source: 'cv' | 'audio' | 'behavior'): string {
  switch (source) {
    case 'cv': return 'CV';
    case 'audio': return 'AUD';
    case 'behavior': return 'BEH';
  }
}
