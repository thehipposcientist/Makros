import type { ImageSourcePropType } from 'react-native';

type CardSource = ImageSourcePropType;

function stableHash(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function selectCardBackground<T extends CardSource>(sources: readonly T[], seed: string): T {
  return sources[stableHash(seed) % sources.length] ?? sources[0];
}

export function selectCardBackgroundRotation<T extends CardSource>(
  sources: readonly T[],
  seed: string,
  occurrenceIndex: number,
): T {
  const baseIndex = stableHash(seed) % sources.length;
  const offset = Math.max(0, Math.floor(occurrenceIndex));
  return sources[(baseIndex + offset) % sources.length] ?? sources[0];
}

const malePush = [
  require('../../assets/images/card-backgrounds/workout-card-push-day-male.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-18112398.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-4164841.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-29825224.jpg'),
] as const;

const femalePush = [
  require('../../assets/images/card-backgrounds/workout-card-push-day-female.jpg'),
  require('../../assets/images/card-backgrounds/workout-card-free-weights-day-female.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-416809.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-14598863.jpg'),
] as const;

const malePull = [
  require('../../assets/images/card-backgrounds/workout-card-pull-day-male.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-29773898.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-4162475.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-6551066.jpg'),
] as const;

const femalePull = [
  require('../../assets/images/card-backgrounds/workout-card-pull-day-rowing.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-31818700.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-33177841.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-6551426.jpg'),
] as const;

const maleLegs = [
  require('../../assets/images/card-backgrounds/workout-card-legs-day-male.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-4853262.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-28805366.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-20817818.jpg'),
] as const;

const femaleLegs = [
  require('../../assets/images/card-backgrounds/workout-card-legs-day-female.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-31500880.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-29259731.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-4853693.jpg'),
] as const;

const maleHinge = [
  require('../../assets/images/card-backgrounds/workout-card-hinge-day-male.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-20817818.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-13018414.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-28805366.jpg'),
] as const;

const femaleHinge = [
  require('../../assets/images/card-backgrounds/workout-card-hinge-day-female.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-18986395.jpg'),
  require('../../assets/images/card-backgrounds/workout-card-legs-day-female.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-31500880.jpg'),
] as const;

const maleFreeWeights = [
  require('../../assets/images/card-backgrounds/workout-card-free-weights-day-male.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-4164841.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-13018414.jpg'),
  require('../../assets/images/card-backgrounds/workout-card-push-day-male.jpg'),
] as const;

const femaleFreeWeights = [
  require('../../assets/images/card-backgrounds/workout-card-free-weights-day-female.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-20060598.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-31818700.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-6551426.jpg'),
] as const;

const maleFullBody = [
  require('../../assets/images/card-backgrounds/workout-card-generic-gym-day-neutral.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-5670475.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-13018414.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-18112396.jpg'),
] as const;

const femaleFullBody = [
  require('../../assets/images/card-backgrounds/workout-card-generic-gym-day-neutral.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-12996943.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-18986395.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-20060598.jpg'),
] as const;

const maleHiit = [
  require('../../assets/images/card-backgrounds/workout-card-hiit-day-male.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-5670475.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-4162475.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-6551061.jpg'),
] as const;

const femaleHiit = [
  require('../../assets/images/card-backgrounds/workout-card-hiit-day-female.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-12996943.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-18986395.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-14252286.jpg'),
] as const;

const maleRecovery = [
  require('../../assets/images/card-backgrounds/workout-card-recovery-day-male.jpg'),
  require('../../assets/images/card-backgrounds/workout-card-stretching-day.jpg'),
  require('../../assets/images/card-backgrounds/workout-card-yoga-day.jpg'),
  require('../../assets/images/card-backgrounds/workout-card-sauna-day.jpg'),
] as const;

const femaleRecovery = [
  require('../../assets/images/card-backgrounds/workout-card-recovery-day-female.jpg'),
  require('../../assets/images/card-backgrounds/workout-card-yoga-outdoor-day.jpg'),
  require('../../assets/images/card-backgrounds/workout-card-meditation-day.jpg'),
  require('../../assets/images/card-backgrounds/workout-card-sauna-day.jpg'),
] as const;

const maleRest = [
  require('../../assets/images/card-backgrounds/workout-card-sauna-day.jpg'),
  require('../../assets/images/card-backgrounds/workout-card-meditation-day.jpg'),
  require('../../assets/images/card-backgrounds/workout-card-stretching-day.jpg'),
  require('../../assets/images/card-backgrounds/workout-card-recovery-day-male.jpg'),
] as const;

const femaleRest = [
  require('../../assets/images/card-backgrounds/workout-card-meditation-day.jpg'),
  require('../../assets/images/card-backgrounds/workout-card-yoga-outdoor-day.jpg'),
  require('../../assets/images/card-backgrounds/workout-card-recovery-day-female.jpg'),
  require('../../assets/images/card-backgrounds/workout-card-sauna-day.jpg'),
] as const;

const maleCycling = [
  require('../../assets/images/card-backgrounds/workout-card-cycling-day.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-11175793.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-6455840.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-6455851.jpg'),
] as const;

const femaleCycling = [
  require('../../assets/images/card-backgrounds/workout-card-cycling-day.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-14616299.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-6551097.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-3768916.jpg'),
] as const;

const maleSwimming = [
  require('../../assets/images/card-backgrounds/workout-card-swimming-day-male.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-8688226.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-6011942.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-9617722.jpg'),
] as const;

const femaleSwimming = [
  require('../../assets/images/card-backgrounds/workout-card-swimming-day-female.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-18361842.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-6011942.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-9617722.jpg'),
] as const;

const maleRunning = [
  require('../../assets/images/card-backgrounds/workout-card-running-day-male.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-13028305.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-6455840.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-6455851.jpg'),
] as const;

const femaleRunning = [
  require('../../assets/images/card-backgrounds/workout-card-running-day-female.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-31914336.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-35419772.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-4944975.jpg'),
] as const;

const maleTreadmill = [
  require('../../assets/images/card-backgrounds/workout-card-treadmill-day-neutral.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-11175793.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-6455840.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-6455851.jpg'),
] as const;

const femaleTreadmill = [
  require('../../assets/images/card-backgrounds/workout-card-treadmill-day-female.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-31914336.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-35419772.jpg'),
  require('../../assets/images/card-backgrounds/pexels-card-4944975.jpg'),
] as const;

export const WORKOUT_CARD_BACKGROUNDS = {
  male: {
    press: malePush,
    row: malePull,
    pullup: malePull,
    squat: maleLegs,
    deadlift: maleHinge,
    legExtension: maleLegs,
    dumbbell: maleFreeWeights,
    kettlebell: maleFreeWeights,
    fullBody: maleFullBody,
    hiit: maleHiit,
    recovery: maleRecovery,
    rest: maleRest,
    cycling: maleCycling,
    swimming: maleSwimming,
    running: maleRunning,
    treadmill: maleTreadmill,
    gym: maleFullBody,
  },
  female: {
    press: femalePush,
    row: femalePull,
    pullup: femalePull,
    squat: femaleLegs,
    deadlift: femaleHinge,
    legExtension: femaleLegs,
    dumbbell: femaleFreeWeights,
    kettlebell: femaleFreeWeights,
    fullBody: femaleFullBody,
    hiit: femaleHiit,
    recovery: femaleRecovery,
    rest: femaleRest,
    cycling: femaleCycling,
    swimming: femaleSwimming,
    running: femaleRunning,
    treadmill: femaleTreadmill,
    gym: femaleFullBody,
  },
  neutral: {
    press: [...malePush, ...femalePush],
    row: [...malePull, ...femalePull],
    pullup: [...malePull, ...femalePull],
    squat: [...maleLegs, ...femaleLegs],
    deadlift: [...maleHinge, ...femaleHinge],
    legExtension: [...maleLegs, ...femaleLegs],
    dumbbell: [...maleFreeWeights, ...femaleFreeWeights],
    kettlebell: [...maleFreeWeights, ...femaleFreeWeights],
    fullBody: [...maleFullBody, ...femaleFullBody],
    hiit: [...maleHiit, ...femaleHiit],
    recovery: [...maleRecovery, ...femaleRecovery],
    rest: [...maleRest, ...femaleRest],
    cycling: [...maleCycling, ...femaleCycling],
    swimming: [
      require('../../assets/images/card-backgrounds/workout-card-swimming-day-neutral.jpg'),
      ...maleSwimming,
      ...femaleSwimming,
    ],
    running: [...maleRunning, ...femaleRunning],
    treadmill: [...maleTreadmill, ...femaleTreadmill],
    gym: [...maleFullBody, ...femaleFullBody],
  },
} as const;

export const MEAL_CARD_BACKGROUNDS = {
  emptyPlate: [
    require('../../assets/images/card-backgrounds/meal-card-empty-meal-day.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-1640774.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-1092730.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-6605214.jpg'),
  ],
  breakfast: [
    require('../../assets/images/card-backgrounds/meal-card-breakfast-day.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-376464.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-704569.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-1640770.jpg'),
  ],
  breakfastSmoothie: [
    require('../../assets/images/card-backgrounds/meal-card-breakfast-smoothie-day.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-34227829.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-34227827.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-1092730.jpg'),
  ],
  chicken: [
    require('../../assets/images/card-backgrounds/meal-card-high-protein-chicken-day.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-18330403.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-32810337.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-5836775.jpg'),
  ],
  chickenRice: [
    require('../../assets/images/card-backgrounds/meal-card-high-protein-chicken-rice-day.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-18330403.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-32810337.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-5836775.jpg'),
  ],
  caesar: [
    require('../../assets/images/card-backgrounds/meal-card-caesar-chicken-salad-day.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-18330403.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-32810337.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-1213710.jpg'),
  ],
  mealPrepChicken: [
    require('../../assets/images/card-backgrounds/meal-card-high-protein-meal-prep-day.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-18330403.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-32810337.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-5836775.jpg'),
  ],
  salmon: [
    require('../../assets/images/card-backgrounds/meal-card-high-protein-salmon-day.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-15895834.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-725991.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-3296280.jpg'),
  ],
  salmonBeans: [
    require('../../assets/images/card-backgrounds/meal-card-high-protein-salmon-day.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-15895834.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-725991.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-18330403.jpg'),
  ],
  steak: [
    require('../../assets/images/card-backgrounds/meal-card-high-protein-steak-day.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-29221429.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-19579546.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-675951.jpg'),
  ],
  smoothie: [
    require('../../assets/images/card-backgrounds/meal-card-smoothie-day.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-34227829.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-34227827.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-1092730.jpg'),
  ],
  oatmeal: [
    require('../../assets/images/card-backgrounds/meal-card-oatmeal-day.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-1092730.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-4551975.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-1640770.jpg'),
  ],
  yogurt: [
    require('../../assets/images/card-backgrounds/meal-card-high-protein-yogurt-day.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-30041629.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-1092730.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-4551975.jpg'),
  ],
  tunaSalad: [
    require('../../assets/images/card-backgrounds/meal-card-high-protein-tuna-salad-day.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-1213710.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-1640777.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-18330403.jpg'),
  ],
  salad: [
    require('../../assets/images/card-backgrounds/meal-card-salad-day.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-1213710.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-1640777.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-1640770.jpg'),
  ],
  pasta: [
    require('../../assets/images/card-backgrounds/meal-card-pasta-day.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-1279330.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-1437267.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-2097090.jpg'),
  ],
  quinoa: [
    require('../../assets/images/card-backgrounds/meal-card-quinoa-day.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-1640777.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-18330403.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-1640770.jpg'),
  ],
  burrito: [
    require('../../assets/images/card-backgrounds/meal-card-burrito-day.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-461198.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-2092507.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-5836775.jpg'),
  ],
  noodle: [
    require('../../assets/images/card-backgrounds/meal-card-noodle-day.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-3297807.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-6646035.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-2347311.jpg'),
  ],
  mediterranean: [
    require('../../assets/images/card-backgrounds/meal-card-mediterranean-day.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-6275177.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-1640777.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-18330403.jpg'),
  ],
  veganPrep: [
    require('../../assets/images/card-backgrounds/meal-card-plant-based-meal-prep-day.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-1640777.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-1640770.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-18330403.jpg'),
  ],
  veggieDinner: [
    require('../../assets/images/card-backgrounds/meal-card-plant-based-day.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-1640777.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-1640770.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-18330403.jpg'),
  ],
  veggieMix: [
    require('../../assets/images/card-backgrounds/meal-card-plant-based-day.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-1640777.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-1640770.jpg'),
    require('../../assets/images/card-backgrounds/pexels-card-18330403.jpg'),
  ],
} as const;
