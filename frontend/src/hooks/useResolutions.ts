import { useCallback, useState } from 'react';

export interface Resolution {
  decision: 'all_clear' | 'threat';
  resolvedAt: string;
}

const STORAGE_KEY = 'anomaly_resolutions';

export function useResolutions() {
  const [resolutions, setResolutions] = useState<Record<string, Resolution>>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  });

  const resolve = useCallback((incidentId: string, decision: 'all_clear' | 'threat') => {
    const resolution: Resolution = {
      decision,
      resolvedAt: new Date().toLocaleTimeString(),
    };
    setResolutions((prev) => {
      const next = { ...prev, [incidentId]: resolution };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  return { resolutions, resolve };
}
