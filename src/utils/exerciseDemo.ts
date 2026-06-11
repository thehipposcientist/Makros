import type { ImageSourcePropType } from 'react-native';

import {
  MOVE_KIT_VIDEO_BY_DEMO_ID,
  MOVE_KIT_VIDEO_BY_EXERCISE_KEY,
} from './moveKitExerciseVideos';

type MoveKitDemoVideo = {
  source: any;
};

const COMMON_MOVE_KIT_ALIASES: Record<string, string> = {
  'bench press': 'barbell bench press',
  'barbell press': 'barbell bench press',
  'squat': 'barbell squat',
  'back squat': 'barbell squat',
  'deadlift': 'barbell deadlift',
  'conventional deadlift': 'barbell deadlift',
  'military press': 'barbell overhead press',
  'shoulder press': 'dumbbell shoulder press',
  'bicep curl': 'dumbbell curl',
  'biceps curl': 'dumbbell curl',
  'curl': 'dumbbell curl',
  'tricep extension': 'dumbbell seated overhead tricep extension',
  'triceps extension': 'dumbbell seated overhead tricep extension',
  'tricep pushdown': 'cable bar pushdown',
  'triceps pushdown': 'cable bar pushdown',
  'row': 'dumbbell row',
  'seated row': 'machine seated cable row',
  'chest press': 'machine chest press',
  'lat pull down': 'lat pulldown',
  'pulldown': 'lat pulldown',
};

function normalizeDemoKey(value?: string | null): string | null {
  const key = String(value ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\bpushups\b/g, 'push ups')
    .replace(/\bpullups\b/g, 'pull ups')
    .replace(/\bsitups\b/g, 'sit ups')
    .replace(/\bflyes\b/g, 'fly')
    .replace(/\bflies\b/g, 'fly')
    .replace(/\bcurls\b/g, 'curl')
    .replace(/\brows\b/g, 'row')
    .replace(/\braises\b/g, 'raise')
    .replace(/\bdips\b/g, 'dip')
    .replace(/\bshrugs\b/g, 'shrug')
    .replace(/\bdeadlifts\b/g, 'deadlift')
    .replace(/\blunges\b/g, 'lunge')
    .replace(/\bextensions\b/g, 'extension')
    .replace(/\bkickbacks\b/g, 'kickback')
    .replace(/\bclimbers\b/g, 'climber')
    .replace(/\bmornings\b/g, 'morning')
    .replace(/\bsupermans\b/g, 'superman')
    .replace(/\s+/g, ' ')
    .trim();
  return key || null;
}

export function moveKitDemoVideo(
  demoExerciseDbId?: string | null,
  exerciseName?: string | null
): MoveKitDemoVideo | null {
  const videoByExerciseKey = MOVE_KIT_VIDEO_BY_EXERCISE_KEY as Record<string, MoveKitDemoVideo>;
  const videoByDemoId = MOVE_KIT_VIDEO_BY_DEMO_ID as Record<string, MoveKitDemoVideo>;
  const exerciseKey = normalizeDemoKey(exerciseName);
  if (exerciseKey && videoByExerciseKey[exerciseKey]) {
    return videoByExerciseKey[exerciseKey];
  }
  const aliasKey = exerciseKey ? COMMON_MOVE_KIT_ALIASES[exerciseKey] : null;
  if (aliasKey && videoByExerciseKey[aliasKey]) {
    return videoByExerciseKey[aliasKey];
  }
  if (demoExerciseDbId && videoByDemoId[demoExerciseDbId]) {
    return videoByDemoId[demoExerciseDbId];
  }
  const demoKey = normalizeDemoKey(demoExerciseDbId);
  if (!demoKey) return null;
  const demoAliasKey = COMMON_MOVE_KIT_ALIASES[demoKey];
  return videoByExerciseKey[demoKey] ?? (demoAliasKey ? videoByExerciseKey[demoAliasKey] ?? null : null);
}

export function demoFrameSource(
  demoExerciseDbId?: string | null,
  frame = 1
): ImageSourcePropType | null {
  void demoExerciseDbId;
  void frame;
  return null;
}

export function demoLockoutSource(demoExerciseDbId?: string | null): ImageSourcePropType | null {
  void demoExerciseDbId;
  return null;
}
