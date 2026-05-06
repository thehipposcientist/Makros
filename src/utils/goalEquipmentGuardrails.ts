function includesAny(equipment: string[], needles: string[]): boolean {
  const haystack = equipment.map(e => e.toLowerCase());
  return needles.some(needle => haystack.some(item => item.includes(needle)));
}

function appendUnique(warnings: string[], warning: string): void {
  if (!warnings.includes(warning)) warnings.push(warning);
}

const heavyStrengthNeedles = [
  'dumbbell', 'barbell', 'kettlebell', 'ez curl', 'trap bar', 'weight plate',
  'cable', 'smith', 'leg press', 'lat pulldown', 'chest press', 'seated row',
  'leg extension', 'leg curl', 'shoulder press', 'hack squat', 'machine',
  'belt squat', 'hip thrust',
];

const progressiveStrengthNeedles = [
  ...heavyStrengthNeedles,
  'resistance band', 'mini band', 'pull-up', 'pull up', 'dip bar',
  'suspension', 'weighted vest', 'medicine ball', 'sandbag', 'sled',
];

const upperStrengthNeedles = [
  'dumbbell', 'barbell', 'kettlebell', 'ez curl', 'weight plate', 'cable',
  'resistance band', 'mini band', 'pull-up', 'pull up', 'dip bar', 'suspension',
  'weighted vest', 'medicine ball', 'smith', 'lat pulldown', 'chest press',
  'seated row', 'shoulder press', 'assisted pull', 'pec deck', 'preacher',
  'row machine', 'lateral raise', 'pullover',
];

const lowerStrengthNeedles = [
  'dumbbell', 'barbell', 'kettlebell', 'trap bar', 'weight plate', 'cable',
  'resistance band', 'mini band', 'weighted vest', 'medicine ball', 'sandbag',
  'sled', 'smith', 'leg press', 'leg extension', 'leg curl', 'hack squat',
  'hip abduction', 'hip adduction', 'belt squat', 'hip thrust', 'calf raise',
];

const cardioNeedles = [
  'treadmill', 'stationary bike', 'elliptical', 'rowing machine', 'stair climber',
  'assault bike', 'swimming pool', 'battle rope', 'outdoor bike', 'skierg',
  'versaclimber', 'heavy bag', 'ruck',
];

const conditioningNeedles = [
  ...cardioNeedles,
  'bodyweight', 'no equipment', 'jump rope', 'step platform', 'plyo box',
  'agility ladder', 'training cones', 'sled', 'sandbag', 'dumbbell',
  'kettlebell', 'medicine ball',
];

const cardioAccessNeedles = [
  ...cardioNeedles,
  'bodyweight', 'no equipment', 'jump rope', 'step platform',
];

const runningAccessNeedles = ['bodyweight', 'no equipment', 'treadmill'];
const cyclingAccessNeedles = ['stationary bike', 'outdoor bike', 'assault bike'];
const fieldSpeedNeedles = ['bodyweight', 'no equipment', 'treadmill', 'agility ladder', 'training cones', 'plyo box', 'sled'];
const powerNeedles = ['plyo box', 'medicine ball', 'sled', 'sandbag', 'kettlebell', 'barbell', 'trap bar', 'dumbbell'];
const gripNeedles = ['dumbbell', 'kettlebell', 'barbell', 'trap bar', 'weight plate', 'pull-up', 'pull up', 'wrist roller', 'sandbag'];
const relativeStrengthNeedles = ['bodyweight', 'no equipment', 'pull-up', 'pull up', 'dip bar', 'suspension', 'weighted vest', 'assisted pull'];
const weightBearingNeedles = [...progressiveStrengthNeedles, 'bodyweight', 'no equipment', 'treadmill', 'stair climber', 'ruck', 'jump rope'];

const runningGoals = new Set([
  'running_fitness',
  'train_5k',
  'train_10k',
  'train_half',
  'train_marathon',
  'run_faster',
  'marathon',
  'sprint_speed',
]);

const musclePhysiqueGoals = new Set([
  'build_muscle',
  'lean_bulk',
  'gain_weight',
  'improve_aesthetics',
  'build_glutes',
  'build_upper_body',
  'build_lower_body',
  'build_arms',
  'build_shoulders',
  'body_recomp',
  'maintain_physique',
]);

