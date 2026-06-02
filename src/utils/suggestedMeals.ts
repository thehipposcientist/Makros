import type { SavedMealItem } from '../services/api';
import type { MealImageAssetKey } from './foodImage';

type DietMode = 'vegan' | 'vegetarian' | 'pescatarian' | 'keto' | 'carnivore' | 'mediterranean' | null;

type SuggestedMealTemplate = {
  id: string;
  name: string;
  notes: string;
  imageAssetKey: MealImageAssetKey;
  prepTimeMinutes?: number;
  recipeSteps?: string[];
  items: SavedMealItem[];
  keywords: string[];
  tags: string[];
  blockers: string[];
  fallbackReason: string;
};

export type SuggestedMeal = {
  id: string;
  name: string;
  notes: string;
  imageAssetKey: MealImageAssetKey;
  prepTimeMinutes: number;
  recipeSteps: string[];
  items: SavedMealItem[];
  matchedFoods: string[];
  reason: string;
  totalCalories: number;
  totalProteinG: number;
  totalCarbsG: number;
  totalFatG: number;
};

export type SuggestedMealsInput = {
  foodsAvailable?: string[] | null;
  dietaryPreference?: string | null;
  allergies?: string[] | null;
  goal?: string | null;
  existingMealNames?: string[] | null;
  limit?: number;
};

function item(
  food_name: string,
  quantity: number,
  unit: string,
  calories: number,
  protein_g: number,
  carbs_g: number,
  fat_g: number,
  micronutrients: Record<string, number> = {},
): SavedMealItem {
  return {
    food_name,
    quantity,
    unit,
    calories,
    protein_g,
    carbs_g,
    fat_g,
    micronutrients,
  };
}

