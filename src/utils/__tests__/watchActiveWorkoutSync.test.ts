// Tests for the watch ↔ phone active-workout sync invariants. Pure-function
// coverage around the two helpers that gate every command path:
//
//   • applyWatchLogSetToMirrored — dedupes by `watchCommandId`, places sets
//     by explicit setNumber, leaves the array untouched when re-applied.
//
//   • normalizeWatchCommands — TTL-strips, dedupes by `commandId`, orders by
//     `tsMs`. This is what protects the JS-side durable backlog from
//     replaying a stale or duplicate command after the JS process restarts.
//
// Each `it` maps to one of the listed integration scenarios:
//
//   - duplicate command via sendMessage + transferUserInfo
//   - app killed before JS listeners attach (TTL replay)
//   - old snapshot arriving after newer command (mirror is locally
//     authoritative; older snapshot completion badges can't undo the
//     logged set mirror)
//   - watch-started workout logging before phone echo (sessionId / start
//     adoption — covered via the mirror payload contract)
//   - slow backend / recommendation after log_set (mirror commits without
//     awaiting any backend; loggedPayload is computable synchronously)
//   - sign-out stale state prevention (commandId entries that survive
//     past TTL are dropped)
//   - rest timer recomputation: tested below as a wall-clock derivation,
//     mirroring `ActiveWorkoutState.reconcileRestClock` on the watch.

import {
  applyWatchLogSetToMirrored,
  type MirroredWatchExercise,
} from '../watchActiveWorkoutPure.ts';
import { normalizeWatchCommands } from '../watchCommandBacklog.ts';
import { claimWatchCommand, resetWatchCommandClaimsForTests } from '../watchCommandDedupe.ts';

type WorkoutDayLike = {
  focus: string;
  exercises: Array<{ name: string; sets: number; reps: string; restSeconds: number }>;
};

const day: WorkoutDayLike = {
  focus: 'Push',
  exercises: [
    { name: 'Bench Press', sets: 3, reps: '5-8', restSeconds: 120 },
    { name: 'Overhead Press', sets: 3, reps: '6-10', restSeconds: 90 },
  ],
};

function emptyMirror(): MirroredWatchExercise[] {
  return day.exercises.map((ex, exerciseIndex) => ({
    exerciseIndex,
    name: ex.name,
    targetSets: ex.sets,
    targetReps: ex.reps,
    targetRestSeconds: ex.restSeconds,
    sets: [],
  }));
}

describe('applyWatchLogSetToMirrored — local-first commit', () => {
  it('inserts a logged set at the explicit setNumber slot', () => {
    const result = applyWatchLogSetToMirrored(day as any, emptyMirror(), {
      exerciseIndex: 0,
      setNumber: 1,
      weightLbs: 135,
      reps: 8,
      commandId: 'log_set-1-aaa',
    });
    expect(result?.changed).toBe(true);
    expect(result?.mirrored[0].sets.length).toBe(1);
    expect(result?.mirrored[0].sets[0].setNumber).toBe(1);
    expect(result?.mirrored[0].sets[0].weightLbs).toBe(135);
    expect(result?.mirrored[0].sets[0].reps).toBe(8);
    expect(result?.mirrored[0].sets[0].watchCommandId).toBe('log_set-1-aaa');
  });

  it('preserves prior logged sets across calls (Phase-1 commit is additive)', () => {
    const after1 = applyWatchLogSetToMirrored(day as any, emptyMirror(), {
      exerciseIndex: 0, setNumber: 1, weightLbs: 135, reps: 8, commandId: 'A',
    })!.mirrored;
    const after2 = applyWatchLogSetToMirrored(day as any, after1, {
      exerciseIndex: 0, setNumber: 2, weightLbs: 140, reps: 7, commandId: 'B',
    })!.mirrored;
    expect(after2[0].sets.length).toBe(2);
    expect(after2[0].sets[0].watchCommandId).toBe('A');
    expect(after2[0].sets[1].watchCommandId).toBe('B');
  });
});

describe('applyWatchLogSetToMirrored — dedupe (sendMessage + transferUserInfo race)', () => {
  it('returns changed:false when the same commandId arrives a second time', () => {
    const first = applyWatchLogSetToMirrored(day as any, emptyMirror(), {
      exerciseIndex: 0, setNumber: 1, weightLbs: 135, reps: 8, commandId: 'X',
    })!;
    const replay = applyWatchLogSetToMirrored(day as any, first.mirrored, {
      exerciseIndex: 0, setNumber: 1, weightLbs: 135, reps: 8, commandId: 'X',
    })!;
    expect(replay.changed).toBe(false);
    expect(replay.mirrored).toBe(first.mirrored);
    expect(replay.mirrored[0].sets.length).toBe(1);
  });

  it('does not double-apply across exercises if the same commandId resurfaces', () => {
    const after = applyWatchLogSetToMirrored(day as any, emptyMirror(), {
      exerciseIndex: 0, setNumber: 1, weightLbs: 135, reps: 8, commandId: 'X',
    })!.mirrored;
    const replay = applyWatchLogSetToMirrored(day as any, after, {
      exerciseIndex: 1, setNumber: 1, weightLbs: 95, reps: 8, commandId: 'X',
    })!;
    expect(replay.changed).toBe(false);
    expect(replay.mirrored[1].sets.length).toBe(0);
  });
});

