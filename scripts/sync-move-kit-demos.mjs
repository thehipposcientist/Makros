#!/usr/bin/env node
// Extracts the subset of the Move Kit library that has confident matches
// in Thallo and regenerates the static Metro require() map.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const ZIP = resolve(ROOT, 'assets/full-library.zip');
const DEST = resolve(ROOT, 'assets/exercise-videos/move-kit');
const MAP = resolve(ROOT, 'src/utils/moveKitExerciseVideos.ts');

const EXERCISE_VIDEO_MATCHES = {
  'Barbell Bench Press': 'barbell-bench-press.mp4',
  'Incline Barbell Press': 'barbell-incline-bench-press.mp4',
  'Dumbbell Bench Press': 'dumbbell-bench-press.mp4',
  'Incline Dumbbell Press': 'dumbbell-incline-bench-press.mp4',
  'Decline Push-ups': 'decline-push-up.mp4',
  'Push-ups': 'push-up.mp4',
  'Wide Push-ups': 'push-up.mp4',
  'Diamond Push-ups': 'diamond-push-ups.mp4',
  'Chest Dips': 'parralel-bar-dips.mp4',
  'Dumbbell Fly': 'dumbbell-chest-fly.mp4',
  'Cable Fly': 'cable-pec-fly.mp4',
  'Machine Chest Press': 'machine-chest-press.mp4',
  'Pec Deck': 'machine-pec-fly.mp4',
  Deadlift: 'barbell-deadlift.mp4',
  'Barbell Romanian Deadlift': 'barbell-stiff-leg-deadlifts.mp4',
  'Rack Pull': 'barbell-rack-pull.mp4',
  'Barbell Row': 'barbell-bent-over-row.mp4',
  'Pendlay Row': 'barbell-bent-over-row.mp4',
  'T-Bar Row': 'landmine-t-bar-rows.mp4',
  'Dumbbell Row': 'dumbbell-row-unilateral.mp4',
  'Pull-ups': 'pull-ups.mp4',
  'Chin-ups': 'chin-ups.mp4',
  'Lat Pulldown': 'machine-pulldown.mp4',
  'Wide-Grip Lat Pulldown': 'machine-pulldown.mp4',
  'Neutral-Grip Lat Pulldown': 'narrow-pulldown.mp4',
  'Close-Grip Lat Pulldown': 'narrow-pulldown.mp4',
  'Seated Cable Row': 'machine-seated-cable-row.mp4',
  'Seated Row Machine': 'machine-neutral-row.mp4',
  'Face Pull': 'cable-bar-face-pull.mp4',
  'Inverted Row': 'inverted-row.mp4',
  'Superman Hold': 'supermans.mp4',
  'Back Extension (Back Focused)': 'machine-45-degree-back-extension.mp4',
  'Back Extension (Glute Focused)': 'machine-45-degree-back-extension.mp4',
  'Overhead Press': 'barbell-overhead-press.mp4',
  'Dumbbell Shoulder Press': 'dumbbell-seated-overhead-press.mp4',
  'Machine Shoulder Press': 'machine-front-military-press.mp4',
  'Lateral Raise': 'dumbbell-lateral-raise.mp4',
  'Front Raise': 'dumbbell-front-raise.mp4',
  'Rear Delt Fly': 'dumbbell-rear-delt-fly.mp4',
  'Upright Row': 'barbell-upright-row.mp4',
  'Barbell Curl': 'barbell-curl.mp4',
  'Dumbbell Curl': 'dumbbell-curl.mp4',
  'Alternating Dumbbell Curl': 'dumbbell-curl.mp4',
  'Hammer Curl': 'dumbbell-hammer-curl.mp4',
  'Incline Dumbbell Curl': 'dumbbell-incline-curl.mp4',
  'Incline Hammer Curl': 'dumbbell-incline-hammer-curl.mp4',
  'Concentration Curl': 'dumbbell-concentration-curl.mp4',
  'Preacher Curl': 'dumbbell-preacher-curl.mp4',
  'Cable Curl': 'cable-bar-curl.mp4',
  'Skull Crusher': 'dumbbell-skullcrusher.mp4',
  'Dumbbell Skull Crusher': 'dumbbell-skullcrusher.mp4',
  'Tricep Pushdown': 'cable-bar-pushdown.mp4',
  'Rope Pushdown': 'cable-rope-pushdown.mp4',
  'Single-Arm Cable Pushdown': 'cable-single-arm-rope-pushdown.mp4',
  'Close-grip Bench Press': 'barbell-close-grip-bench-press.mp4',
  'Overhead Tricep Extension': 'dumbbell-seated-overhead-tricep-extension.mp4',
  'Bench Dips': 'bench-dips.mp4',
  'Dumbbell Tricep Kickbacks': 'dumbbell-tricep-kickback.mp4',
  'Barbell Squat': 'barbell-squat.mp4',
  'Leg Press': 'machine-leg-press.mp4',
  'Leg Extension': 'machine-leg-extension.mp4',
  'Bulgarian Split Squat': 'bulgarian-split-squat.mp4',
  'Walking Lunges': 'lunge-walking.mp4',
  'Reverse Lunges': 'bodyweight-reverse-lunge.mp4',
  'Lateral Lunge': 'bodyweight-alternating-lateral-lunge.mp4',
  'Goblet Squat': 'dumbbell-goblet-squat.mp4',
  'Heel-Elevated Goblet Squat': 'dumbbell-goblet-squat.mp4',
  'Slant Board Goblet Squat': 'dumbbell-goblet-squat.mp4',
  'Bodyweight Squat': 'bodyweight-squat.mp4',
  'Wall Sit': 'wall-sit.mp4',
  'Good Morning': 'good-mornings.mp4',
  'Smith Machine Romanian Deadlift': 'smith-machine-sumo-romanian-deadlift.mp4',
  'Sumo Squat': 'dumbbell-sumo-squat.mp4',
  'Single-leg Calf Raise': 'dumbbell-single-leg-calf-raise.mp4',
  Plank: 'hand-plank.mp4',
  'Side Plank': 'elbow-side-plank.mp4',
  'Russian Twist': 'bodyweight-russian-twist.mp4',
  'Cable Woodchop': 'cable-wood-chopper.mp4',
  'Mountain Climbers': 'mountain-climber.mp4',
  'Slider Mountain Climber': 'mountain-climber.mp4',
  'Kettlebell Swing': 'kettlebell-swing.mp4',
  Burpees: 'burpee.mp4',
  'Box Jump': 'box-jump.mp4',
  'Jump Squats': 'jump-squats.mp4',
  Thrusters: 'dumbbell-thruster.mp4',
  'Single-Arm Dumbbell Bench Press': 'dumbbell-single-arm-chest-press.mp4',
  'Single-Arm Cable Row': 'cable-single-arm-neutral-grip-row.mp4',
  'Single-Arm Cable Chest Press': 'cable-standing-single-arm-chest-press.mp4',
  'Bilateral Cable Chest Press': 'cable-chest-press.mp4',
  'Split Squat': 'dumbbell-goblet-split-squat.mp4',
  'Pectoral Fly': 'machine-pec-fly.mp4',
  'Iso-Lateral Row': 'machine-neutral-row.mp4',
  'Assisted Dip Machine': 'machine-dips.mp4',
  'Seated Dip Machine': 'machine-dips.mp4',
  'Barbell Shrug': 'barbell-shrug.mp4',
  'Dumbbell Shrug': 'dumbbell-shrug.mp4',
  'Drag Curl': 'barbell-drag-curl.mp4',
  'Wrist Curl': 'dumbbell-wrist-curl.mp4',
  'Crunch Machine': 'machine-crunch.mp4',
  'Weighted Sit-up': 'dumbbell-situp.mp4',
  'Band Row': 'band-row.mp4',
  'Band Face Pull': 'band-high-face-pull.mp4',
  'Band Bicep Curl': 'band-curl.mp4',
  'Kettlebell Windmill': 'kettlebell-windmill.mp4',
  'Kettlebell Row': 'kettlebell-row.mp4',
  'Power Snatch': 'barbell-power-snatch.mp4',
  'Smith Machine Incline Press': 'smith-machine-incline-bench-press.mp4',
  'Incline Push-up': 'incline-push-up.mp4',
  'Decline Dumbbell Press': 'dumbbell-decline-bench-press.mp4',
  'Incline Dumbbell Fly': 'dumbbell-incline-chest-fly.mp4',
  'Hanging Knee Raise': 'hanging-knee-raises.mp4',
  'Donkey Calf Raise': 'bodyweight-donkey-calf-raise.mp4',
};