const TEMPLATES: SuggestedMealTemplate[] = [
  {
    id: 'chicken-rice-power-bowl',
    name: 'Chicken Rice Power Bowl',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'chickenRice',
    keywords: ['chicken', 'rice', 'broccoli', 'avocado', 'olive oil'],
    tags: ['high_protein', 'balanced', 'meal_prep'],
    blockers: ['meat'],
    fallbackReason: 'High-protein staple',
    items: [
      item('Grilled chicken breast', 5, 'oz', 230, 43, 0, 5, { cholesterol: 120, potassium: 360 }),
      item('Brown rice', 1, 'cup', 216, 5, 45, 1.8, { fiber: 3.5, magnesium: 84 }),
      item('Broccoli', 1, 'cup', 55, 4, 11, 0.6, { fiber: 5, vitamin_c: 80 }),
      item('Avocado', 0.5, 'piece', 120, 1.5, 6, 11, { fiber: 5, potassium: 360 }),
    ],
  },
  {
    id: 'greek-yogurt-berry-bowl',
    name: 'Greek Yogurt Berry Bowl',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'yogurt',
    keywords: ['greek yogurt', 'yogurt', 'oats', 'berries', 'almonds'],
    tags: ['high_protein', 'breakfast', 'vegetarian'],
    blockers: ['dairy', 'tree_nuts'],
    fallbackReason: 'Fast breakfast',
    items: [
      item('Greek yogurt', 1, 'cup', 130, 23, 9, 0, { calcium: 250 }),
      item('Oats', 0.5, 'cup', 150, 5, 27, 3, { fiber: 4, magnesium: 56 }),
      item('Berries', 1, 'cup', 70, 1, 17, 0.5, { fiber: 5, vitamin_c: 35 }),
      item('Almonds', 0.5, 'oz', 82, 3, 3, 7, { fiber: 2, magnesium: 39 }),
    ],
  },
  {
    id: 'salmon-sweet-potato-plate',
    name: 'Salmon Sweet Potato Plate',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'salmon',
    keywords: ['salmon', 'sweet potato', 'asparagus', 'olive oil'],
    tags: ['high_protein', 'omega_3', 'pescatarian', 'mediterranean'],
    blockers: ['fish'],
    fallbackReason: 'Omega-3 pick',
    items: [
      item('Salmon', 5, 'oz', 300, 34, 0, 18, { omega_3: 2.5, vitamin_d: 12 }),
      item('Sweet potato', 1, 'piece', 112, 2, 26, 0, { fiber: 4, potassium: 440 }),
      item('Asparagus', 1, 'cup', 40, 4, 7, 0.3, { fiber: 3, folate: 70 }),
      item('Olive oil', 1, 'tsp', 40, 0, 0, 4.5),
    ],
  },
  {
    id: 'tofu-quinoa-crunch-bowl',
    name: 'Tofu Quinoa Crunch Bowl',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'veggieDinner',
    keywords: ['tofu', 'quinoa', 'edamame', 'vegetables', 'broccoli'],
    tags: ['vegan', 'plant_based', 'high_protein'],
    blockers: ['soy'],
    fallbackReason: 'Plant-protein pick',
    items: [
      item('Firm tofu', 6, 'oz', 190, 22, 5, 11, { calcium: 300, iron: 3 }),
      item('Quinoa', 1, 'cup', 222, 8, 39, 4, { fiber: 5, magnesium: 118 }),
      item('Edamame', 0.5, 'cup', 95, 9, 7, 4, { fiber: 4, folate: 240 }),
      item('Roasted vegetables', 1, 'cup', 90, 3, 16, 3, { fiber: 5 }),
    ],
  },
  {
    id: 'turkey-avocado-rice-bowl',
    name: 'Turkey Avocado Rice Bowl',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'mealPrepChicken',
    keywords: ['turkey', 'rice', 'avocado', 'spinach', 'salsa'],
    tags: ['high_protein', 'balanced', 'meal_prep'],
    blockers: ['meat'],
    fallbackReason: 'Lean meal prep',
    items: [
      item('Turkey breast', 4, 'oz', 135, 28, 1, 1, { cholesterol: 70 }),
      item('White rice', 1, 'cup', 205, 4, 45, 0.5),
      item('Avocado', 0.5, 'piece', 120, 1.5, 6, 11, { fiber: 5, potassium: 360 }),
      item('Spinach', 1, 'cup', 7, 1, 1, 0, { iron: 0.8, folate: 58 }),
      item('Salsa', 0.25, 'cup', 20, 1, 4, 0, { sodium: 250 }),
    ],
  },
  {
    id: 'lentil-hummus-quinoa-bowl',
    name: 'Lentil Hummus Quinoa Bowl',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'mediterranean',
    keywords: ['lentils', 'hummus', 'quinoa', 'chickpeas', 'cucumber', 'tomatoes'],
    tags: ['vegan', 'plant_based', 'mediterranean', 'fiber'],
    blockers: ['sesame'],
    fallbackReason: 'Fiber-forward',
    items: [
      item('Lentils', 1, 'cup', 230, 18, 40, 1, { fiber: 15, iron: 6.6 }),
      item('Quinoa', 0.5, 'cup', 111, 4, 20, 2, { fiber: 2.5, magnesium: 59 }),
      item('Hummus', 0.25, 'cup', 100, 4, 10, 6, { fiber: 3 }),
      item('Cucumber tomato mix', 1, 'cup', 40, 2, 8, 0, { fiber: 2 }),
      item('Olive oil', 1, 'tsp', 40, 0, 0, 4.5),
    ],
  },
  {
    id: 'egg-avocado-breakfast',
    name: 'Egg Avocado Breakfast',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'breakfast',
    keywords: ['eggs', 'egg whites', 'avocado', 'spinach', 'berries'],
    tags: ['vegetarian', 'breakfast', 'keto'],
    blockers: ['eggs'],
    fallbackReason: 'Low-prep breakfast',
    items: [
      item('Eggs', 2, 'piece', 144, 12, 1, 10, { vitamin_d: 2, vitamin_b12: 1.1 }),
      item('Egg whites', 2, 'piece', 34, 7, 0, 0),
      item('Avocado', 0.5, 'piece', 120, 1.5, 6, 11, { fiber: 5, potassium: 360 }),
      item('Spinach', 1, 'cup', 7, 1, 1, 0, { iron: 0.8, folate: 58 }),
      item('Berries', 0.5, 'cup', 35, 0.5, 8, 0, { fiber: 2.5 }),
    ],
  },
  {
    id: 'protein-smoothie',
    name: 'Protein Smoothie',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'smoothie',
    keywords: ['whey protein', 'protein powder', 'banana', 'berries', 'peanut butter', 'milk'],
    tags: ['high_protein', 'breakfast', 'post_workout'],
    blockers: ['dairy', 'peanuts'],
    fallbackReason: 'Post-workout easy',
    items: [
      item('Whey protein', 1, 'scoop', 120, 24, 3, 2),
      item('Banana', 1, 'piece', 105, 1, 27, 0.3, { fiber: 3, potassium: 420 }),
      item('Berries', 1, 'cup', 70, 1, 17, 0.5, { fiber: 5, vitamin_c: 35 }),
      item('Peanut butter', 1, 'tbsp', 95, 4, 3, 8, { magnesium: 25 }),
      item('Skim milk', 1, 'cup', 90, 8, 12, 0, { calcium: 300 }),
    ],
  },
  {
    id: 'tuna-chickpea-salad',
    name: 'Tuna Chickpea Salad',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'tunaSalad',
    keywords: ['tuna', 'chickpeas', 'greens', 'salad', 'olive oil'],
    tags: ['high_protein', 'pescatarian', 'mediterranean'],
    blockers: ['fish'],
    fallbackReason: 'Quick lunch',
    items: [
      item('Tuna', 1, 'can', 140, 32, 0, 1, { omega_3: 0.6, selenium: 70 }),
      item('Chickpeas', 0.5, 'cup', 135, 7, 22, 2, { fiber: 6, iron: 2.4 }),
      item('Mixed greens', 2, 'cup', 20, 2, 4, 0, { fiber: 2, folate: 80 }),
      item('Olive oil lemon dressing', 1, 'tbsp', 80, 0, 1, 9),
    ],
  },
  {
    id: 'steak-potato-plate',
    name: 'Steak Potato Plate',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'steak',
    keywords: ['steak', 'sirloin', 'potato', 'spinach', 'olive oil'],
    tags: ['high_protein', 'balanced'],
    blockers: ['meat', 'beef'],
    fallbackReason: 'Iron-rich dinner',
    items: [
      item('Sirloin steak', 5, 'oz', 310, 40, 0, 14, { iron: 3.2, zinc: 7 }),
      item('Potato', 1, 'piece', 160, 4, 37, 0, { fiber: 4, potassium: 900 }),
      item('Spinach', 1, 'cup', 7, 1, 1, 0, { iron: 0.8, folate: 58 }),
      item('Olive oil', 1, 'tsp', 40, 0, 0, 4.5),
    ],
  },
  {
    id: 'steak-eggs-skillet',
    name: 'Steak Eggs Skillet',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'steak',
    keywords: ['steak', 'sirloin', 'eggs', 'butter'],
    tags: ['high_protein', 'keto', 'carnivore'],
    blockers: ['meat', 'beef', 'eggs', 'dairy'],
    fallbackReason: 'Low-carb protein',
    items: [
      item('Sirloin steak', 5, 'oz', 310, 40, 0, 14, { iron: 3.2, zinc: 7 }),
      item('Eggs', 2, 'piece', 144, 12, 1, 10, { vitamin_d: 2, vitamin_b12: 1.1 }),
      item('Butter', 1, 'tsp', 34, 0, 0, 4),
    ],
  },
  {
    id: 'shrimp-mango-rice-bowl',
    name: 'Shrimp Mango Rice Bowl',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'burrito',
    prepTimeMinutes: 22,
    keywords: ['shrimp', 'rice', 'mango', 'cabbage', 'avocado'],
    tags: ['high_protein', 'pescatarian', 'balanced'],
    blockers: ['shellfish'],
    fallbackReason: 'Light protein bowl',
    items: [
      item('Shrimp', 6, 'oz', 170, 34, 2, 2, { selenium: 45 }),
      item('Jasmine rice', 1, 'cup', 205, 4, 45, 0.5),
      item('Mango salsa', 0.5, 'cup', 70, 1, 17, 0, { vitamin_c: 28 }),
      item('Cabbage slaw', 1, 'cup', 35, 2, 8, 0, { fiber: 3 }),
      item('Avocado', 0.25, 'piece', 60, 1, 3, 5.5, { fiber: 2.5 }),
    ],
  },
  {
    id: 'chicken-caesar-wrap',
    name: 'Chicken Caesar Wrap',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'caesar',
    prepTimeMinutes: 15,
    keywords: ['chicken', 'tortilla', 'romaine', 'parmesan', 'caesar'],
    tags: ['high_protein', 'quick_lunch'],
    blockers: ['meat', 'dairy', 'gluten'],
    fallbackReason: 'Portable lunch',
    items: [
      item('Grilled chicken breast', 5, 'oz', 230, 43, 0, 5, { cholesterol: 120 }),
      item('Whole wheat tortilla', 1, 'piece', 150, 5, 28, 4, { fiber: 4 }),
      item('Romaine lettuce', 2, 'cup', 16, 1, 3, 0, { folate: 128 }),
      item('Parmesan', 1, 'tbsp', 22, 2, 0, 1.5, { calcium: 60 }),
      item('Light Caesar dressing', 1, 'tbsp', 60, 1, 1, 6, { sodium: 170 }),
    ],
  },
  {
    id: 'black-bean-burrito-bowl',
    name: 'Black Bean Burrito Bowl',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'burrito',
    prepTimeMinutes: 18,
    keywords: ['black beans', 'beans', 'rice', 'corn', 'salsa', 'avocado'],
    tags: ['vegan', 'plant_based', 'fiber', 'balanced'],
    blockers: [],
    fallbackReason: 'Plant-fiber staple',
    items: [
      item('Black beans', 1, 'cup', 227, 15, 41, 1, { fiber: 15, iron: 3.6 }),
      item('Brown rice', 0.75, 'cup', 162, 4, 34, 1.4, { fiber: 2.6 }),
      item('Corn', 0.5, 'cup', 72, 2, 16, 1, { fiber: 2 }),
      item('Salsa', 0.25, 'cup', 20, 1, 4, 0, { sodium: 250 }),
      item('Avocado', 0.25, 'piece', 60, 1, 3, 5.5, { fiber: 2.5 }),
    ],
  },
  {
    id: 'cottage-cheese-peach-toast',
    name: 'Cottage Cheese Peach Toast',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'breakfast',
    prepTimeMinutes: 8,
    keywords: ['cottage cheese', 'toast', 'peach', 'honey', 'walnuts'],
    tags: ['high_protein', 'breakfast', 'vegetarian'],
    blockers: ['dairy', 'gluten', 'tree_nuts'],
    fallbackReason: 'Quick sweet breakfast',
    items: [
      item('Cottage cheese', 1, 'cup', 180, 25, 10, 5, { calcium: 180 }),
      item('Whole grain toast', 2, 'slice', 160, 8, 28, 3, { fiber: 5 }),
      item('Peach', 1, 'piece', 60, 1, 15, 0, { vitamin_c: 10 }),
      item('Walnuts', 0.5, 'oz', 93, 2, 2, 9, { omega_3: 1.3 }),
    ],
  },
  {
    id: 'turkey-chili-bowl',
    name: 'Turkey Chili Bowl',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'mealPrepChicken',
    prepTimeMinutes: 30,
    keywords: ['turkey', 'beans', 'tomatoes', 'rice', 'cheddar'],
    tags: ['high_protein', 'meal_prep', 'fiber'],
    blockers: ['meat', 'dairy'],
    fallbackReason: 'Meal-prep warmer',
    items: [
      item('Lean ground turkey', 5, 'oz', 210, 34, 0, 8, { cholesterol: 95 }),
      item('Kidney beans', 0.75, 'cup', 169, 11, 30, 1, { fiber: 10 }),
      item('Crushed tomatoes', 0.75, 'cup', 60, 3, 13, 0, { potassium: 420 }),
      item('Brown rice', 0.5, 'cup', 108, 3, 22, 1, { fiber: 1.8 }),
      item('Cheddar', 0.5, 'oz', 57, 3.5, 0, 4.7, { calcium: 100 }),
    ],
  },
  {
    id: 'mediterranean-egg-plate',
    name: 'Mediterranean Egg Plate',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'mediterranean',
    prepTimeMinutes: 12,
    keywords: ['eggs', 'hummus', 'pita', 'cucumber', 'tomatoes', 'feta'],
    tags: ['vegetarian', 'mediterranean', 'breakfast'],
    blockers: ['eggs', 'dairy', 'gluten', 'sesame'],
    fallbackReason: 'Mediterranean breakfast',
    items: [
      item('Eggs', 2, 'piece', 144, 12, 1, 10, { vitamin_d: 2, vitamin_b12: 1.1 }),
      item('Hummus', 0.25, 'cup', 100, 4, 10, 6, { fiber: 3 }),
      item('Whole wheat pita', 1, 'piece', 170, 6, 35, 2, { fiber: 5 }),
      item('Cucumber tomato mix', 1, 'cup', 40, 2, 8, 0, { fiber: 2 }),
      item('Feta', 0.5, 'oz', 40, 2, 1, 3, { calcium: 70 }),
    ],
  },
  {
    id: 'tempeh-peanut-noodle-bowl',
    name: 'Tempeh Peanut Noodle Bowl',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'noodle',
    prepTimeMinutes: 24,
    keywords: ['tempeh', 'noodles', 'peanut butter', 'broccoli', 'carrots'],
    tags: ['vegan', 'plant_based', 'high_protein'],
    blockers: ['soy', 'peanuts', 'gluten'],
    fallbackReason: 'Plant-protein noodles',
    items: [
      item('Tempeh', 5, 'oz', 270, 27, 14, 15, { iron: 3.8 }),
      item('Soba noodles', 1, 'cup', 113, 6, 24, 0.1, { fiber: 3 }),
      item('Broccoli', 1, 'cup', 55, 4, 11, 0.6, { fiber: 5 }),
      item('Carrots', 0.5, 'cup', 25, 0.5, 6, 0, { vitamin_a: 535 }),
      item('Peanut sauce', 1, 'tbsp', 95, 3, 4, 8, { magnesium: 25 }),
    ],
  },
  {
    id: 'beef-taco-sweet-potato-bowl',
    name: 'Beef Taco Sweet Potato Bowl',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'steak',
    prepTimeMinutes: 25,
    keywords: ['beef', 'sweet potato', 'lettuce', 'salsa', 'avocado'],
    tags: ['high_protein', 'balanced'],
    blockers: ['meat', 'beef'],
    fallbackReason: 'Iron-rich taco bowl',
    items: [
      item('Lean ground beef', 5, 'oz', 260, 34, 0, 13, { iron: 3.3, zinc: 6 }),
      item('Sweet potato', 1, 'piece', 112, 2, 26, 0, { fiber: 4 }),
      item('Romaine lettuce', 2, 'cup', 16, 1, 3, 0, { folate: 128 }),
      item('Salsa', 0.25, 'cup', 20, 1, 4, 0, { sodium: 250 }),
      item('Avocado', 0.25, 'piece', 60, 1, 3, 5.5, { fiber: 2.5 }),
    ],
  },
  {
    id: 'pesto-chicken-pasta',
    name: 'Pesto Chicken Pasta',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'pasta',
    prepTimeMinutes: 25,
    keywords: ['chicken', 'pasta', 'pesto', 'tomatoes', 'parmesan'],
    tags: ['high_protein', 'balanced'],
    blockers: ['meat', 'dairy', 'gluten', 'tree_nuts'],
    fallbackReason: 'Higher-carb training meal',
    items: [
      item('Grilled chicken breast', 5, 'oz', 230, 43, 0, 5, { cholesterol: 120 }),
      item('Whole wheat pasta', 1.25, 'cup', 218, 9, 45, 2, { fiber: 7 }),
      item('Cherry tomatoes', 1, 'cup', 27, 1, 6, 0, { vitamin_c: 18 }),
      item('Pesto', 1, 'tbsp', 80, 1, 1, 8),
      item('Parmesan', 1, 'tbsp', 22, 2, 0, 1.5, { calcium: 60 }),
    ],
  },
  {
    id: 'sardine-avocado-toast',
    name: 'Sardine Avocado Toast',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'tunaSalad',
    prepTimeMinutes: 10,
    keywords: ['sardines', 'toast', 'avocado', 'greens', 'lemon'],
    tags: ['high_protein', 'omega_3', 'pescatarian', 'mediterranean'],
    blockers: ['fish', 'gluten'],
    fallbackReason: 'Omega-3 toast',
    items: [
      item('Sardines', 1, 'can', 190, 23, 0, 10, { omega_3: 1.5, vitamin_d: 4.8, calcium: 325 }),
      item('Whole grain toast', 2, 'slice', 160, 8, 28, 3, { fiber: 5 }),
      item('Avocado', 0.25, 'piece', 60, 1, 3, 5.5, { fiber: 2.5 }),
      item('Mixed greens', 1, 'cup', 10, 1, 2, 0, { folate: 40 }),
    ],
  },
  {
    id: 'paneer-lentil-curry-bowl',
    name: 'Paneer Lentil Curry Bowl',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'quinoa',
    prepTimeMinutes: 28,
    keywords: ['paneer', 'lentils', 'rice', 'spinach', 'curry'],
    tags: ['vegetarian', 'high_protein', 'fiber'],
    blockers: ['dairy'],
    fallbackReason: 'Vegetarian comfort bowl',
    items: [
      item('Paneer', 3, 'oz', 240, 15, 4, 18, { calcium: 330 }),
      item('Lentils', 0.75, 'cup', 173, 14, 30, 1, { fiber: 11, iron: 5 }),
      item('Basmati rice', 0.5, 'cup', 102, 2, 22, 0.3),
      item('Spinach', 1, 'cup', 7, 1, 1, 0, { iron: 0.8, folate: 58 }),
      item('Curry sauce', 0.25, 'cup', 70, 1, 8, 4, { sodium: 240 }),
    ],
  },
  {
    id: 'protein-overnight-oats',
    name: 'Protein Overnight Oats',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'oatmeal',
    prepTimeMinutes: 6,
    keywords: ['oats', 'greek yogurt', 'protein powder', 'berries', 'chia'],
    tags: ['high_protein', 'breakfast', 'vegetarian', 'meal_prep'],
    blockers: ['dairy'],
    fallbackReason: 'Make-ahead breakfast',
    items: [
      item('Oats', 0.5, 'cup', 150, 5, 27, 3, { fiber: 4, magnesium: 56 }),
      item('Greek yogurt', 0.75, 'cup', 98, 17, 7, 0, { calcium: 188 }),
      item('Protein powder', 0.5, 'scoop', 60, 12, 2, 1),
      item('Berries', 0.75, 'cup', 53, 1, 13, 0.4, { fiber: 4 }),
      item('Chia seeds', 1, 'tbsp', 58, 2, 5, 4, { fiber: 5, omega_3: 2.5 }),
    ],
  },
  {
    id: 'chickpea-avocado-sandwich',
    name: 'Chickpea Avocado Sandwich',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'salad',
    prepTimeMinutes: 12,
    keywords: ['chickpeas', 'avocado', 'bread', 'cucumber', 'greens'],
    tags: ['vegan', 'plant_based', 'fiber'],
    blockers: ['gluten'],
    fallbackReason: 'Plant lunch',
    items: [
      item('Chickpeas', 0.75, 'cup', 202, 11, 34, 3, { fiber: 9, iron: 3.6 }),
      item('Avocado', 0.25, 'piece', 60, 1, 3, 5.5, { fiber: 2.5 }),
      item('Whole grain bread', 2, 'slice', 160, 8, 28, 3, { fiber: 5 }),
      item('Cucumber', 0.5, 'cup', 8, 0, 2, 0, { fiber: 0.5 }),
      item('Mixed greens', 1, 'cup', 10, 1, 2, 0, { folate: 40 }),
    ],
  },
  {
    id: 'pork-pineapple-rice-bowl',
    name: 'Pork Pineapple Rice Bowl',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'chickenRice',
    prepTimeMinutes: 24,
    keywords: ['pork', 'rice', 'pineapple', 'peppers', 'broccoli'],
    tags: ['high_protein', 'balanced'],
    blockers: ['meat', 'pork'],
    fallbackReason: 'Sweet-savory bowl',
    items: [
      item('Pork tenderloin', 5, 'oz', 206, 34, 0, 6, { thiamin: 0.9 }),
      item('White rice', 1, 'cup', 205, 4, 45, 0.5),
      item('Pineapple', 0.5, 'cup', 41, 0, 11, 0, { vitamin_c: 40 }),
      item('Bell peppers', 1, 'cup', 39, 1, 9, 0, { vitamin_c: 152 }),
      item('Broccoli', 0.75, 'cup', 41, 3, 8, 0.5, { fiber: 3.8 }),
    ],
  },
  {
    id: 'keto-chicken-salad-cups',
    name: 'Keto Chicken Salad Cups',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'chicken',
    prepTimeMinutes: 12,
    keywords: ['chicken', 'lettuce', 'avocado', 'celery', 'olive oil'],
    tags: ['high_protein', 'keto', 'low_carb'],
    blockers: ['meat'],
    fallbackReason: 'Low-carb lunch',
    items: [
      item('Grilled chicken breast', 5, 'oz', 230, 43, 0, 5, { cholesterol: 120 }),
      item('Butter lettuce', 4, 'leaf', 10, 1, 2, 0, { folate: 26 }),
      item('Avocado', 0.5, 'piece', 120, 1.5, 6, 11, { fiber: 5 }),
      item('Celery', 0.5, 'cup', 8, 0, 2, 0, { fiber: 1 }),
      item('Olive oil lemon dressing', 1, 'tbsp', 80, 0, 1, 9),
    ],
  },

  // ── Pool expansion (Phase 1) ────────────────────────────────────────────
  // Fills the obvious gaps in the seed-26 library: zero snacks, thin
  // Asian / Indian / Italian / Mediterranean coverage, no explicit
  // post-workout option, very few quick (< 10 min) entries.

  // Breakfasts
  {
    id: 'savory-oatmeal-bowl',
    name: 'Savory Oatmeal Bowl',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'oatmeal',
    prepTimeMinutes: 12,
    keywords: ['oats', 'eggs', 'spinach', 'avocado', 'parmesan'],
    tags: ['high_protein', 'breakfast', 'vegetarian'],
    blockers: ['eggs', 'dairy'],
    fallbackReason: 'Savory breakfast',
    items: [
      item('Oats', 0.5, 'cup', 150, 5, 27, 3, { fiber: 4, magnesium: 56 }),
      item('Eggs', 2, 'piece', 144, 12, 1, 10, { vitamin_d: 2, vitamin_b12: 1.1 }),
      item('Spinach', 1, 'cup', 7, 1, 1, 0, { iron: 0.8, folate: 58 }),
      item('Avocado', 0.25, 'piece', 60, 1, 3, 5.5, { fiber: 2.5 }),
      item('Parmesan', 1, 'tbsp', 22, 2, 0, 1.5, { calcium: 60 }),
    ],
  },
  {
    id: 'breakfast-burrito',
    name: 'Breakfast Burrito',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'burrito',
    prepTimeMinutes: 15,
    keywords: ['eggs', 'black beans', 'tortilla', 'salsa', 'cheddar'],
    tags: ['high_protein', 'breakfast', 'vegetarian'],
    blockers: ['eggs', 'dairy', 'gluten'],
    fallbackReason: 'Portable breakfast',
    items: [
      item('Eggs', 2, 'piece', 144, 12, 1, 10, { vitamin_d: 2, vitamin_b12: 1.1 }),
      item('Black beans', 0.5, 'cup', 114, 8, 21, 0.5, { fiber: 8, iron: 1.8 }),
      item('Whole wheat tortilla', 1, 'piece', 150, 5, 28, 4, { fiber: 4 }),
      item('Salsa', 0.25, 'cup', 20, 1, 4, 0, { sodium: 250 }),
      item('Cheddar', 0.5, 'oz', 57, 3.5, 0, 4.7, { calcium: 100 }),
    ],
  },
  {
    id: 'berry-almond-smoothie-bowl',
    name: 'Berry Almond Smoothie Bowl',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'breakfastSmoothie',
    prepTimeMinutes: 8,
    keywords: ['berries', 'banana', 'almond milk', 'almond butter', 'oats', 'chia'],
    tags: ['vegan', 'plant_based', 'breakfast'],
    blockers: ['tree_nuts'],
    fallbackReason: 'Plant breakfast bowl',
    items: [
      item('Berries', 1, 'cup', 70, 1, 17, 0.5, { fiber: 5, vitamin_c: 35 }),
      item('Banana', 1, 'piece', 105, 1, 27, 0.3, { fiber: 3, potassium: 420 }),
      item('Almond milk', 1, 'cup', 30, 1, 1, 2.5, { calcium: 450 }),
      item('Almond butter', 1, 'tbsp', 98, 3.5, 3, 9, { magnesium: 50 }),
      item('Oats', 0.25, 'cup', 75, 2.5, 13, 1.5, { fiber: 2 }),
      item('Chia seeds', 1, 'tbsp', 58, 2, 5, 4, { fiber: 5, omega_3: 2.5 }),
    ],
  },
  {
    id: 'avocado-toast-eggs',
    name: 'Avocado Toast with Eggs',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'breakfast',
    prepTimeMinutes: 10,
    keywords: ['avocado', 'eggs', 'bread', 'tomato', 'lemon'],
    tags: ['high_protein', 'breakfast', 'vegetarian', 'mediterranean'],
    blockers: ['eggs', 'gluten'],
    fallbackReason: 'Cafe-style breakfast',
    items: [
      item('Whole grain bread', 2, 'slice', 160, 8, 28, 3, { fiber: 5 }),
      item('Avocado', 0.5, 'piece', 120, 1.5, 6, 11, { fiber: 5, potassium: 360 }),
      item('Eggs', 2, 'piece', 144, 12, 1, 10, { vitamin_d: 2, vitamin_b12: 1.1 }),
      item('Cherry tomatoes', 0.5, 'cup', 14, 1, 3, 0, { vitamin_c: 9 }),
    ],
  },
  {
    id: 'tofu-scramble-plate',
    name: 'Tofu Scramble Plate',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'breakfast',
    prepTimeMinutes: 15,
    keywords: ['tofu', 'spinach', 'peppers', 'turmeric', 'toast'],
    tags: ['vegan', 'plant_based', 'high_protein', 'breakfast'],
    blockers: ['soy', 'gluten'],
    fallbackReason: 'Plant high-protein breakfast',
    items: [
      item('Firm tofu', 5, 'oz', 158, 18, 4, 9, { calcium: 250, iron: 2.5 }),
      item('Spinach', 1, 'cup', 7, 1, 1, 0, { iron: 0.8, folate: 58 }),
      item('Bell peppers', 0.5, 'cup', 19, 0.5, 4.5, 0, { vitamin_c: 76 }),
      item('Whole grain toast', 1, 'slice', 80, 4, 14, 1.5, { fiber: 2.5 }),
      item('Avocado', 0.25, 'piece', 60, 1, 3, 5.5, { fiber: 2.5 }),
    ],
  },

  // Lunches
  {
    id: 'mediterranean-falafel-bowl',
    name: 'Mediterranean Falafel Bowl',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'mediterranean',
    prepTimeMinutes: 20,
    keywords: ['falafel', 'chickpeas', 'hummus', 'cucumber', 'tomatoes', 'tabouli'],
    tags: ['vegetarian', 'vegan', 'plant_based', 'mediterranean', 'fiber'],
    blockers: ['sesame'],
    fallbackReason: 'Mediterranean plant bowl',
    items: [
      item('Falafel', 4, 'piece', 230, 8, 26, 11, { fiber: 6, iron: 2.4 }),
      item('Hummus', 0.25, 'cup', 100, 4, 10, 6, { fiber: 3 }),
      item('Cucumber tomato mix', 1, 'cup', 40, 2, 8, 0, { fiber: 2 }),
      item('Tabouli', 0.5, 'cup', 80, 2, 14, 2, { fiber: 3 }),
      item('Olive oil', 1, 'tsp', 40, 0, 0, 4.5),
    ],
  },
  {
    id: 'tuna-poke-bowl',
    name: 'Tuna Poke Bowl',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'tunaSalad',
    prepTimeMinutes: 18,
    keywords: ['tuna', 'rice', 'edamame', 'cucumber', 'seaweed', 'avocado'],
    tags: ['high_protein', 'pescatarian', 'omega_3'],
    blockers: ['fish', 'soy'],
    fallbackReason: 'Fresh omega-3 bowl',
    items: [
      item('Ahi tuna', 5, 'oz', 130, 28, 0, 1, { omega_3: 0.5, selenium: 60 }),
      item('Sushi rice', 1, 'cup', 240, 4, 53, 0.4),
      item('Edamame', 0.5, 'cup', 95, 9, 7, 4, { fiber: 4, folate: 240 }),
      item('Cucumber', 0.5, 'cup', 8, 0, 2, 0, { fiber: 0.5 }),
      item('Avocado', 0.25, 'piece', 60, 1, 3, 5.5, { fiber: 2.5 }),
      item('Seaweed', 1, 'tbsp', 5, 0, 1, 0),
    ],
  },
  {
    id: 'chicken-burrito-bowl',
    name: 'Chicken Burrito Bowl',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'burrito',
    prepTimeMinutes: 22,
    keywords: ['chicken', 'rice', 'black beans', 'salsa', 'corn', 'avocado'],
    tags: ['high_protein', 'balanced', 'meal_prep'],
    blockers: ['meat'],
    fallbackReason: 'Mexican high-protein bowl',
    items: [
      item('Grilled chicken breast', 5, 'oz', 230, 43, 0, 5, { cholesterol: 120 }),
      item('White rice', 0.75, 'cup', 154, 3, 34, 0.4),
      item('Black beans', 0.5, 'cup', 114, 8, 21, 0.5, { fiber: 8, iron: 1.8 }),
      item('Salsa', 0.25, 'cup', 20, 1, 4, 0, { sodium: 250 }),
      item('Corn', 0.5, 'cup', 72, 2, 16, 1, { fiber: 2 }),
      item('Avocado', 0.25, 'piece', 60, 1, 3, 5.5, { fiber: 2.5 }),
    ],
  },
  {
    id: 'lentil-vegetable-soup',
    name: 'Lentil Vegetable Soup',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'mediterranean',
    prepTimeMinutes: 30,
    keywords: ['lentils', 'carrots', 'celery', 'tomatoes', 'bread'],
    tags: ['vegan', 'plant_based', 'fiber'],
    blockers: ['gluten'],
    fallbackReason: 'Hearty plant soup',
    items: [
      item('Lentils', 1, 'cup', 230, 18, 40, 1, { fiber: 15, iron: 6.6 }),
      item('Carrots', 0.5, 'cup', 25, 0.5, 6, 0, { vitamin_a: 535 }),
      item('Celery', 0.5, 'cup', 8, 0, 2, 0, { fiber: 1 }),
      item('Crushed tomatoes', 0.5, 'cup', 40, 2, 9, 0, { potassium: 280 }),
      item('Whole grain bread', 1, 'slice', 80, 4, 14, 1.5, { fiber: 2.5 }),
      item('Olive oil', 1, 'tsp', 40, 0, 0, 4.5),
    ],
  },
  {
    id: 'turkey-blt-sandwich',
    name: 'Turkey BLT Sandwich',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'salad',
    prepTimeMinutes: 10,
    keywords: ['turkey', 'bacon', 'lettuce', 'tomato', 'bread', 'mayo'],
    tags: ['high_protein'],
    blockers: ['meat', 'pork', 'gluten'],
    fallbackReason: 'Classic protein lunch',
    items: [
      item('Turkey breast', 4, 'oz', 135, 28, 1, 1, { cholesterol: 70 }),
      item('Bacon', 2, 'slice', 80, 6, 0, 6),
      item('Romaine lettuce', 1, 'cup', 8, 1, 2, 0, { folate: 64 }),
      item('Tomato', 0.5, 'cup', 16, 1, 3, 0, { vitamin_c: 13 }),
      item('Whole grain bread', 2, 'slice', 160, 8, 28, 3, { fiber: 5 }),
      item('Mayo', 1, 'tsp', 30, 0, 0, 3.3),
    ],
  },

  // Dinners — global cuisines
  {
    id: 'beef-stir-fry-rice',
    name: 'Beef Stir Fry with Rice',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'noodle',
    prepTimeMinutes: 22,
    keywords: ['beef', 'broccoli', 'rice', 'soy sauce', 'ginger'],
    tags: ['high_protein', 'balanced'],
    blockers: ['meat', 'beef', 'soy'],
    fallbackReason: 'Asian high-protein bowl',
    items: [
      item('Lean ground beef', 5, 'oz', 260, 34, 0, 13, { iron: 3.3, zinc: 6 }),
      item('Brown rice', 1, 'cup', 216, 5, 45, 1.8, { fiber: 3.5 }),
      item('Broccoli', 1, 'cup', 55, 4, 11, 0.6, { fiber: 5 }),
      item('Soy ginger sauce', 1, 'tbsp', 25, 1, 4, 0.5, { sodium: 400 }),
    ],
  },
  {
    id: 'chicken-tikka-masala',
    name: 'Chicken Tikka Masala',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'quinoa',
    prepTimeMinutes: 30,
    keywords: ['chicken', 'rice', 'tomato', 'cream', 'spices', 'curry'],
    tags: ['high_protein', 'balanced'],
    blockers: ['meat', 'dairy'],
    fallbackReason: 'Spiced comfort bowl',
    items: [
      item('Grilled chicken breast', 5, 'oz', 230, 43, 0, 5, { cholesterol: 120 }),
      item('Basmati rice', 1, 'cup', 205, 4, 45, 0.5),
      item('Tikka masala sauce', 0.5, 'cup', 180, 3, 14, 12, { sodium: 480 }),
      item('Spinach', 1, 'cup', 7, 1, 1, 0, { iron: 0.8, folate: 58 }),
    ],
  },
  {
    id: 'sheet-pan-chicken-veggies',
    name: 'Sheet Pan Chicken & Veggies',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'mealPrepChicken',
    prepTimeMinutes: 35,
    keywords: ['chicken', 'sweet potato', 'broccoli', 'olive oil', 'onion'],
    tags: ['high_protein', 'meal_prep', 'balanced'],
    blockers: ['meat'],
    fallbackReason: 'One-pan dinner',
    items: [
      item('Chicken thigh', 5, 'oz', 290, 30, 0, 19, { iron: 1.6 }),
      item('Sweet potato', 1, 'piece', 112, 2, 26, 0, { fiber: 4, potassium: 440 }),
      item('Broccoli', 1, 'cup', 55, 4, 11, 0.6, { fiber: 5 }),
      item('Red onion', 0.25, 'cup', 16, 0.5, 4, 0, { vitamin_c: 2 }),
      item('Olive oil', 1, 'tsp', 40, 0, 0, 4.5),
    ],
  },
  {
    id: 'spaghetti-bolognese',
    name: 'Spaghetti Bolognese',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'pasta',
    prepTimeMinutes: 30,
    keywords: ['ground beef', 'pasta', 'marinara', 'parmesan'],
    tags: ['high_protein', 'balanced'],
    blockers: ['meat', 'beef', 'gluten', 'dairy'],
    fallbackReason: 'Italian classic',
    items: [
      item('Lean ground beef', 4, 'oz', 208, 27, 0, 10, { iron: 2.6 }),
      item('Whole wheat pasta', 1.25, 'cup', 218, 9, 45, 2, { fiber: 7 }),
      item('Marinara sauce', 0.5, 'cup', 70, 2, 13, 1, { potassium: 380 }),
      item('Parmesan', 1, 'tbsp', 22, 2, 0, 1.5, { calcium: 60 }),
    ],
  },
  {
    id: 'cod-white-bean-stew',
    name: 'Cod & White Bean Stew',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'mediterranean',
    prepTimeMinutes: 28,
    keywords: ['cod', 'white beans', 'kale', 'tomatoes', 'garlic'],
    tags: ['high_protein', 'pescatarian', 'mediterranean', 'fiber'],
    blockers: ['fish'],
    fallbackReason: 'Mediterranean fish stew',
    items: [
      item('Cod', 5, 'oz', 130, 29, 0, 1, { vitamin_b12: 1.5, selenium: 50 }),
      item('White beans', 0.75, 'cup', 187, 12, 33, 0.5, { fiber: 9, iron: 4 }),
      item('Kale', 1, 'cup', 33, 3, 7, 0.5, { vitamin_c: 80 }),
      item('Crushed tomatoes', 0.5, 'cup', 40, 2, 9, 0, { potassium: 280 }),
      item('Olive oil', 1, 'tsp', 40, 0, 0, 4.5),
    ],
  },
  {
    id: 'teriyaki-salmon-bowl',
    name: 'Teriyaki Salmon Bowl',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'salmon',
    prepTimeMinutes: 25,
    keywords: ['salmon', 'rice', 'broccoli', 'teriyaki', 'sesame'],
    tags: ['high_protein', 'pescatarian', 'omega_3'],
    blockers: ['fish', 'soy', 'sesame'],
    fallbackReason: 'Japanese-style omega-3',
    items: [
      item('Salmon', 5, 'oz', 300, 34, 0, 18, { omega_3: 2.5, vitamin_d: 12 }),
      item('Brown rice', 1, 'cup', 216, 5, 45, 1.8, { fiber: 3.5 }),
      item('Broccoli', 1, 'cup', 55, 4, 11, 0.6, { fiber: 5 }),
      item('Teriyaki sauce', 1, 'tbsp', 30, 1, 6, 0, { sodium: 520 }),
      item('Sesame seeds', 1, 'tsp', 17, 0.5, 0.7, 1.5, { calcium: 30 }),
    ],
  },
  {
    id: 'bbq-chicken-salad',
    name: 'BBQ Chicken Salad',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'caesar',
    prepTimeMinutes: 18,
    keywords: ['chicken', 'romaine', 'corn', 'black beans', 'bbq', 'cheddar'],
    tags: ['high_protein', 'balanced'],
    blockers: ['meat', 'dairy'],
    fallbackReason: 'BBQ protein salad',
    items: [
      item('Grilled chicken breast', 5, 'oz', 230, 43, 0, 5, { cholesterol: 120 }),
      item('Romaine lettuce', 2, 'cup', 16, 1, 3, 0, { folate: 128 }),
      item('Corn', 0.5, 'cup', 72, 2, 16, 1, { fiber: 2 }),
      item('Black beans', 0.5, 'cup', 114, 8, 21, 0.5, { fiber: 8, iron: 1.8 }),
      item('BBQ sauce', 1, 'tbsp', 30, 0, 7, 0, { sodium: 175 }),
      item('Cheddar', 0.5, 'oz', 57, 3.5, 0, 4.7, { calcium: 100 }),
    ],
  },
  {
    id: 'chickpea-vegetable-curry',
    name: 'Chickpea Vegetable Curry',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'quinoa',
    prepTimeMinutes: 26,
    keywords: ['chickpeas', 'rice', 'spinach', 'tomatoes', 'curry', 'coconut'],
    tags: ['vegan', 'plant_based', 'fiber', 'high_protein'],
    blockers: [],
    fallbackReason: 'Plant curry bowl',
    items: [
      item('Chickpeas', 1, 'cup', 270, 15, 45, 4, { fiber: 13, iron: 4.7 }),
      item('Basmati rice', 0.75, 'cup', 154, 3, 34, 0.4),
      item('Spinach', 1, 'cup', 7, 1, 1, 0, { iron: 0.8, folate: 58 }),
      item('Tomatoes', 0.5, 'cup', 16, 1, 3, 0, { vitamin_c: 13 }),
      item('Coconut curry sauce', 0.25, 'cup', 90, 1, 6, 7, { sodium: 230 }),
    ],
  },

  // Snacks (the seed library had ZERO of these)
  {
    id: 'apple-almond-butter-snack',
    name: 'Apple & Almond Butter',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'breakfast',
    prepTimeMinutes: 3,
    keywords: ['apple', 'almond butter'],
    tags: ['snack', 'vegan', 'plant_based', 'fiber'],
    blockers: ['tree_nuts'],
    fallbackReason: 'Quick fiber snack',
    items: [
      item('Apple', 1, 'piece', 95, 0.5, 25, 0.3, { fiber: 4.5 }),
      item('Almond butter', 1, 'tbsp', 98, 3.5, 3, 9, { magnesium: 50 }),
    ],
  },
  {
    id: 'cottage-cheese-pineapple-snack',
    name: 'Cottage Cheese & Pineapple',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'yogurt',
    prepTimeMinutes: 2,
    keywords: ['cottage cheese', 'pineapple'],
    tags: ['snack', 'high_protein', 'vegetarian'],
    blockers: ['dairy'],
    fallbackReason: 'High-protein sweet snack',
    items: [
      item('Cottage cheese', 0.75, 'cup', 135, 19, 7.5, 4, { calcium: 135 }),
      item('Pineapple', 0.5, 'cup', 41, 0, 11, 0, { vitamin_c: 40 }),
    ],
  },
  {
    id: 'hard-boiled-eggs-veggies',
    name: 'Hard-Boiled Eggs & Veggie Sticks',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'salad',
    prepTimeMinutes: 5,
    keywords: ['eggs', 'carrots', 'celery', 'hummus'],
    tags: ['snack', 'high_protein', 'vegetarian', 'low_carb'],
    blockers: ['eggs', 'sesame'],
    fallbackReason: 'Protein-forward snack',
    items: [
      item('Hard-boiled eggs', 2, 'piece', 144, 12, 1, 10, { vitamin_d: 2, vitamin_b12: 1.1 }),
      item('Carrot sticks', 1, 'cup', 50, 1, 12, 0, { vitamin_a: 1070 }),
      item('Celery sticks', 1, 'cup', 16, 1, 3, 0, { fiber: 2 }),
      item('Hummus', 2, 'tbsp', 50, 2, 5, 3, { fiber: 1.5 }),
    ],
  },
  {
    id: 'greek-yogurt-honey-walnuts',
    name: 'Greek Yogurt with Honey & Walnuts',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'yogurt',
    prepTimeMinutes: 3,
    keywords: ['greek yogurt', 'honey', 'walnuts'],
    tags: ['snack', 'high_protein', 'vegetarian'],
    blockers: ['dairy', 'tree_nuts'],
    fallbackReason: 'Sweet protein snack',
    items: [
      item('Greek yogurt', 0.75, 'cup', 98, 17, 7, 0, { calcium: 188 }),
      item('Honey', 1, 'tsp', 21, 0, 6, 0),
      item('Walnuts', 0.25, 'oz', 47, 1, 1, 4.5, { omega_3: 0.65 }),
    ],
  },

  // Quick + post-workout
  {
    id: 'chocolate-banana-protein-shake',
    name: 'Chocolate Banana Protein Shake',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'smoothie',
    prepTimeMinutes: 5,
    keywords: ['whey protein', 'protein powder', 'banana', 'milk', 'cocoa'],
    tags: ['high_protein', 'post_workout', 'breakfast'],
    blockers: ['dairy'],
    fallbackReason: 'Post-workout shake',
    items: [
      item('Whey protein', 1, 'scoop', 120, 24, 3, 2),
      item('Banana', 1, 'piece', 105, 1, 27, 0.3, { fiber: 3, potassium: 420 }),
      item('Skim milk', 1, 'cup', 90, 8, 12, 0, { calcium: 300 }),
      item('Cocoa powder', 1, 'tbsp', 12, 1, 3, 0.7, { iron: 0.8 }),
    ],
  },
  {
    id: 'rice-cakes-pb-banana',
    name: 'Rice Cakes with PB & Banana',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'breakfast',
    prepTimeMinutes: 3,
    keywords: ['rice cakes', 'peanut butter', 'banana'],
    tags: ['snack', 'post_workout', 'vegan', 'plant_based'],
    blockers: ['peanuts'],
    fallbackReason: 'Quick carb + protein snack',
    items: [
      item('Rice cakes', 2, 'piece', 70, 1.5, 14, 0.5),
      item('Peanut butter', 1, 'tbsp', 95, 4, 3, 8, { magnesium: 25 }),
      item('Banana', 0.5, 'piece', 53, 0.5, 13, 0.2, { potassium: 210 }),
    ],
  },
  {
    id: 'tuna-cracker-plate',
    name: 'Tuna Cracker Plate',
    notes: 'Suggested from your food preferences.',
    imageAssetKey: 'tunaSalad',
    prepTimeMinutes: 5,
    keywords: ['tuna', 'crackers', 'cucumber', 'lemon'],
    tags: ['snack', 'high_protein', 'pescatarian'],
    blockers: ['fish', 'gluten'],
    fallbackReason: 'Quick fish snack',
    items: [
      item('Tuna', 1, 'can', 140, 32, 0, 1, { omega_3: 0.6, selenium: 70 }),
      item('Whole grain crackers', 6, 'piece', 120, 2, 18, 4, { fiber: 2 }),
      item('Cucumber', 0.5, 'cup', 8, 0, 2, 0, { fiber: 0.5 }),
    ],
  },
];

