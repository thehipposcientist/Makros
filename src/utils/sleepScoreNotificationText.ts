import type { SleepScore } from '../types';

export interface SleepScoreNotificationReadiness {
  score?: number | null;
  label?: string | null;
  action?: string | null;
}

function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function formatSleepDuration(hours: number | null | undefined): string | null {
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0) return null;
  const totalMinutes = Math.max(1, Math.round(hours * 60));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h <= 0) return `${m}m asleep`;
  if (m === 0) return `${h}h asleep`;
  return `${h}h ${m}m asleep`;
}

export function sleepScoreRecoveryPhrase(score: number): string {
  const rounded = clampScore(score);
  if (rounded >= 85) return 'Recovery looks excellent today.';
  if (rounded >= 70) return 'Recovery looks strong today.';
  if (rounded >= 50) return 'Recovery looks moderate today.';
  return "Keep today's training a little lighter.";
}

function cleanSentence(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/[.]+$/, '');
}

export function formatReadinessSnippet(readiness?: SleepScoreNotificationReadiness | null): string | null {
  const rawScore = Number(readiness?.score);
  if (!Number.isFinite(rawScore)) return null;
  const score = clampScore(rawScore);
  const label = cleanSentence(readiness?.label);
  const labelText = label && label !== '—' ? ` (${label})` : '';
  const action = cleanSentence(readiness?.action);
  return action
    ? `Readiness ${score}${labelText}: ${action}.`
    : `Readiness ${score}${labelText}.`;
}

export function buildSleepScoreNotificationContent(
  sleepScore: Pick<SleepScore, 'score' | 'duration'>,
  readiness?: SleepScoreNotificationReadiness | null,
): { title: string; body: string } {
  const score = clampScore(sleepScore.score);
  const duration = formatSleepDuration(sleepScore.duration);
  const phrase = formatReadinessSnippet(readiness) ?? sleepScoreRecoveryPhrase(score);
  return {
    title: `Sleep score ${score}`,
    body: duration ? `${duration}. ${phrase}` : phrase,
  };
}
