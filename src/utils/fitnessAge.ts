// Fitness age from VO2 Max — what age's median cardio fitness matches yours?
//
// Uses unisex 50th-percentile VO2 Max norms (ACSM / Cooper Institute, averaged
// across male/female). Consumer wellness approximation, not a clinical tool.
// A 40-year-old with VO2 Max of 45 has the cardio fitness of an average
// ~22-year-old — that's the value this returns.

interface Anchor { age: number; vo2: number }

// Anchors every decade; interpolate linearly between.
const ANCHORS: Anchor[] = [
  { age: 20, vo2: 46 },
  { age: 30, vo2: 42 },
  { age: 40, vo2: 38 },
  { age: 50, vo2: 34 },
  { age: 60, vo2: 29 },
  { age: 70, vo2: 25 },
  { age: 80, vo2: 21 },
];

export interface FitnessAgeResult {
  fitnessAge: number;
  delta: number;              // actualAge - fitnessAge; positive = younger than real
  label: 'Elite' | 'Excellent' | 'Good' | 'Average' | 'Below average';
  percentileAge: number;      // same as fitnessAge; clarifies meaning
}

export function computeFitnessAge(vo2Max: number | null, actualAge: number | null): FitnessAgeResult | null {
  if (vo2Max == null || vo2Max <= 0) return null;
  if (actualAge == null || actualAge <= 0) return null;

  // Walk anchors and interpolate.
  let fitnessAge: number;
  if (vo2Max >= ANCHORS[0].vo2) {
    fitnessAge = ANCHORS[0].age;
  } else if (vo2Max <= ANCHORS[ANCHORS.length - 1].vo2) {
    fitnessAge = ANCHORS[ANCHORS.length - 1].age;
  } else {
    fitnessAge = 80;
    for (let i = 0; i < ANCHORS.length - 1; i++) {
      const a = ANCHORS[i];
      const b = ANCHORS[i + 1];
      if (vo2Max <= a.vo2 && vo2Max >= b.vo2) {
        const t = (a.vo2 - vo2Max) / (a.vo2 - b.vo2);
        fitnessAge = Math.round(a.age + t * (b.age - a.age));
        break;
      }
    }
  }

  const delta = actualAge - fitnessAge;
  const label: FitnessAgeResult['label'] =
    delta >= 15 ? 'Elite' :
    delta >= 8  ? 'Excellent' :
    delta >= 2  ? 'Good' :
    delta >= -5 ? 'Average' : 'Below average';

  return { fitnessAge, delta, label, percentileAge: fitnessAge };
}
