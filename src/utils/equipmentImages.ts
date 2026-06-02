import type { ImageSourcePropType } from 'react-native';

export type EquipmentVisualInput =
  | string
  | {
      slug?: string | null;
      name?: string | null;
      aliases?: string[] | null;
      category?: string | null;
      icon?: string | null;
    }
  | null
  | undefined;

export interface ExerciseEquipmentMatchInput {
  name?: string | null;
  equipment?: string | null;
  gear?: Array<{
    slug?: string | null;
    name?: string | null;
    category?: string | null;
    required?: boolean | null;
  }> | null;
}

const EQUIPMENT_IMAGE_ALIASES: Array<{ keys: string[]; source: ImageSourcePropType }> = [
  {
    keys: ['smith_machine', 'smith machine'],
    source: require('../../assets/images/equipment/smith_machine.png'),
  },
  {
    keys: [
      'plate_loaded_chest_press_machine',
      'plate loaded chest press machine',
      'plate loaded incline press machine',
      'iso lateral incline press',
      'iso lateral chest press',
      'hammer strength incline press',
      'hammer strength chest press',
      'leverage chest press machine',
      'incline chest press machine',
    ],
    source: require('../../assets/images/equipment/plate_loaded_chest_press_machine.png'),
  },
  {
    keys: ['barbell', 'olympic barbell'],
    source: require('../../assets/images/equipment/barbell.png'),
  },
  {
    keys: ['weight_plates', 'weight plates', 'plates', 'bumper plates'],
    source: require('../../assets/images/equipment/weight_plates.png'),
  },
  {
    keys: ['ez_curl_bar', 'ez curl bar', 'ez bar'],
    source: require('../../assets/images/equipment/ez_curl_bar.png'),
  },
  {
    keys: ['trap_bar', 'trap bar', 'hex bar'],
    source: require('../../assets/images/equipment/trap_bar.png'),
  },
  {
    keys: ['kettlebell', 'kettlebells'],
    source: require('../../assets/images/equipment/kettlebell.png'),
  },
  {
    keys: ['medicine_ball', 'medicine ball', 'wall ball'],
    source: require('../../assets/images/equipment/medicine_ball.png'),
  },
  {
    keys: ['rope_attachment', 'cable rope attachment', 'tricep rope', 'rope handle'],
    source: require('../../assets/images/equipment/cable_rope_attachment.png'),
  },
  {
    keys: ['straight_bar_attachment', 'cable straight bar', 'straight bar attachment'],
    source: require('../../assets/images/equipment/cable_straight_bar_attachment.png'),
  },
  {
    keys: ['d_handle', 'cable d handle', 'single handle', 'stirrup handle'],
    source: require('../../assets/images/equipment/cable_d_handle_attachment.png'),
  },
  {
    keys: ['v_bar_attachment', 'cable v bar', 'triangle handle', 'v bar attachment'],
    source: require('../../assets/images/equipment/cable_v_bar_attachment.png'),
  },
  {
    keys: ['ankle_strap', 'cable ankle strap', 'ankle cuff'],
    source: require('../../assets/images/equipment/cable_ankle_strap.png'),
  },
  {
    keys: ['heavy_bag', 'heavy bag', 'boxing bag'],
    source: require('../../assets/images/equipment/heavy_bag.png'),
  },
  {
    keys: ['treadmill', 'treadmill run', 'treadmill walk'],
    source: require('../../assets/images/equipment/treadmill.png'),
  },
  {
    keys: ['stationary_bike', 'stationary bike', 'spin bike', 'bike zone 2'],
    source: require('../../assets/images/equipment/stationary_bike.png'),
  },
  {
    keys: ['elliptical', 'elliptical machine'],
    source: require('../../assets/images/equipment/elliptical.png'),
  },
  {
    keys: ['rowing_machine', 'rowing machine', 'rower', 'erg rower'],
    source: require('../../assets/images/equipment/rowing_machine.png'),
  },
  {
    keys: ['stair_climber', 'stair climber', 'stairmaster'],
    source: require('../../assets/images/equipment/stair_climber.png'),
  },
  {
    keys: ['assault_bike', 'assault bike', 'air bike', 'fan bike'],
    source: require('../../assets/images/equipment/assault_bike.png'),
  },
  {
    keys: ['skierg', 'ski erg', 'ski machine'],
    source: require('../../assets/images/equipment/skierg.png'),
  },
  {
    keys: ['versaclimber', 'versa climber'],
    source: require('../../assets/images/equipment/versaclimber.png'),
  },
  {
    keys: ['standing_calf_raise_machine', 'standing calf raise machine'],
    source: require('../../assets/images/equipment/standing_calf_raise_machine.png'),
  },
  {
    keys: ['seated_calf_raise_machine', 'seated calf raise machine'],
    source: require('../../assets/images/equipment/seated_calf_raise_machine.png'),
  },
  {
    keys: ['flat_bench', 'flat bench', 'bench'],
    source: require('../../assets/images/equipment/flat_bench.png'),
  },
  {
    keys: ['adjustable_bench', 'adjustable bench', 'fid bench'],
    source: require('../../assets/images/equipment/adjustable_bench.png'),
  },
  {
    keys: ['incline_bench', 'incline bench'],
    source: require('../../assets/images/equipment/incline_bench.png'),
  },
  {
    keys: ['decline_bench', 'decline bench'],
    source: require('../../assets/images/equipment/decline_bench.png'),
  },
  {
    keys: ['squat_rack', 'squat rack', 'half rack'],
    source: require('../../assets/images/equipment/squat_rack.png'),
  },
  {
    keys: ['power_rack', 'power rack', 'power cage'],
    source: require('../../assets/images/equipment/power_rack.png'),
  },
  {
    keys: ['landmine_attachment', 'landmine attachment', 'landmine'],
    source: require('../../assets/images/equipment/landmine_attachment.png'),
  },
  {
    keys: ['adjustable_dumbbells', 'adjustable dumbbells'],
    source: require('../../assets/images/equipment/adjustable_dumbbells.png'),
  },
  {
    keys: ['dumbbells', 'dumbbell', 'dbs'],
    source: require('../../assets/images/equipment/dumbbells.png'),
  },
  {
    keys: ['pull_up_bar', 'pull up bar', 'pull-up bar', 'chin up bar'],
    source: require('../../assets/images/equipment/pull_up_bar.png'),
  },
  {
    keys: ['resistance_bands', 'resistance bands', 'resistance bands tube', 'tube bands'],
    source: require('../../assets/images/equipment/resistance_bands.png'),
  },
  {
    keys: ['yoga_mat', 'yoga mat', 'exercise mat'],
    source: require('../../assets/images/equipment/yoga_mat.png'),
  },
  {
    keys: ['jump_rope', 'jump rope', 'skipping rope'],
    source: require('../../assets/images/equipment/jump_rope.png'),
  },
  {
    keys: ['foam_roller', 'foam roller'],
    source: require('../../assets/images/equipment/foam_roller.png'),
  },
  {
    keys: ['ab_wheel', 'ab wheel', 'ab roller'],
    source: require('../../assets/images/equipment/ab_wheel.png'),
  },
  {
    keys: ['dip_bars', 'dip bars', 'parallel bars'],
    source: require('../../assets/images/equipment/dip_bars.png'),
  },
  {
    keys: ['suspension_trainer', 'suspension trainer', 'trx'],
    source: require('../../assets/images/equipment/suspension_trainer.png'),
  },
  {
    keys: ['sturdy_chair', 'sturdy chair', 'low surface', 'chair'],
    source: require('../../assets/images/equipment/sturdy_chair.png'),
  },
  {
    keys: ['nordic_anchor', 'nordic strap', 'foot anchor', 'nordic curl strap'],
    source: require('../../assets/images/equipment/nordic_anchor.png'),
  },
  {
    keys: ['mini_band', 'mini band', 'loop band', 'glute band'],
    source: require('../../assets/images/equipment/mini_band.png'),
  },
  {
    keys: ['swiss_ball', 'swiss ball', 'stability ball', 'exercise ball'],
    source: require('../../assets/images/equipment/swiss_ball.png'),
  },
  {
    keys: ['slider_discs', 'slider discs', 'sliders', 'gliding discs'],
    source: require('../../assets/images/equipment/slider_discs.png'),
  },
  {
    keys: ['wrist_roller', 'wrist roller'],
    source: require('../../assets/images/equipment/wrist_roller.png'),
  },
  {
    keys: ['slant_board', 'slant board'],
    source: require('../../assets/images/equipment/slant_board.png'),
  },
  {
    keys: [
      'assisted_pullup_machine',
      'assisted pull up dip machine',
      'assisted pullup machine',
      'assisted dip machine',
      'dip assist machine',
    ],
    source: require('../../assets/images/equipment/assisted_pullup_machine.png'),
  },
  {
    keys: [
      'pec_deck_machine',
      'pec deck machine',
      'pec dec machine',
      'pectoral fly machine',
      'pectorla fly machine',
      'chest fly machine',
      'pec fly machine',
      'pec deck',
      'pec dec',
      'pectoral fly',
    ],
    source: require('../../assets/images/equipment/pec_deck_machine.png'),
  },
  {
    keys: ['machine_row_station', 'plate loaded row machine', 'seated_row_machine', 'seated row machine', 'iso lateral row'],
    source: require('../../assets/images/equipment/plate_loaded_row_machine.png'),
  },
  {
    keys: ['captain_chair', 'captain chair', 'captains chair', 'vertical knee raise'],
    source: require('../../assets/images/equipment/captain_chair.png'),
  },
  {
    keys: ['ghd', 'glute ham developer', 'glute-ham developer'],
    source: require('../../assets/images/equipment/ghd.png'),
  },
  {
    keys: ['plate_loaded_shoulder_press_machine', 'plate loaded shoulder press machine'],
    source: require('../../assets/images/equipment/leverage_shoulder_press_machine.png'),
  },
  {
    keys: ['belt_squat_machine', 'belt squat machine'],
    source: require('../../assets/images/equipment/belt_squat_machine.png'),
  },
  {
    keys: ['leg_extension_machine', 'leg extension machine'],
    source: require('../../assets/images/equipment/leg_extension_machine.png'),
  },
  {
    keys: ['lateral_raise_machine', 'lateral raise machine', 'machine lateral raise'],
    source: require('../../assets/images/equipment/lateral_raise_machine.png'),
  },
  {
    keys: ['lat_pulldown_machine', 'lat pulldown', 'lat pull down machine'],
    source: require('../../assets/images/equipment/lat_pulldown_machine.png'),
  },
  {
    keys: ['hack_squat_machine', 'hack squat machine'],
    source: require('../../assets/images/equipment/hack_squat_machine.png'),
  },
  {
    keys: ['v_squat_machine', 'v squat machine', 'vertical squat machine', 'plate loaded v squat'],
    source: require('../../assets/images/equipment/v_squat_machine.png'),
  },
  {
    keys: ['leg_curl_machine', 'leg curl machine', 'seated hamstring curl machine'],
    source: require('../../assets/images/equipment/leg_curl_machine.png'),
  },
  {
    keys: ['shoulder_press_machine', 'shoulder press machine', 'machine shoulder press'],
    source: require('../../assets/images/equipment/shoulder_press_machine.png'),
  },
  {
    keys: ['leg_press_machine', 'leg press machine', '45 degree leg press'],
    source: require('../../assets/images/equipment/leg_press_machine.png'),
  },
  {
    keys: ['hip_abduction_machine', 'hip abduction machine', 'abductor machine'],
    source: require('../../assets/images/equipment/hip_abduction_machine.png'),
  },
  {
    keys: ['hip_adduction_machine', 'hip adduction machine', 'adductor machine'],
    source: require('../../assets/images/equipment/hip_adduction_machine.png'),
  },
  {
    keys: [
      'cable_machine',
      'cable machine',
      'single_cable_station',
      'single cable station',
      'cable column',
      'dual_cable_station',
      'dual cable station',
      'functional trainer',
      'cable crossover',
      'dual adjustable pulley',
    ],
    source: require('../../assets/images/equipment/cable_machine.png'),
  },
  {
    keys: ['hyperextension_bench', 'hyperextension bench', 'back extension bench', 'roman chair'],
    source: require('../../assets/images/equipment/hyperextension_bench.png'),
  },
  {
    keys: ['pullover_machine', 'pullover machine', 'machine pullover'],
    source: require('../../assets/images/equipment/pullover_machine.png'),
  },
  {
    keys: ['rotary_torso_machine', 'rotary torso machine', 'torso rotation machine', 'rotary trunk machine'],
    source: require('../../assets/images/equipment/rotary_torso_machine.png'),
  },
  {
    keys: ['ab_crunch_machine', 'ab crunch machine', 'crunch machine', 'seated crunch machine'],
    source: require('../../assets/images/equipment/ab_crunch_machine.png'),
  },
  {
    keys: ['preacher_curl_machine', 'preacher curl machine', 'machine preacher curl'],
    source: require('../../assets/images/equipment/preacher_curl_machine.png'),
  },
  {
    keys: ['preacher_bench', 'preacher curl bench', 'preacher bench'],
    source: require('../../assets/images/equipment/preacher_bench.png'),
  },
  {
    keys: ['chest_press_machine', 'chest press machine', 'machine chest press', 'selectorized chest press'],
    source: require('../../assets/images/equipment/chest_press_machine.png'),
  },
  {
    keys: ['tibialis_raise_machine', 'tibialis raise machine', 'tib raise machine'],
    source: require('../../assets/images/equipment/tibialis_raise_machine.png'),
  },
  {
    keys: ['swimming_pool', 'swimming pool', 'pool'],
    source: require('../../assets/images/equipment/swimming_pool.png'),
  },
  {
    keys: ['battle_ropes', 'battle ropes'],
    source: require('../../assets/images/equipment/battle_ropes.png'),
  },
  {
    keys: ['outdoor_bike', 'outdoor bike', 'bicycle'],
    source: require('../../assets/images/equipment/outdoor_bike.png'),
  },
  {
    keys: ['ruck_pack', 'ruck pack', 'ruck backpack'],
    source: require('../../assets/images/equipment/ruck_pack.png'),
  },
];