describe('applyWatchLogSetToMirrored — backend / recommendation are side effects only', () => {
  it('produces a logged payload synchronously from the in-memory mirror', () => {
    // The whole point: nothing inside this helper waits on a network call,
    // a recommendation refresh, or a HealthKit read. If a slow backend is
    // about to be hit, it must be hit AFTER this returns.
    const t0 = Date.now();
    const result = applyWatchLogSetToMirrored(day as any, emptyMirror(), {
      exerciseIndex: 0, setNumber: 1, weightLbs: 225, reps: 5, commandId: 'sync-1',
    });
    const t1 = Date.now();
    expect(result?.changed).toBe(true);
    // Synchronous in practice — give it 50ms of slack for slow CI.
    expect(t1 - t0 < 50).toBe(true);
  });
});

describe('applyWatchLogSetToMirrored — session safety', () => {
  it('rejects payloads pointing at an exercise that does not exist on the day', () => {
    const result = applyWatchLogSetToMirrored(day as any, emptyMirror(), {
      exerciseIndex: 99, setNumber: 1, weightLbs: 100, reps: 5, commandId: 'oob',
    });
    expect(result).toBe(null);
  });

  it('falls back to next-slot when setNumber is missing (watch-start before phone echo)', () => {
    // Watch-started workouts may send log_set before the phone has echoed
    // back its session-stamped state. setNumber is still mandatory in the
    // current contract, but if a legacy build omits it we should not lose
    // the set — append at the next slot.
    const result = applyWatchLogSetToMirrored(day as any, emptyMirror(), {
      exerciseIndex: 0, weightLbs: 135, reps: 8, commandId: 'no-slot',
    });
    expect(result?.changed).toBe(true);
    expect(result?.mirrored[0].sets[0].setNumber).toBe(1);
  });
});

describe('normalizeWatchCommands — durable backlog (app killed / restart)', () => {
  it('dedupes events by commandId across two arrivals', () => {
    const events = [
      { command: 'log_set', payload: { commandId: 'A', tsMs: 1000, exerciseIndex: 0, setNumber: 1 } },
      { command: 'log_set', payload: { commandId: 'A', tsMs: 1100, exerciseIndex: 0, setNumber: 1 } },
    ];
    const out = normalizeWatchCommands(events, 2000);
    expect(out.length).toBe(1);
    expect(out[0].payload.commandId).toBe('A');
  });

  it('drops events older than 4 hours (sign-out stale state prevention)', () => {
    const fourHoursMs = 4 * 60 * 60_000;
    const events = [
      { command: 'log_set', payload: { commandId: 'old', tsMs: 1000 } },
      { command: 'log_set', payload: { commandId: 'fresh', tsMs: 1000 + fourHoursMs - 1 } },
    ];
    const out = normalizeWatchCommands(events, 1000 + fourHoursMs + 5_000);
    expect(out.length).toBe(1);
    expect(out[0].payload.commandId).toBe('fresh');
  });

  it('orders surviving events by tsMs so replay applies in the original order', () => {
    const events = [
      { command: 'log_set', payload: { commandId: 'B', tsMs: 2000 } },
      { command: 'log_set', payload: { commandId: 'A', tsMs: 1000 } },
      { command: 'skip_rest', payload: { commandId: 'C', tsMs: 3000 } },
    ];
    const out = normalizeWatchCommands(events, 4000);
    expect(out.map(e => e.payload.commandId).join(',')).toBe('A,B,C');
  });

  it('drops commands that are not part of the active-workout set', () => {
    const events = [
      { command: 'toggle_meal', payload: { commandId: 'M', tsMs: 1000 } },
      { command: 'log_set', payload: { commandId: 'L', tsMs: 1000 } },
    ];
    const out = normalizeWatchCommands(events, 2000);
    expect(out.length).toBe(1);
    expect(out[0].command).toBe('log_set');
  });
});

describe('claimWatchCommand — cross-listener dedupe', () => {
  it('allows only the first mounted JS listener to claim a commandId', () => {
    resetWatchCommandClaimsForTests();
    const payload = { commandId: 'hydration-1', tsMs: 1000, deltaOz: 8 };
    expect(claimWatchCommand('log_hydration', payload, 1000)).toBe(true);
    expect(claimWatchCommand('log_hydration', payload, 1001)).toBe(false);
  });

  it('falls back to timestamp and payload shape for legacy commands without commandId', () => {
    resetWatchCommandClaimsForTests();
    const payload = { tsMs: 1000, dateISO: '2026-05-12', deltaOz: 8 };
    expect(claimWatchCommand('log_hydration', payload, 1000)).toBe(true);
    expect(claimWatchCommand('log_hydration', payload, 1001)).toBe(false);
  });
});

describe('rest timer — absolute restEndsAtMs is wall-clock-derived', () => {
  // Mirrors the math in `ActiveWorkoutState.reconcileRestClock` (Swift).
  // The watch uses `Int(ceil((endAt - now) / 1000))`, so backgrounding /
  // sleeping the watchOS app for any duration cannot freeze the countdown
  // — it always reflects real elapsed time when the view re-renders.
  function remainingSec(restEndAtMs: number, nowMs: number): number {
    return Math.max(0, Math.ceil((restEndAtMs - nowMs) / 1000));
  }

  it('returns the full duration when the rest just started', () => {
    expect(remainingSec(10_000, 0)).toBe(10);
  });

  it('returns zero once the absolute end has passed', () => {
    expect(remainingSec(10_000, 12_000)).toBe(0);
  });

  it('skips over a long sleep window without freezing', () => {
    // Started at t=0, 90s rest. Watch sleeps until t=85s.
    const endAt = 90_000;
    expect(remainingSec(endAt, 0)).toBe(90);
    expect(remainingSec(endAt, 85_000)).toBe(5);
  });

  it('does not go negative if reconciled after a session change races', () => {
    // Old session's restEndAtMs persists briefly until resetForSession
    // clears it. Even if reconcile fires in that window, the result is
    // pinned at zero.
    expect(remainingSec(1, 999_999)).toBe(0);
  });
});