const DEMO_ID_VIDEO_MATCHES = {
  'Ab_Crunch_Machine': 'machine-crunch.mp4',
  'Barbell_Bench_Press_-_Medium_Grip': 'barbell-bench-press.mp4',
  'Barbell_Curl': 'barbell-curl.mp4',
  'Barbell_Deadlift': 'barbell-deadlift.mp4',
  'Barbell_Incline_Bench_Press_-_Medium_Grip': 'barbell-incline-bench-press.mp4',
  'Barbell_Shoulder_Press': 'barbell-overhead-press.mp4',
  'Barbell_Shrug': 'barbell-shrug.mp4',
  'Barbell_Squat': 'barbell-squat.mp4',
  'Bench_Dips': 'bench-dips.mp4',
  'Bent_Over_Barbell_Row': 'barbell-bent-over-row.mp4',
  'Bodyweight_Squat': 'bodyweight-squat.mp4',
  'Cable_Chest_Press': 'cable-chest-press.mp4',
  'Cable_Crossover': 'cable-pec-fly.mp4',
  'Chin-Up': 'chin-ups.mp4',
  'Close-Grip_Barbell_Bench_Press': 'barbell-close-grip-bench-press.mp4',
  'Concentration_Curls': 'dumbbell-concentration-curl.mp4',
  'Decline_Dumbbell_Bench_Press': 'dumbbell-decline-bench-press.mp4',
  'Decline_Push-Up': 'decline-push-up.mp4',
  'Dip_Machine': 'machine-dips.mp4',
  'Dips_-_Chest_Version': 'parralel-bar-dips.mp4',
  'Donkey_Calf_Raises': 'bodyweight-donkey-calf-raise.mp4',
  'Drag_Curl': 'barbell-drag-curl.mp4',
  'Dumbbell_Bench_Press': 'dumbbell-bench-press.mp4',
  'Dumbbell_Bicep_Curl': 'dumbbell-curl.mp4',
  'Dumbbell_Flyes': 'dumbbell-chest-fly.mp4',
  'Dumbbell_One-Arm_Shoulder_Press': 'dumbbell-seated-overhead-press.mp4',
  'Dumbbell_Seated_One-Leg_Calf_Raise': 'dumbbell-single-leg-calf-raise.mp4',
  'Dumbbell_Shrug': 'dumbbell-shrug.mp4',
  'Face_Pull': 'cable-bar-face-pull.mp4',
  'Freehand_Jump_Squat': 'jump-squats.mp4',
  'Front_Box_Jump': 'box-jump.mp4',
  'Front_Dumbbell_Raise': 'dumbbell-front-raise.mp4',
  'Goblet_Squat': 'dumbbell-goblet-squat.mp4',
  'Good_Morning': 'good-mornings.mp4',
  'Hammer_Curls': 'dumbbell-hammer-curl.mp4',
  'Hanging_Leg_Raise': 'hanging-knee-raises.mp4',
  'Hyperextensions_Back_Extensions': 'machine-45-degree-back-extension.mp4',
  'Incline_Dumbbell_Curl': 'dumbbell-incline-curl.mp4',
  'Incline_Dumbbell_Flyes': 'dumbbell-incline-chest-fly.mp4',
  'Incline_Dumbbell_Press': 'dumbbell-incline-bench-press.mp4',
  'Incline_Hammer_Curls': 'dumbbell-incline-hammer-curl.mp4',
  'Incline_Push-Up': 'incline-push-up.mp4',
  'Inverted_Row': 'inverted-row.mp4',
  'Kettlebell_Thruster': 'kettlebell-thruster.mp4',
  'Kettlebell_Windmill': 'kettlebell-windmill.mp4',
  'Leg_Extensions': 'machine-leg-extension.mp4',
  'Leg_Press': 'machine-leg-press.mp4',
  'Lying_T-Bar_Row': 'landmine-t-bar-rows.mp4',
  'Lying_Triceps_Press': 'dumbbell-skullcrusher.mp4',
  'Mountain_Climbers': 'mountain-climber.mp4',
  'One_Arm_Dumbbell_Bench_Press': 'dumbbell-single-arm-chest-press.mp4',
  'One-Arm_Kettlebell_Swings': 'kettlebell-swing.mp4',
  'Plank': 'hand-plank.mp4',
  'Power_Snatch': 'barbell-power-snatch.mp4',
  'Preacher_Curl': 'dumbbell-preacher-curl.mp4',
  'Pullups': 'pull-ups.mp4',
  'Pushups': 'push-up.mp4',
  'Rack_Pulls': 'barbell-rack-pull.mp4',
  'Reverse_Flyes': 'dumbbell-rear-delt-fly.mp4',
  'Romanian_Deadlift': 'barbell-stiff-leg-deadlifts.mp4',
  'Russian_Twist': 'bodyweight-russian-twist.mp4',
  'Seated_Cable_Rows': 'machine-seated-cable-row.mp4',
  'Seated_Dumbbell_Press': 'dumbbell-seated-overhead-press.mp4',
  'Seated_One-arm_Cable_Pulley_Rows': 'cable-single-arm-neutral-grip-row.mp4',
  'Side_Bridge': 'elbow-side-plank.mp4',
  'Side_Lateral_Raise': 'dumbbell-lateral-raise.mp4',
  'Smith_Machine_Incline_Bench_Press': 'smith-machine-incline-bench-press.mp4',
  'Split_Squat_with_Dumbbells': 'dumbbell-goblet-split-squat.mp4',
  'Standing_Biceps_Cable_Curl': 'cable-bar-curl.mp4',
  'Standing_Dumbbell_Triceps_Extension': 'dumbbell-seated-overhead-tricep-extension.mp4',
  'Standing_Military_Press': 'barbell-overhead-press.mp4',
  'Superman': 'supermans.mp4',
  'Tricep_Dumbbell_Kickback': 'dumbbell-tricep-kickback.mp4',
  'Triceps_Pushdown': 'cable-bar-pushdown.mp4',
  'Upright_Barbell_Row': 'barbell-upright-row.mp4',
  'Wide-Grip_Lat_Pulldown': 'machine-pulldown.mp4',
};

