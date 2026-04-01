export interface EquipmentItem {
  name: string;
  icon: string;
}

export interface EquipmentCategory {
  label: string;
  icon: string;
  items: EquipmentItem[];
}

export const EQUIPMENT_CATEGORIES: EquipmentCategory[] = [
  {
    label: 'Bodyweight & Home',
    icon: '🏠',
    items: [
      { name: 'Pull-up bar',      icon: '🔩' },
      { name: 'Resistance bands', icon: '🔗' },
      { name: 'Yoga mat',         icon: '🧘' },
      { name: 'Jump rope',        icon: '⚡' },
      { name: 'Foam roller',      icon: '🛢️' },
    ],
  },
  {
    label: 'Free Weights',
    icon: '🏋️',
    items: [
      { name: 'Dumbbells',     icon: '🏋️' },
      { name: 'Barbell',       icon: '🏋️' },
      { name: 'Kettlebell',    icon: '🔔' },
      { name: 'EZ curl bar',   icon: '〰️' },
      { name: 'Weight plates', icon: '⭕' },
    ],
  },
  {
    label: 'Benches & Racks',
    icon: '🪑',
    items: [
      { name: 'Flat bench',    icon: '🪑' },
      { name: 'Incline bench', icon: '📐' },
      { name: 'Squat rack',    icon: '🏗️' },
      { name: 'Power rack',    icon: '🏗️' },
    ],
  },
  {
    label: 'Gym Machines',
    icon: '⚙️',
    items: [
      { name: 'Cable machine',        icon: '🔗' },
      { name: 'Leg press',            icon: '🦵' },
      { name: 'Smith machine',        icon: '🏗️' },
      { name: 'Lat pulldown',         icon: '⬇️' },
      { name: 'Chest press machine',  icon: '💪' },
      { name: 'Seated row machine',   icon: '🚣' },
      { name: 'Leg extension',        icon: '🦵' },
      { name: 'Leg curl',             icon: '🦵' },
    ],
  },
  {
    label: 'Cardio',
    icon: '🏃',
    items: [
      { name: 'Treadmill',      icon: '🏃' },
      { name: 'Stationary bike', icon: '🚴' },
      { name: 'Rowing machine', icon: '🚣' },
      { name: 'Elliptical',     icon: '🔄' },
      { name: 'Stair climber',  icon: '🪜' },
    ],
  },
];

// Sets for plan generator logic
export const GYM_MACHINE_ITEMS = new Set([
  'Cable machine', 'Leg press', 'Smith machine', 'Lat pulldown',
  'Chest press machine', 'Seated row machine', 'Leg extension', 'Leg curl',
]);

export const BARBELL_ITEMS = new Set(['Barbell', 'Squat rack', 'Power rack', 'Smith machine']);
export const DUMBBELL_ITEMS = new Set(['Dumbbells', 'Kettlebell']);
