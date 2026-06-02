import type { MealSuggestion } from '../types';

export interface ProteinSourceItem {
  name: string;
  protein_g: number;
}

export interface ProteinBreakdown {
  plant_total_g: number;
  animal_total_g: number;
  plant_pct: number;
  animal_pct: number;
  plant: ProteinSourceItem[];
  animal: ProteinSourceItem[];
  unclassified: ProteinSourceItem[];
}

/**
 * Aggregate a day's protein into plant vs animal sources from each meal item's
 * `protein_source` classification ('plant' | 'animal' | 'mixed'). Items with no
 * classification but >=2g protein are surfaced as `unclassified` so the UI can
 * prompt the user. Returns null when there is no classifiable protein.
 *
 * Single source of truth for the plant-vs-meat split — used by both the
 * NutritionCard "Nutrition Overview" modal and the meals-tab macro breakdown
 * sheet so the two never drift.
 */
export function computeProteinBreakdown(meals: MealSuggestion[] | null | undefined): ProteinBreakdown | null {
  let plantG = 0;
  let animalG = 0;
  const plant: ProteinSourceItem[] = [];
  const animal: ProteinSourceItem[] = [];
  const unclassified: ProteinSourceItem[] = [];

  for (const meal of meals ?? []) {
    const items: any[] = (meal as any)?.items ?? (meal as any)?.foods ?? [];
    for (const it of items) {
      const prot = (it as any).protein_g ?? (it as any).protein ?? 0;
      if (prot <= 0) continue;
      const src = (it as any).protein_source;
      if (src === 'plant') {
        plantG += prot;
        plant.push({ name: it.name, protein_g: prot });
      } else if (src === 'animal') {
        animalG += prot;
        animal.push({ name: it.name, protein_g: prot });
      } else if (src === 'mixed') {
        plantG += prot * 0.5;
        animalG += prot * 0.5;
        plant.push({ name: it.name, protein_g: prot * 0.5 });
        animal.push({ name: it.name, protein_g: prot * 0.5 });
      } else if (prot >= 2) {
        unclassified.push({ name: it.name, protein_g: prot });
      }
    }
  }

  const total = plantG + animalG;
  if (total <= 0) return null;

  return {
    plant_total_g: Math.round(plantG),
    animal_total_g: Math.round(animalG),
    plant_pct: Math.round((plantG / total) * 100),
    animal_pct: Math.round((animalG / total) * 100),
    plant,
    animal,
    unclassified,
  };
}