function normalizeKey(value) {
  return value
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
}

function labelFor(filename) {
  return filename
    .replace(/\.mp4$/, '')
    .split('-')
    .map((part) => part ? part[0].toUpperCase() + part.slice(1) : part)
    .join(' ');
}

if (!existsSync(ZIP)) {
  throw new Error(`Missing ${ZIP}`);
}

mkdirSync(DEST, { recursive: true });

const zipFiles = new Set(execFileSync('unzip', ['-Z1', ZIP], { encoding: 'utf8' }).split('\n').filter(Boolean));
const filenames = Array.from(new Set([
  ...Object.values(EXERCISE_VIDEO_MATCHES),
  ...Object.values(DEMO_ID_VIDEO_MATCHES),
])).sort();

const missing = filenames.filter((filename) => !zipFiles.has(filename));
if (missing.length) {
  throw new Error(`Missing Move Kit files:\n${missing.join('\n')}`);
}

for (const filename of filenames) {
  execFileSync('unzip', ['-j', '-o', ZIP, filename, '-d', DEST], { stdio: 'inherit' });
}

const fileConstName = (filename) => filename
  .replace(/\.mp4$/, '')
  .replace(/[^a-z0-9]+/gi, '_')
  .replace(/^(\d)/, '_$1')
  .toUpperCase();