const strengthGoals = new Set([
  'build_strength',
  'increase_overall',
  'improve_1rm',
  'powerlifting',
  'improve_squat',
  'improve_bench',
  'improve_deadlift',
  'improve_ohp',
  'improve_pullups',
  'improve_grip',
  'functional_strength',
  'explosive_strength',
  'relative_strength',
]);

const cardioEnduranceGoals = new Set([
  'improve_cardio',
  'improve_conditioning',
  'aerobic_base',
  'improve_vo2',
  'increase_stamina',
  'running_fitness',
  'train_5k',
  'train_10k',
  'train_half',
  'train_marathon',
  'sprint_speed',
  'interval_perf',
  'hiking_endurance',
  'cycling_endurance',
  'rowing_endurance',
  'swimming_endurance',
  'work_capacity',
]);

const athleticPerformanceGoals = new Set([
  'improve_athleticism',
  'improve_speed',
  'improve_agility',
  'improve_power',
  'improve_vertical',
  'improve_acceleration',
  'improve_cod',
  'improve_coordination',
  'improve_balance',
  'sport_performance',
  'offseason_training',
  'inseason_maintenance',
  'return_to_sport',
  'hyrox',
]);

const barbellSpecificGoals = new Set([
  'powerlifting',
  'improve_1rm',
  'improve_squat',
  'improve_bench',
  'improve_deadlift',
  'improve_ohp',
]);

const lowerBodyMuscleGoals = new Set(['build_glutes', 'build_lower_body']);
const upperBodyMuscleGoals = new Set(['build_upper_body', 'build_arms', 'build_shoulders', 'improve_aesthetics']);
const fieldSpeedGoals = new Set(['sprint_speed', 'improve_speed', 'improve_agility', 'improve_acceleration', 'improve_cod']);
const powerJumpGoals = new Set(['improve_power', 'improve_vertical', 'explosive_strength']);
const balancedHealthGoals = new Set(['general_health', 'longevity', 'healthy_aging', 'daily_function', 'joint_health']);

function goalCategoryForGuardrails(goal: string): 'strength' | 'muscle_physique' | 'cardio_endurance' | 'athletic_performance' | undefined {
  if (strengthGoals.has(goal)) return 'strength';
  if (musclePhysiqueGoals.has(goal)) return 'muscle_physique';
  if (cardioEnduranceGoals.has(goal)) return 'cardio_endurance';
  if (athleticPerformanceGoals.has(goal)) return 'athletic_performance';
  return undefined;
}

function hasCompleteBarbellSetup(goal: string, equipment: string[]): boolean {
  const hasBarbellAndPlates = includesAny(equipment, ['barbell']) && includesAny(equipment, ['weight plate']);
  const hasRack = includesAny(equipment, ['squat rack', 'power rack']);
  const hasBench = includesAny(equipment, ['flat bench', 'adjustable bench']);
  if (goal === 'powerlifting' || goal === 'improve_1rm') return hasBarbellAndPlates && hasRack && hasBench;
  if (goal === 'improve_squat') return hasBarbellAndPlates && hasRack;
  if (goal === 'improve_bench') return hasBarbellAndPlates && hasBench;
  if (goal === 'improve_deadlift' || goal === 'improve_ohp') return hasBarbellAndPlates;
  return true;
}