export const SUGGESTED_MEAL_TEMPLATE_COUNT = TEMPLATES.length;

const ALLERGEN_ALIASES: Record<string, string> = {
  nut: 'tree_nuts',
  nuts: 'tree_nuts',
  tree_nut: 'tree_nuts',
  tree_nuts: 'tree_nuts',
  peanut: 'peanuts',
  peanuts: 'peanuts',
  egg: 'eggs',
  eggs: 'eggs',
  dairy: 'dairy',
  gluten: 'gluten',
  soy: 'soy',
  fish: 'fish',
  shellfish: 'shellfish',
  sesame: 'sesame',
  pork: 'pork',
  beef: 'beef',
};

function normalize(value: string | null | undefined): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeAllergen(value: string): string {
  const key = normalize(value).replace(/\s+/g, '_');
  return ALLERGEN_ALIASES[key] ?? key;
}

function dietMode(value: string | null | undefined): DietMode {
  const pref = normalize(value);
  if (!pref) return null;
  if (/\b(vegan|plant based|plantbased)\b/.test(pref)) return 'vegan';
  if (/\bvegetarian\b/.test(pref)) return 'vegetarian';
  if (/\bpescatarian\b/.test(pref)) return 'pescatarian';
  if (/\b(keto|low carb|lowcarb)\b/.test(pref)) return 'keto';
  if (/\bcarnivore\b/.test(pref)) return 'carnivore';
  if (/\bmediterranean\b/.test(pref)) return 'mediterranean';
  return null;
}