const lines = [];
lines.push('// AUTO-GENERATED - do not edit by hand.');
lines.push('// Source: assets/full-library.zip via scripts/sync-move-kit-demos.mjs');
lines.push('');
lines.push('export type MoveKitExerciseVideo = {');
lines.push('  readonly source: number;');
lines.push('  readonly filename: string;');
lines.push('  readonly label: string;');
lines.push('};');
lines.push('');
lines.push('const MOVE_KIT_FILES = {');
for (const filename of filenames) {
  lines.push(`  ${fileConstName(filename)}: {`);
  lines.push(`    source: require('../../assets/exercise-videos/move-kit/${filename}'),`);
  lines.push(`    filename: '${filename}',`);
  lines.push(`    label: '${labelFor(filename).replace(/'/g, "\\'")}',`);
  lines.push('  },');
}
lines.push('} as const satisfies Readonly<Record<string, MoveKitExerciseVideo>>;');
lines.push('');

lines.push('export const MOVE_KIT_VIDEO_BY_DEMO_ID = {');
for (const [demoId, filename] of Object.entries(DEMO_ID_VIDEO_MATCHES).sort(([a], [b]) => a.localeCompare(b))) {
  lines.push(`  '${demoId}': MOVE_KIT_FILES.${fileConstName(filename)},`);
}
lines.push('} as const satisfies Readonly<Record<string, MoveKitExerciseVideo>>;');
lines.push('');

const keyEntries = new Map();
for (const [exerciseName, filename] of Object.entries(EXERCISE_VIDEO_MATCHES)) {
  keyEntries.set(normalizeKey(exerciseName), filename);
}
for (const [demoId, filename] of Object.entries(DEMO_ID_VIDEO_MATCHES)) {
  keyEntries.set(normalizeKey(demoId), filename);
}
for (const filename of filenames) {
  keyEntries.set(normalizeKey(filename.replace(/\.mp4$/, '')), filename);
}

lines.push('export const MOVE_KIT_VIDEO_BY_EXERCISE_KEY = {');
for (const [key, filename] of Array.from(keyEntries.entries()).sort(([a], [b]) => a.localeCompare(b))) {
  lines.push(`  '${key.replace(/'/g, "\\'")}': MOVE_KIT_FILES.${fileConstName(filename)},`);
}
lines.push('} as const satisfies Readonly<Record<string, MoveKitExerciseVideo>>;');
lines.push('');

writeFileSync(MAP, `${lines.join('\n')}\n`);

console.log(`extracted ${filenames.length} Move Kit videos to ${DEST}`);
console.log(`wrote ${MAP}`);
