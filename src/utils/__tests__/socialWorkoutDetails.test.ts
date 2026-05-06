import {
  chooseSocialWorkoutFeedItem,
  compactSocialSetSummaries,
  socialWorkoutDateKey,
} from '../socialWorkoutDetails.ts';

describe('social workout details', () => {
  it('prefers older detailed workout rows over newer empty feedback rows', () => {
    const detailed = {
      id: 10,
      event_type: 'workout_completed',
      payload: {
        date: '2026-05-06',
        exercises: [{
          name: 'Bench Press',
          sets: [{ reps: 5, weight_lbs: 225 }],
        }],
      },
    };
    const emptyFeedbackPatch = {
      id: 11,
      event_type: 'workout_completed',
      payload: {
        date: '2026-05-06',
        exercises: [],
      },
    };

    expect(chooseSocialWorkoutFeedItem(detailed as any, emptyFeedbackPatch as any)).toBe(detailed);
  });

  it('keeps manual post chrome while filling missing workout details from auto row', () => {
    const autoRow = {
      id: 10,
      event_type: 'workout_completed',
      payload: {
        focus: 'Push',
        date: '2026-05-06',
        exercises: [{
          name: 'Bench Press',
          sets: [{ reps: 5, weight_lbs: 225 }],
        }],
        total_sets: 1,
        total_reps: 5,
      },
    };
    const post = {
      id: 12,
      event_type: 'workout_post',
      payload: {
        caption: 'Solid one',
        workout_summary: {
          focus: 'Push',
          date: '2026-05-06',
          exercises: [],
        },
      },
    };

    const chosen = chooseSocialWorkoutFeedItem(autoRow as any, post as any);
    expect(chosen.id).toBe(12);
    expect(chosen.payload.caption).toBe('Solid one');
    expect(chosen.payload.workout_summary.exercises[0].sets[0].weight_lbs).toBe(225);
  });

  it('uses the workout date nested inside manual social posts', () => {
    const post = {
      id: 12,
      event_type: 'workout_post',
      created_at: '2026-05-08T18:00:00+00:00',
      payload: {
        caption: 'Late share',
        workout_summary: {
          focus: 'Pull',
          date: '2026-05-05',
          exercises: [],
        },
      },
    };

    expect(socialWorkoutDateKey(post)).toBe('2026-05-05');
  });

  it('formats load and reps for expanded social set chips', () => {
    expect(compactSocialSetSummaries([
      { reps: 5, weight_lbs: 225 },
      { reps: 5, weight_lbs: 225 },
    ])).toEqual(['2 sets · 225 lb x 5']);
  });
});
