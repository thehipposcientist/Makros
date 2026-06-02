// Helpers for bundled exercise form previews.
//
// Frames are bundled into the app under assets/exercise-demos/<id>/{0,1}.jpg
// and exposed through the generated require() map at exerciseDemoAssets.ts.
// Move Kit MP4s are bundled under assets/exercise-videos/move-kit and exposed
// through moveKitExerciseVideos.ts.
// We previously hot-linked from raw.githubusercontent.com — that worked in
// Expo Go but failed in production builds (GH throttles non-browser traffic
// and silent <Image> errors meant the cards just didn't appear). Bundling
// trades ~21 MB of ipa size for offline-clean, zero-cost form demos.
//
// To add new ids: drop them into the seed, run scripts/sync-exercise-demos.sh.

import { ImageSourcePropType } from 'react-native';
import { DEMO_FRAMES } from './exerciseDemoAssets';
import {
  MOVE_KIT_VIDEO_BY_DEMO_ID,
  MOVE_KIT_VIDEO_BY_EXERCISE_KEY,
  type MoveKitExerciseVideo,
} from './moveKitExerciseVideos';

export type DemoFrame = 0 | 1;

const MOVE_KIT_BY_DEMO_ID: Readonly<Record<string, MoveKitExerciseVideo>> = MOVE_KIT_VIDEO_BY_DEMO_ID;
const MOVE_KIT_BY_EXERCISE_KEY: Readonly<Record<string, MoveKitExerciseVideo>> = MOVE_KIT_VIDEO_BY_EXERCISE_KEY;

function exerciseVideoKey(value: string | null | undefined): string | null {
  const key = String(value ?? '')
    .toLowerCase()
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

/** Returns a bundled Move Kit video for this exercise. Exercise name wins
 *  over the old free-exercise-db id because several legacy ids are generic
 *  fallbacks shared by different equipment variants. */
export function moveKitDemoVideo(
  demoExerciseDbId: string | null | undefined,
  exerciseName?: string | null,
): MoveKitExerciseVideo | null {
  const nameKey = exerciseVideoKey(exerciseName);
  if (nameKey && MOVE_KIT_BY_EXERCISE_KEY[nameKey]) {
    return MOVE_KIT_BY_EXERCISE_KEY[nameKey];
  }
  if (demoExerciseDbId && MOVE_KIT_BY_DEMO_ID[demoExerciseDbId]) {
    return MOVE_KIT_BY_DEMO_ID[demoExerciseDbId];
  }
  const demoKey = exerciseVideoKey(demoExerciseDbId);
  return demoKey ? MOVE_KIT_BY_EXERCISE_KEY[demoKey] ?? null : null;
}

/** Returns an Image `source` prop for the requested frame, or null when
 *  the id is unknown / unbundled. Callers should pass it directly into
 *  `<Image source={...} />` rather than wrapping in `{ uri }`. */
export function demoFrameSource(
  demoExerciseDbId: string | null | undefined,
  frame: DemoFrame = 1,
): ImageSourcePropType | null {
  if (!demoExerciseDbId) return null;
  const pair = DEMO_FRAMES[demoExerciseDbId];
  if (!pair) return null;
  return pair[frame];
}

/** Lockout / end-position frame — the single most recognizable still
 *  for any lift, used as the static thumbnail throughout the app. */
export function demoLockoutSource(
  demoExerciseDbId: string | null | undefined,
): ImageSourcePropType | null {
  return demoFrameSource(demoExerciseDbId, 1);
}
