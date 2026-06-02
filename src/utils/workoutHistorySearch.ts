// Search and filters over local workout history. Shared by the Progress
// screen and the staleness-reminder evaluator so "what did I match"
// stays consistent between the two.
import type { WorkoutSession } from '../types';

export type WorkoutHistoryDateFilter = 'all' | '7d' | '30d' | '90d';
export type WorkoutHistoryTypeFilter =
  | 'all'
  | 'activities'
  | 'strength'
  | 'cardio'
  | 'mobility'
  | 'sport'
  | 'active'
  | 'recovery'
  | 'prs'
  | 'imported';

export interface WorkoutHistoryFilters {
  query?: string;
  dateFilter?: WorkoutHistoryDateFilter;
  typeFilter?: WorkoutHistoryTypeFilter;
  now?: Date;
}

function searchFields(session: WorkoutSession): string[] {
  const fields: string[] = [];
  if (session.focus) fields.push(session.focus);
  for (const ex of session.exercises ?? []) {
    if (ex?.name) fields.push(ex.name);
  }
  const ma = session.manualActivity;
  if (ma?.category) fields.push(ma.category);
  if (ma?.subtype) fields.push(ma.subtype);
  if (ma?.source) fields.push(ma.source);
  if (ma?.notes) fields.push(ma.notes);
  if (session.importSource) fields.push(session.importSource);
  if (session.sourceContext) fields.push(session.sourceContext);
  return fields;
}

/** True when a workout session matches a free-text query. Every
 *  whitespace-separated token must appear somewhere across the focus
 *  label, the exercise names, and the manual-activity category/subtype
 *  — so "bench", "leg day", "zone 2", "yoga" all work, and
 *  "incline bench" matches "Incline Dumbbell Bench Press". An empty
 *  query matches everything. */
export function sessionMatchesQuery(session: WorkoutSession, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  // Triple-space join so a token can't accidentally span two fields.
  const hay = searchFields(session).join('   ').toLowerCase();
  return tokens.every(t => hay.includes(t));
}