const IMAGE_BY_KEY = new Map<string, ImageSourcePropType>();
for (const entry of EQUIPMENT_IMAGE_ALIASES) {
  for (const key of entry.keys) {
    IMAGE_BY_KEY.set(normalizeEquipmentKey(key), entry.source);
  }
}

export function normalizeEquipmentKey(value: string | null | undefined): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[_/]+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function equipmentCandidateKeys(input: EquipmentVisualInput): string[] {
  if (!input) return [];
  if (typeof input === 'string') return [normalizeEquipmentKey(input)].filter(Boolean);
  return [
    input.slug,
    input.name,
    ...(input.aliases ?? []),
  ].map(normalizeEquipmentKey).filter(Boolean);
}

export function equipmentDisplayName(input: EquipmentVisualInput): string {
  if (!input) return '';
  if (typeof input === 'string') return input;
  return input.name || input.slug || '';
}

export function getEquipmentImageSource(input: EquipmentVisualInput): ImageSourcePropType | null {
  const candidates = equipmentCandidateKeys(input);
  for (const key of candidates) {
    const exact = IMAGE_BY_KEY.get(key);
    if (exact) return exact;
  }
  for (const key of candidates) {
    for (const [needle, source] of IMAGE_BY_KEY.entries()) {
      if (needle.length >= 6 && key.includes(needle)) return source;
      if (key.length >= 6 && needle.includes(key)) return source;
    }
  }
  return null;
}

