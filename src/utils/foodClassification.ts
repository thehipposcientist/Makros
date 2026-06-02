import type { MealItem } from '../types';

const PROCESSING_BUCKETS = new Set(['minimally_processed', 'processed', 'ultra_processed', 'unknown']);
const FOOD_QUALITIES = new Set(['whole', 'processed', 'unknown']);
const PROTEIN_SOURCES = new Set(['plant', 'animal', 'mixed', 'none', 'unknown']);
const BOOLEAN_CLASSIFICATION_KEYS = [
  'fermented',
  'probiotic',
  'omega3_rich',
  'seafood',
  'fruit',
  'vegetable',
  'alcohol',
  'processed_meat',
  'refined_grain',
] as const;

type BooleanClassificationKey = typeof BOOLEAN_CLASSIFICATION_KEYS[number];

export type FoodClassificationPayload = {
  processing_bucket?: unknown;
  food_quality?: unknown;
  protein_source?: unknown;
  plant_count?: unknown;
} & Partial<Record<BooleanClassificationKey, unknown>>;

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function needsFoodClassification(payload: FoodClassificationPayload | null | undefined): boolean {
  if (!payload) return true;
  const bucket = cleanString(payload.processing_bucket);
  const quality = cleanString(payload.food_quality);
  const proteinSource = cleanString(payload.protein_source);
  const missingBooleanTags = BOOLEAN_CLASSIFICATION_KEYS.some(key => typeof payload[key] !== 'boolean');
  const missingPlantCount = typeof payload.plant_count !== 'number' || !Number.isFinite(payload.plant_count);
  return (
    !PROCESSING_BUCKETS.has(bucket)
    || bucket === 'unknown'
    || !PROTEIN_SOURCES.has(proteinSource)
    || (quality !== '' && (!FOOD_QUALITIES.has(quality) || quality === 'unknown'))
    || missingPlantCount
    || missingBooleanTags
  );
}

export function foodClassificationFields(payload: FoodClassificationPayload | null | undefined): Partial<MealItem> {
  const out: Partial<MealItem> = {};
  if (!payload) return out;

  const bucket = cleanString(payload.processing_bucket);
  if (PROCESSING_BUCKETS.has(bucket)) {
    out.processing_bucket = bucket as MealItem['processing_bucket'];
  }

  const quality = cleanString(payload.food_quality);
  if (FOOD_QUALITIES.has(quality)) {
    out.food_quality = quality as MealItem['food_quality'];
  } else if (quality === 'minimally_processed') {
    out.food_quality = 'whole';
  } else if (quality === 'ultra_processed') {
    out.food_quality = 'processed';
  }

  const proteinSource = cleanString(payload.protein_source);
  if (PROTEIN_SOURCES.has(proteinSource)) {
    out.protein_source = proteinSource as MealItem['protein_source'];
  }

  for (const key of BOOLEAN_CLASSIFICATION_KEYS) {
    if (typeof payload[key] === 'boolean') {
      (out as Record<BooleanClassificationKey, boolean>)[key] = payload[key] as boolean;
    }
  }

  if (typeof payload.plant_count === 'number' && Number.isFinite(payload.plant_count)) {
    out.plant_count = Math.max(0, Math.round(payload.plant_count));
  }

  return out;
}