function violatesDiet(template: SuggestedMealTemplate, mode: DietMode): boolean {
  const blockers = new Set(template.blockers);
  if (mode === 'vegan') return blockers.has('meat') || blockers.has('fish') || blockers.has('shellfish') || blockers.has('dairy') || blockers.has('eggs');
  if (mode === 'vegetarian') return blockers.has('meat') || blockers.has('fish') || blockers.has('shellfish');
  if (mode === 'pescatarian') return blockers.has('meat') || blockers.has('pork') || blockers.has('beef');
  if (mode === 'carnivore') return !template.tags.includes('carnivore');
  return false;
}

function matchingFoods(template: SuggestedMealTemplate, foodsAvailable: string[]): string[] {
  const normalizedFoods = foodsAvailable
    .map(food => ({ raw: food, normalized: normalize(food) }))
    .filter(food => food.normalized.length > 0);
  const matches: string[] = [];
  for (const keyword of template.keywords) {
    const key = normalize(keyword);
    const match = normalizedFoods.find(food => food.normalized.includes(key) || key.includes(food.normalized));
    if (match && !matches.includes(match.raw)) matches.push(match.raw);
  }
  return matches.slice(0, 3);
}

function totals(items: SavedMealItem[]) {
  return items.reduce(
    (acc, next) => ({
      calories: acc.calories + Number(next.calories ?? 0),
      protein: acc.protein + Number(next.protein_g ?? 0),
      carbs: acc.carbs + Number(next.carbs_g ?? 0),
      fat: acc.fat + Number(next.fat_g ?? 0),
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );
}

function titleCase(value: string): string {
  return value.replace(/\w\S*/g, part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase());
}

function reasonFor(template: SuggestedMealTemplate, matches: string[], mode: DietMode): string {
  if (matches.length > 0) return `Matches ${matches.slice(0, 2).map(titleCase).join(', ')}`;
  if (mode === 'vegan' && template.tags.includes('vegan')) return 'Plant-based pick';
  if (mode === 'vegetarian' && template.tags.includes('vegetarian')) return 'Vegetarian pick';
  if (mode === 'pescatarian' && template.tags.includes('pescatarian')) return 'Pescatarian pick';
  if (mode === 'keto' && template.tags.includes('keto')) return 'Low-carb pick';
  if (mode === 'carnivore' && template.tags.includes('carnivore')) return 'Carnivore pick';
  if (mode === 'mediterranean' && template.tags.includes('mediterranean')) return 'Mediterranean pick';
  return template.fallbackReason;
}

function recipeStepsFor(template: SuggestedMealTemplate): string[] {
  if (template.recipeSteps?.length) return template.recipeSteps;
  const ingredients = template.items.map(it => it.food_name);
  const protein = ingredients.find(name => /chicken|turkey|salmon|tuna|shrimp|steak|beef|pork|egg|tofu|tempeh|lentil|bean|chickpea|yogurt|cottage|paneer|sardine|whey|protein/i.test(name));
  const base = ingredients.find(name => /rice|quinoa|oat|toast|bread|tortilla|pita|pasta|noodle|potato|beans|lentils/i.test(name));
  const plants = ingredients.filter(name => /broccoli|spinach|greens|asparagus|berries|banana|avocado|vegetable|cucumber|tomato|lettuce|slaw|mango|peach|pepper|pineapple|cabbage|celery|corn/i.test(name));
  return [
    `Cook or warm ${base ?? ingredients[0]} and prep ${protein ?? ingredients[1] ?? ingredients[0]}.`,
    plants.length > 0
      ? `Add ${plants.slice(0, 2).join(' and ')} for volume, fiber, and color.`
      : 'Combine the main ingredients in a bowl or plate.',
    'Finish with the fat or sauce component, season to taste, and portion as listed.',
  ];
}

function scoreTemplate(
  template: SuggestedMealTemplate,
  matches: string[],
  mode: DietMode,
  goal: string | null | undefined,
): number {
  let score = matches.length * 8;
  if (mode && template.tags.includes(mode)) score += 6;
  if (mode === 'vegan' && template.tags.includes('plant_based')) score += 5;
  if (mode === 'vegetarian' && template.tags.includes('vegetarian')) score += 4;
  const normalizedGoal = normalize(goal);
  if (/\b(strength|muscle|bulk|hypertrophy|performance)\b/.test(normalizedGoal) && template.tags.includes('high_protein')) score += 3;
  if (/\b(fat loss|cut|lean|weight)\b/.test(normalizedGoal) && (template.tags.includes('high_protein') || template.tags.includes('fiber'))) score += 2;
  return score;
}

export function buildSuggestedMeals(input: SuggestedMealsInput = {}): SuggestedMeal[] {
  const mode = dietMode(input.dietaryPreference);
  const blockedAllergens = new Set((input.allergies ?? []).map(normalizeAllergen));
  const existingNames = new Set((input.existingMealNames ?? []).map(normalize));
  const limit = Math.max(1, input.limit ?? 5);
  const maxPerMatchSignature = 2;

  const ranked = TEMPLATES
    .map((template, index) => {
      const matches = matchingFoods(template, input.foodsAvailable ?? []);
      return {
        template,
        index,
        matches,
        score: scoreTemplate(template, matches, mode, input.goal),
      };
    })
    .filter(({ template }) => !existingNames.has(normalize(template.name)))
    .filter(({ template }) => !template.blockers.some(blocker => blockedAllergens.has(normalizeAllergen(blocker))))
    .filter(({ template }) => !violatesDiet(template, mode))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const selected: typeof ranked = [];
  const deferred: typeof ranked = [];
  const signatureCounts = new Map<string, number>();
  for (const row of ranked) {
    const signature = row.matches.map(normalize).sort().join('|');
    const count = signature ? (signatureCounts.get(signature) ?? 0) : 0;
    if (signature && count >= maxPerMatchSignature) {
      deferred.push(row);
      continue;
    }
    selected.push(row);
    if (signature) signatureCounts.set(signature, count + 1);
    if (selected.length >= limit) break;
  }

  return [...selected, ...deferred]
    .slice(0, limit)
    .map(({ template, matches }) => {
      const macroTotals = totals(template.items);
      return {
        id: template.id,
        name: template.name,
        notes: template.notes,
        imageAssetKey: template.imageAssetKey,
        prepTimeMinutes: template.prepTimeMinutes ?? 15,
        recipeSteps: recipeStepsFor(template),
        items: template.items,
        matchedFoods: matches,
        reason: reasonFor(template, matches, mode),
        totalCalories: Math.round(macroTotals.calories),
        totalProteinG: Math.round(macroTotals.protein),
        totalCarbsG: Math.round(macroTotals.carbs),
        totalFatG: Math.round(macroTotals.fat),
      };
    });
}