export function hasEquipmentImage(input: EquipmentVisualInput): boolean {
  return !!getEquipmentImageSource(input);
}

function equipmentNeedles(input: EquipmentVisualInput): string[] {
  const keys = equipmentCandidateKeys(input);
  const expanded = new Set<string>();
  for (const key of keys) {
    expanded.add(key);
    expanded.add(key.replace(/\bmachine\b/g, '').trim());
    expanded.add(key.replace(/\bequipment\b/g, '').trim());
  }
  return [...expanded].filter(key => key.length > 0);
}

function exerciseEquipmentHaystack(exercise: ExerciseEquipmentMatchInput): string[] {
  const values: string[] = [
    exercise.equipment ?? '',
  ];
  for (const gear of exercise.gear ?? []) {
    values.push(gear.slug ?? '', gear.name ?? '');
  }
  return values.map(normalizeEquipmentKey).filter(Boolean);
}

export function equipmentMatchNeedles(input: EquipmentVisualInput): string[] {
  return equipmentNeedles(input);
}

export function exerciseEquipmentMatchKeys(exercise: ExerciseEquipmentMatchInput): string[] {
  return exerciseEquipmentHaystack(exercise);
}

export function equipmentKeySetsMatch(needles: string[], haystack: string[]): boolean {
  if (needles.length === 0 || haystack.length === 0) return false;
  for (const hay of haystack) {
    for (const needle of needles) {
      if (hay === needle) return true;
      if (needle.length >= 5 && hay.includes(needle)) return true;
      if (hay.length >= 5 && needle.includes(hay)) return true;
    }
  }
  return false;
}

export function equipmentMatchesExercise(
  equipment: EquipmentVisualInput,
  exercise: ExerciseEquipmentMatchInput,
): boolean {
  const needles = equipmentNeedles(equipment);
  const haystack = exerciseEquipmentHaystack(exercise);
  return equipmentKeySetsMatch(needles, haystack);
}

export function matchesEquipmentSearch(equipment: EquipmentVisualInput, query: string): boolean {
  const tokens = normalizeEquipmentKey(query).split(' ').filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = equipmentCandidateKeys(equipment).join(' ');
  return tokens.every(token => haystack.includes(token));
}
