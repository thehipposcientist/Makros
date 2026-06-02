export type MacroTargetKey = 'calories' | 'protein' | 'carbs' | 'fat';

export type TargetRangeStatus = 'below' | 'on_target' | 'close' | 'above' | 'logged';

export type NutritionTargetRange = {
  min: number;
  max: number;
};

export type NutritionTargetZone = 'green' | 'yellow';

const MACRO_RANGE_CONFIG: Record<MacroTargetKey, { greenLowPct: number; greenHighPct: number; yellowLowPct: number; yellowHighPct: number }> = {
  calories: { greenLowPct: 0.95, greenHighPct: 1.05, yellowLowPct: 0.90, yellowHighPct: 1.10 },
  protein: { greenLowPct: 0.95, greenHighPct: 1.00, yellowLowPct: 0.90, yellowHighPct: 1.00 },
  carbs: { greenLowPct: 0.85, greenHighPct: 1.15, yellowLowPct: 0.75, yellowHighPct: 1.25 },
  fat: { greenLowPct: 1.00, greenHighPct: 1.00, yellowLowPct: 0.90, yellowHighPct: 1.00 },
};

function finiteNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function zoneConfig(key: MacroTargetKey, zone: NutritionTargetZone) {
  const config = MACRO_RANGE_CONFIG[key];
  return zone === 'green'
    ? { lowPct: config.greenLowPct, highPct: config.greenHighPct }
    : { lowPct: config.yellowLowPct, highPct: config.yellowHighPct };
}

export function nutritionTargetRange(
  key: MacroTargetKey,
  target: number,
  zone?: NutritionTargetZone,
): NutritionTargetRange | null {
  const safeTarget = finiteNumber(target);
  if (safeTarget <= 0) return null;
  const effectiveZone = zone ?? (key === 'protein' || key === 'fat' ? 'green' : 'yellow');
  const config = zoneConfig(key, effectiveZone);
  const midpoint = Math.round(safeTarget);
  const min = Math.max(0, Math.min(midpoint, Math.ceil(safeTarget * config.lowPct)));
  const max = Math.max(midpoint, Math.floor(safeTarget * config.highPct));
  return { min, max };
}

export function nutritionTargetZones(key: MacroTargetKey, target: number): { green: NutritionTargetRange; yellow: NutritionTargetRange } | null {
  const green = nutritionTargetRange(key, target, 'green');
  const yellow = nutritionTargetRange(key, target, 'yellow');
  if (!green || !yellow) return null;
  return { green, yellow };
}

export function formatNutritionPrimaryTarget(
  key: MacroTargetKey,
  target: number,
  opts: { includeUnit?: boolean } = {},
): string {
  const safeTarget = finiteNumber(target);
  if (safeTarget <= 0) return '';
  const rounded = Math.round(safeTarget).toLocaleString();
  const includeUnit = opts.includeUnit !== false;
  if (key === 'calories') return includeUnit ? `${rounded} kcal` : rounded;
  if (key === 'protein') return includeUnit ? `${rounded}g` : rounded;
  if (key === 'fat') return includeUnit ? `${rounded}g min` : `${rounded} min`;
  return includeUnit ? `~${rounded}g` : `~${rounded}`;
}

export function formatNutritionTargetRange(
  key: MacroTargetKey,
  target: number,
  opts: { includeUnit?: boolean } = {},
): string {
  const range = nutritionTargetRange(key, target, key === 'protein' || key === 'fat' ? 'green' : 'yellow');
  if (!range) return '';
  const unit = opts.includeUnit === false || key === 'calories' ? '' : 'g';
  const min = range.min.toLocaleString();
  const max = range.max.toLocaleString();
  if (key === 'protein') return `${min}+${unit}`;
  if (key === 'fat') return `${Math.round(finiteNumber(target)).toLocaleString()}+${unit}`;
  return `${min}-${max}${unit}`;
}

export function formatNutritionTargetZones(
  key: MacroTargetKey,
  target: number,
  opts: { includeUnit?: boolean } = {},
): string {
  const zones = nutritionTargetZones(key, target);
  if (!zones) return '';
  const unit = key === 'calories'
    ? (opts.includeUnit === false ? '' : ' kcal')
    : (opts.includeUnit === false ? '' : 'g');
  const fmt = (range: NutritionTargetRange) => `${range.min.toLocaleString()}-${range.max.toLocaleString()}${unit}`;
  if (key === 'calories') {
    return `On target ${fmt(zones.green)}; close ${fmt(zones.yellow)}`;
  }
  if (key === 'protein') {
    return `On target from ${zones.green.min.toLocaleString()}${unit}+`;
  }
  if (key === 'fat') {
    return `Floor ${zones.green.min.toLocaleString()}${unit}+`;
  }
  return `Flexible ${fmt(zones.yellow)}`;
}

export function targetRangeStatus(
  key: MacroTargetKey,
  actual: number,
  target: number,
): TargetRangeStatus {
  const safeTarget = finiteNumber(target);
  if (safeTarget <= 0) return 'logged';
  const safeActual = finiteNumber(actual);
  const ratio = safeActual / safeTarget;
  const config = MACRO_RANGE_CONFIG[key];

  if (key === 'protein' || key === 'fat') {
    if (ratio >= config.greenLowPct) return 'on_target';
    if (ratio >= config.yellowLowPct) return 'close';
    return 'below';
  }
  if (ratio >= config.greenLowPct && ratio <= config.greenHighPct) return 'on_target';
  if (ratio >= config.yellowLowPct && ratio <= config.yellowHighPct) return 'close';
  return ratio < config.yellowLowPct ? 'below' : 'above';
}

export function nutritionRangeStatusText(
  key: MacroTargetKey,
  actual: number,
  target: number,
): string {
  const zones = nutritionTargetZones(key, target);
  if (!zones) return 'logged';
  const safeActual = finiteNumber(actual);
  const unit = key === 'calories' ? 'cal' : 'g';
  const status = targetRangeStatus(key, safeActual, target);
  if (status === 'on_target') {
    if (key === 'fat') return 'fat floor met';
    return 'on target';
  }
  if (status === 'close') {
    return key === 'calories' ? 'close to target' : 'close';
  }
  if (status === 'below') {
    const floor = key === 'calories' || key === 'carbs' ? zones.yellow.min : zones.green.min;
    const label = key === 'fat' ? 'floor' : 'target';
    return `${Math.round(floor - safeActual).toLocaleString()} ${unit} below ${label}`;
  }
  return `${Math.round(safeActual - zones.yellow.max).toLocaleString()} ${unit} over target`;
}