export function goalEquipmentWarnings(goal: string | null | undefined, equipment: string[]): string[] {
  const gid = String(goal || '').toLowerCase().trim();
  const cat = goalCategoryForGuardrails(gid);
  const warnings: string[] = [];
  const hasProgressiveStrength = includesAny(equipment, progressiveStrengthNeedles);
  const hasHeavyStrength = includesAny(equipment, heavyStrengthNeedles);
  const hasConditioning = includesAny(equipment, conditioningNeedles);
  const hasCardioAccess = includesAny(equipment, cardioAccessNeedles);
  const hasBodyweight = includesAny(equipment, ['bodyweight', 'no equipment']);
  const hasUpperStrength = includesAny(equipment, upperStrengthNeedles);
  const hasLowerStrength = includesAny(equipment, lowerStrengthNeedles);

  if (cat === 'strength') {
    if (gid === 'relative_strength') {
      if (!includesAny(equipment, [...relativeStrengthNeedles, ...progressiveStrengthNeedles])) {
        appendUnique(warnings, 'Relative strength can start with bodyweight work, but it needs calisthenics or resistance options like a pull-up bar, dip bars, suspension trainer, dumbbells, or a weighted vest for specific progress.');
      }
    } else if (!hasProgressiveStrength) {
      appendUnique(warnings, 'Build Strength needs progressive resistance. With this setup, your plan will be bodyweight-based unless you add dumbbells, a barbell, bands, a pull-up bar, cables, or machines.');
    } else if (!hasHeavyStrength) {
      appendUnique(warnings, 'This is a light-resistance strength setup. It can build starter strength, but heavy 3-6 rep progression works best with free weights, cables, or machines.');
    }
    if (barbellSpecificGoals.has(gid) && !hasCompleteBarbellSetup(gid, equipment)) {
      appendUnique(warnings, 'This strength target is barbell-specific. Add the relevant barbell, plates, rack, or bench equipment, or choose a broader strength goal.');
    }
    if (gid === 'improve_pullups' && !includesAny(equipment, ['pull-up', 'pull up', 'assisted pull-up', 'assisted pull'])) {
      appendUnique(warnings, 'Pull-up goals need a pull-up bar or assisted pull-up machine for specific progress.');
    }
    if (gid === 'improve_grip' && !includesAny(equipment, gripNeedles)) {
      appendUnique(warnings, 'Grip strength goals need hang, carry, or pinch-load options like dumbbells, kettlebells, plates, a barbell, pull-up bar, or wrist roller.');
    }
    if (gid === 'functional_strength' && !includesAny(equipment, ['dumbbell', 'kettlebell', 'sandbag', 'sled', 'trap bar', 'weighted vest', 'medicine ball'])) {
      appendUnique(warnings, 'Functional strength works best with something you can carry, hinge, lunge, or load, such as dumbbells, kettlebells, a sandbag, sled, trap bar, weighted vest, or medicine ball.');
    }
  }

  if (cat === 'muscle_physique') {
    if (!hasProgressiveStrength) {
      appendUnique(warnings, 'This equipment limits muscle-building progress. The plan will lean on bodyweight work; add dumbbells, bands, cables, or machines for better progressive overload.');
    } else if (!hasHeavyStrength) {
      appendUnique(warnings, 'This muscle-building setup is light-resistance dominant. It can work for beginners, but hypertrophy progression is better with dumbbells, cables, machines, or heavier free weights.');
    }
    if (lowerBodyMuscleGoals.has(gid) && hasProgressiveStrength && !hasLowerStrength) {
      appendUnique(warnings, 'This lower-body growth goal needs lower-body resistance. Add dumbbells, a barbell, bands, cables, leg machines, a sled, or hip-thrust/squat equipment for a better match.');
    }
    if (upperBodyMuscleGoals.has(gid) && hasProgressiveStrength && !hasUpperStrength) {
      appendUnique(warnings, 'This upper-body focus needs pressing or pulling resistance. Add dumbbells, bands, cables, a pull-up bar, dip bars, or upper-body machines for a better match.');
    }
  }

  if (gid === 'preserve_muscle_cutting' && !hasProgressiveStrength) {
    appendUnique(warnings, 'Preserving muscle while cutting works best with resistance training. With this equipment, the plan can support fat loss, but muscle retention is less specific.');
  }

  if (cat === 'cardio_endurance' && !hasConditioning && !runningGoals.has(gid) && gid !== 'cycling_endurance' && gid !== 'rowing_endurance' && gid !== 'swimming_endurance' && gid !== 'hiking_endurance') {
    appendUnique(warnings, 'Cardio and endurance goals need a conditioning option. Add a cardio machine, jump rope, outdoor/bodyweight access, or conditioning tools so the plan can match the goal.');
  }
  if (runningGoals.has(gid) && !includesAny(equipment, runningAccessNeedles)) {
    appendUnique(warnings, 'Running goals need running exposure. A bike can support conditioning, but add treadmill/outdoor running access or switch to a cycling/cardio goal for a better match.');
  }
  if (gid === 'cycling_endurance' && !includesAny(equipment, cyclingAccessNeedles)) {
    appendUnique(warnings, 'Cycling endurance needs a stationary, outdoor, or assault bike to match the selected goal.');
  }
  if (gid === 'rowing_endurance' && !includesAny(equipment, ['rowing machine'])) {
    appendUnique(warnings, 'Rowing endurance needs a rowing machine. Other cardio gear is cross-training, not rowing-specific work.');
  }
  if (gid === 'swimming_endurance' && !includesAny(equipment, ['swimming pool'])) {
    appendUnique(warnings, 'Swimming endurance needs pool access. Other cardio gear is cross-training, not swim-specific work.');
  }
  if (gid === 'hiking_endurance' && !hasBodyweight && !includesAny(equipment, ['treadmill', 'stair climber', 'ruck'])) {
    appendUnique(warnings, 'Hiking endurance needs outdoor walking/hiking, incline treadmill, stair climber, or ruck access.');
  }

  if (cat === 'athletic_performance' && !hasProgressiveStrength) {
    appendUnique(warnings, 'Hybrid performance goals need both conditioning and resistance work. With only cardio gear, the plan becomes bike/bodyweight cross-training instead of a full hybrid program.');
  }
  if (fieldSpeedGoals.has(gid) && !includesAny(equipment, fieldSpeedNeedles)) {
    appendUnique(warnings, 'Speed and agility goals need room to sprint, cut, jump, or drill. Add bodyweight/outdoor access, a treadmill, cones, an agility ladder, plyo box, or sled for a better match.');
  }
  if (powerJumpGoals.has(gid) && !(hasLowerStrength || includesAny(equipment, powerNeedles))) {
    appendUnique(warnings, 'Power and jump goals need explosive lower-body work. Add lower-body strength equipment, a plyo box, medicine ball, sled, sandbag, kettlebell, or free weights for a better match.');
  }
  if (gid === 'hyrox') {
    if (!includesAny(equipment, runningAccessNeedles)) {
      appendUnique(warnings, 'HYROX-style goals include running. Add treadmill/outdoor running access or expect a cross-training version.');
    }
    if (!includesAny(equipment, ['rowing machine', 'skierg', 'sled', 'sandbag', 'kettlebell', 'dumbbell', 'medicine ball', 'treadmill', 'bodyweight', 'no equipment'])) {
      appendUnique(warnings, 'HYROX-style goals need functional station tools such as rower/SkiErg, sled, sandbag, kettlebells, dumbbells, medicine ball, or running access.');
    }
  }

  if (gid === 'heart_health' && !hasCardioAccess) {
    appendUnique(warnings, 'Heart-health goals need a repeatable cardio option. Add a cardio machine, jump rope, step platform, or outdoor/bodyweight access.');
  }
  if (gid === 'metabolic_health') {
    if (!(hasProgressiveStrength || hasBodyweight)) {
      appendUnique(warnings, 'Metabolic-health goals work best with resistance training plus easy activity. Add bodyweight or progressive resistance equipment for the strength side.');
    }
    if (!hasCardioAccess) {
      appendUnique(warnings, 'Metabolic-health goals also need easy conditioning, such as walking, cycling, treadmill, rowing, or simple bodyweight intervals.');
    }
  }
  if (gid === 'bone_health' && !includesAny(equipment, weightBearingNeedles)) {
    appendUnique(warnings, 'Bone-health goals need weight-bearing or resistance work. Bike and swim work are useful cardio, but add walking, stairs, rucking, bodyweight, or resistance equipment.');
  }
  if (balancedHealthGoals.has(gid) && !(hasProgressiveStrength || hasBodyweight)) {
    appendUnique(warnings, 'This health goal is meant to stay balanced across strength, mobility, and cardio. With only machine cardio, the plan becomes less complete unless you add bodyweight or resistance options.');
  }
  if (gid === 'improve_posture' && !(hasUpperStrength || hasBodyweight || includesAny(equipment, ['yoga mat', 'foam roller']))) {
    appendUnique(warnings, 'Posture goals need upper-back, core, and mobility work. Add bodyweight access, bands, a pull-up/row option, cables, upper-body machines, a yoga mat, or a foam roller for a better match.');
  }

  return warnings;
}