function localDateMs(dateStr: string | null | undefined): number {
  if (!dateStr) return Number.NaN;
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr).slice(0, 10));
  if (ymd) return new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])).getTime();
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return Number.NaN;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function startOfLocalDayMs(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function sessionMatchesDateFilter(
  session: WorkoutSession,
  filter: WorkoutHistoryDateFilter = 'all',
  now = new Date(),
): boolean {
  if (filter === 'all') return true;
  const days = filter === '7d' ? 7 : filter === '30d' ? 30 : 90;
  const sessionMs = localDateMs(session.date);
  if (!Number.isFinite(sessionMs)) return false;
  const todayMs = startOfLocalDayMs(now);
  const cutoffMs = todayMs - (days - 1) * 86400000;
  return sessionMs >= cutoffMs && sessionMs <= todayMs;
}

const CARDIO_RE = /\b(cardio|zone ?2|run|running|jog|jogging|walk|walking|hike|hiking|bike|biking|ride|riding|cycle|cycling|row|rowing|swim|swimming|elliptical|stair|hiit|sprint|treadmill)\b/i;
const MOBILITY_RE = /\b(mobility|yoga|stretch|stretching|foam|pilates|flow)\b/i;
const RECOVERY_RE = /\b(recovery|recover|sauna|cold plunge|ice bath|breathwork|meditation|sleep)\b/i;
const SPORT_RE = /\b(sport|basketball|soccer|tennis|pickleball|volleyball|golf|climb|climbing|bouldering|boxing|kickboxing|martial|ski|skiing|surf|surfing)\b/i;
const ACTIVE_RE = /\b(active|yard|yard work|garden|gardening|moving|clean|cleaning|construction|shovel|shoveling|dance|dancing|labor)\b/i;
const CORE_STRENGTH_RE = /\b(core|abs?|abdominal|oblique)s?\b|crunch|plank|sit[- ]?up|russian twist|leg raise|knee raise|hollow|woodchop|woodchopper|pallof|dead bug|bird dog/i;

function sessionTypeText(session: WorkoutSession): string {
  const fields: string[] = [];
  if (session.focus) fields.push(session.focus);
  for (const ex of session.exercises ?? []) {
    if (ex?.name) fields.push(ex.name);
  }
  const ma = session.manualActivity;
  if (ma?.subtype) fields.push(ma.subtype);
  if (ma?.notes) fields.push(ma.notes);
  if (session.importSource) fields.push(session.importSource);
  return fields.join('   ');
}

function hasCardioRouteOrDistance(session: WorkoutSession): boolean {
  return Boolean(session.routeCoords?.length)
    || Boolean(session.manualActivity?.distanceMiles && session.manualActivity.distanceMiles > 0);
}

function sessionLooksLikeCoreStrength(session: WorkoutSession, typeBlob: string): boolean {
  if (!CORE_STRENGTH_RE.test(typeBlob)) return false;
  const category = String(session.manualActivity?.category ?? '').trim().toLowerCase();
  if (category && category !== 'cardio' && category !== 'strength') return false;
  if (hasCardioRouteOrDistance(session)) return false;
  return !CARDIO_RE.test(typeBlob);
}

export function sessionMatchesTypeFilter(
  session: WorkoutSession,
  filter: WorkoutHistoryTypeFilter = 'all',
): boolean {
  if (filter === 'all') return true;
  if (filter === 'activities') return Boolean(session.manualActivity);
  if (filter === 'prs') return (session.prs?.length ?? 0) > 0;
  if (filter === 'imported') {
    return Boolean(session.importSource)
      || Boolean(session.manualActivity?.source && session.manualActivity.source !== 'manual');
  }

  const category = String(session.manualActivity?.category ?? '').trim().toLowerCase();
  const blob = sessionTypeText(session);
  const coreStrength = sessionLooksLikeCoreStrength(session, blob);
  if (filter === 'cardio') {
    if (coreStrength) return false;
    return category === 'cardio'
      || CARDIO_RE.test(blob)
      || hasCardioRouteOrDistance(session);
  }
  if (filter === 'strength') {
    if (category === 'strength' || coreStrength) return true;
    if (category && category !== 'strength') return false;
    return (session.exercises?.length ?? 0) > 0
      && !CARDIO_RE.test(blob)
      && !MOBILITY_RE.test(blob)
      && !RECOVERY_RE.test(blob)
      && !SPORT_RE.test(blob)
      && !ACTIVE_RE.test(blob);
  }
  if (category === filter) return true;

  if (filter === 'mobility') return MOBILITY_RE.test(blob);
  if (filter === 'recovery') return RECOVERY_RE.test(blob);
  if (filter === 'sport') return SPORT_RE.test(blob);
  if (filter === 'active') return ACTIVE_RE.test(blob);
  return true;
}

export function filterWorkoutHistory(
  history: WorkoutSession[],
  filters: WorkoutHistoryFilters = {},
): WorkoutSession[] {
  const {
    query = '',
    dateFilter = 'all',
    typeFilter = 'all',
    now = new Date(),
  } = filters;
  return history.filter(session =>
    sessionMatchesQuery(session, query)
    && sessionMatchesDateFilter(session, dateFilter, now)
    && sessionMatchesTypeFilter(session, typeFilter)
  );
}

/** Most-recent date a workout matching `query` was logged. `history`
 *  is expected newest-first (the order it is stored in). Returns null
 *  when nothing matches. Skipped sessions don't count as "logged". */
export function lastLoggedDateForQuery(
  history: WorkoutSession[],
  query: string,
): string | null {
  for (const s of history) {
    if (s.skipped) continue;
    if (sessionMatchesQuery(s, query)) return s.date;
  }
  return null;
}

/** Short relative-time label for a workout date — "today", "yesterday",
 *  "3 days ago", "2 weeks ago". Empty string for an unparseable date. */
export function workoutDaysAgoLabel(dateStr: string | null | undefined): string {
  if (!dateStr) return '';
  // A bare YYYY-MM-DD parses as UTC midnight, which shifts the day for
  // users behind UTC — parse the date part with local components so
  // "today" stays "today" everywhere.
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.slice(0, 10));
  const d = ymd
    ? new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]))
    : new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '';
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'last week';
  if (days < 31) return `${Math.round(days / 7)} weeks ago`;
  if (days < 62) return 'last month';
  return `${Math.round(days / 30)} months ago`;
}
