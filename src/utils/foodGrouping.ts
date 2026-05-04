import type { FoodCategoryGroup, FoodItem } from '../hooks/useMetaData';

export type KitchenFoodLike = Pick<FoodItem, 'name'> & Partial<FoodItem>;

export interface KitchenFoodGroup {
  key: string;
  label: string;
  icon: string;
  foods: Array<{ name: string; item?: KitchenFoodLike }>;
}

export function groupKitchenFoodsByCategory(
  selectedNames: string[],
  categories: FoodCategoryGroup[],
  extraFoods: KitchenFoodLike[] = [],
): KitchenFoodGroup[] {
  const itemByName = new Map<string, KitchenFoodLike>();
  const categoryByName = new Map<string, FoodCategoryGroup>();

  for (const category of categories) {
    for (const food of category.foods) {
      const key = food.name.toLowerCase();
      itemByName.set(key, food);
      categoryByName.set(key, category);
    }
  }
  for (const food of extraFoods) {
    const key = food.name.toLowerCase();
    if (!itemByName.has(key)) itemByName.set(key, food);
  }

  const grouped = new Map<string, KitchenFoodGroup>();
  const ensureGroup = (category: Pick<FoodCategoryGroup, 'key' | 'label' | 'icon'>): KitchenFoodGroup => {
    const existing = grouped.get(category.key);
    if (existing) return existing;
    const created = { key: category.key, label: category.label, icon: category.icon, foods: [] };
    grouped.set(category.key, created);
    return created;
  };

  for (const name of selectedNames) {
    const key = name.toLowerCase();
    const category = categoryByName.get(key) ?? { key: 'custom', label: 'Custom & Added', icon: 'add-circle-outline' };
    ensureGroup(category).foods.push({ name, item: itemByName.get(key) });
  }

  return Array.from(grouped.values()).filter(group => group.foods.length > 0);
}
