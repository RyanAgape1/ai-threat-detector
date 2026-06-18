import { useState, useCallback, useEffect } from 'react';
import type { Report, ReportSummary } from '../types';

export function useReports() {
  const [summaries, setSummaries] = useState<ReportSummary[]>([]);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSummaries = useCallback(async () => {
    try {
      const res = await fetch('http://localhost:8000/reports');
      if (res.ok) setSummaries(await res.json() as ReportSummary[]);
    } catch {
      // backend not yet reachable is non-fatal
    }
  }, []);

  useEffect(() => { void fetchSummaries(); }, [fetchSummaries]);

  const generateReport = useCallback(async (timeFrom: number, timeTo: number): Promise<Report | null> => {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch('http://localhost:8000/reports/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ time_from: timeFrom, time_to: timeTo }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { detail?: string };
        setError(data.detail ?? 'Generation failed');
        return null;
      }
      const report = await res.json() as Report;
      await fetchSummaries();
      return report;
    } catch (e) {
      setError('Could not reach backend');
      return null;
    } finally {
      setGenerating(false);
    }
  }, [fetchSummaries]);

  const fetchReport = useCallback(async (id: string): Promise<Report | null> => {
    try {
      const res = await fetch(`http://localhost:8000/reports/${id}`);
      if (res.ok) return await res.json() as Report;
      return null;
    } catch {
      return null;
    }
  }, []);

  const deleteReport = useCallback(async (id: string) => {
    try {
      await fetch(`http://localhost:8000/reports/${id}`, { method: 'DELETE' });
      setSummaries((prev) => prev.filter((r) => r.id !== id));
    } catch {
      // ignore
    }
  }, []);

  return { summaries, generating, error, generateReport, fetchReport, deleteReport, fetchSummaries };
}
