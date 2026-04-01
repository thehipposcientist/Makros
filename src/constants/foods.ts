// Macros are per standard serving (as noted in the unit field)
export interface FoodItem {
  name: string;
  unit: string;       // e.g. "100g", "1 cup", "1 large"
  calories: number;
  protein: number;    // grams
  carbs: number;      // grams
  fat: number;        // grams
}

export interface FoodCategory {
  label: string;
  icon: string;
  foods: FoodItem[];
}

export const FOOD_CATEGORIES: FoodCategory[] = [
  {
    label: 'Proteins',
    icon: '🥩',
    foods: [
      { name: 'Chicken breast',  unit: '100g',   calories: 165, protein: 31, carbs: 0,  fat: 3.6 },
      { name: 'Ground beef',     unit: '100g',   calories: 215, protein: 26, carbs: 0,  fat: 13  },
      { name: 'Steak',           unit: '100g',   calories: 242, protein: 26, carbs: 0,  fat: 15  },
      { name: 'Turkey',          unit: '100g',   calories: 135, protein: 30, carbs: 0,  fat: 1   },
      { name: 'Pork loin',       unit: '100g',   calories: 182, protein: 26, carbs: 0,  fat: 8   },
      { name: 'Salmon',          unit: '100g',   calories: 208, protein: 20, carbs: 0,  fat: 13  },
      { name: 'Tuna',            unit: '100g',   calories: 116, protein: 26, carbs: 0,  fat: 1   },
      { name: 'Shrimp',          unit: '100g',   calories: 99,  protein: 24, carbs: 0,  fat: 0.3 },
      { name: 'Cod',             unit: '100g',   calories: 82,  protein: 18, carbs: 0,  fat: 0.7 },
      { name: 'Tilapia',         unit: '100g',   calories: 96,  protein: 20, carbs: 0,  fat: 1.7 },
    ],
  },
  {
    label: 'Plant Proteins',
    icon: '🌱',
    foods: [
      { name: 'Eggs',            unit: '1 large', calories: 72,  protein: 6,  carbs: 0,  fat: 5   },
      { name: 'Greek yogurt',    unit: '170g',    calories: 100, protein: 17, carbs: 6,  fat: 0.7 },
      { name: 'Cottage cheese',  unit: '100g',    calories: 98,  protein: 11, carbs: 3,  fat: 4.3 },
      { name: 'Tofu',            unit: '100g',    calories: 76,  protein: 8,  carbs: 2,  fat: 4.8 },
      { name: 'Tempeh',          unit: '100g',    calories: 193, protein: 19, carbs: 9,  fat: 11  },
      { name: 'Lentils',         unit: '1 cup',   calories: 230, protein: 18, carbs: 40, fat: 0.8 },
      { name: 'Black beans',     unit: '1 cup',   calories: 227, protein: 15, carbs: 41, fat: 0.9 },
      { name: 'Chickpeas',       unit: '1 cup',   calories: 269, protein: 15, carbs: 45, fat: 4   },
      { name: 'Edamame',         unit: '1 cup',   calories: 189, protein: 17, carbs: 16, fat: 8   },
      { name: 'Protein powder',  unit: '1 scoop', calories: 120, protein: 25, carbs: 3,  fat: 1.5 },
    ],
  },
  {
    label: 'Grains & Carbs',
    icon: '🌾',
    foods: [
      { name: 'White rice',      unit: '1 cup',   calories: 206, protein: 4,  carbs: 45, fat: 0.4 },
      { name: 'Brown rice',      unit: '1 cup',   calories: 216, protein: 5,  carbs: 45, fat: 1.8 },
      { name: 'Oats',            unit: '½ cup',   calories: 150, protein: 5,  carbs: 27, fat: 3   },
      { name: 'Pasta',           unit: '1 cup',   calories: 220, protein: 8,  carbs: 43, fat: 1.3 },
      { name: 'Quinoa',          unit: '1 cup',   calories: 222, protein: 8,  carbs: 39, fat: 4   },
      { name: 'Bread',           unit: '1 slice', calories: 79,  protein: 3,  carbs: 15, fat: 1   },
      { name: 'Sweet potato',    unit: '1 medium',calories: 103, protein: 2,  carbs: 24, fat: 0.1 },
      { name: 'Potato',          unit: '1 medium',calories: 161, protein: 4,  carbs: 37, fat: 0.2 },
      { name: 'Tortillas',       unit: '1 (10")', calories: 218, protein: 6,  carbs: 35, fat: 6   },
      { name: 'Bagels',          unit: '1 medium',calories: 270, protein: 11, carbs: 53, fat: 1.5 },
    ],
  },
  {
    label: 'Vegetables',
    icon: '🥦',
    foods: [
      { name: 'Broccoli',        unit: '1 cup',   calories: 55,  protein: 4,  carbs: 11, fat: 0.6 },
      { name: 'Spinach',         unit: '1 cup',   calories: 7,   protein: 1,  carbs: 1,  fat: 0.1 },
      { name: 'Kale',            unit: '1 cup',   calories: 33,  protein: 3,  carbs: 6,  fat: 0.5 },
      { name: 'Asparagus',       unit: '1 cup',   calories: 27,  protein: 3,  carbs: 5,  fat: 0.2 },
      { name: 'Bell peppers',    unit: '1 cup',   calories: 31,  protein: 1,  carbs: 7,  fat: 0.3 },
      { name: 'Zucchini',        unit: '1 cup',   calories: 21,  protein: 2,  carbs: 4,  fat: 0.4 },
      { name: 'Carrots',         unit: '1 cup',   calories: 52,  protein: 1,  carbs: 12, fat: 0.3 },
      { name: 'Cucumber',        unit: '1 cup',   calories: 16,  protein: 1,  carbs: 4,  fat: 0.1 },
      { name: 'Tomatoes',        unit: '1 cup',   calories: 32,  protein: 2,  carbs: 7,  fat: 0.4 },
      { name: 'Mushrooms',       unit: '1 cup',   calories: 15,  protein: 2,  carbs: 2,  fat: 0.2 },
      { name: 'Onions',          unit: '½ cup',   calories: 32,  protein: 1,  carbs: 7,  fat: 0.1 },
      { name: 'Garlic',          unit: '1 clove', calories: 4,   protein: 0,  carbs: 1,  fat: 0   },
    ],
  },
  {
    label: 'Fruits',
    icon: '🍎',
    foods: [
      { name: 'Banana',          unit: '1 medium',calories: 105, protein: 1,  carbs: 27, fat: 0.4 },
      { name: 'Apple',           unit: '1 medium',calories: 95,  protein: 0,  carbs: 25, fat: 0.3 },
      { name: 'Blueberries',     unit: '1 cup',   calories: 84,  protein: 1,  carbs: 21, fat: 0.5 },
      { name: 'Strawberries',    unit: '1 cup',   calories: 49,  protein: 1,  carbs: 12, fat: 0.5 },
      { name: 'Mango',           unit: '1 cup',   calories: 99,  protein: 1,  carbs: 25, fat: 0.6 },
      { name: 'Orange',          unit: '1 medium',calories: 62,  protein: 1,  carbs: 15, fat: 0.2 },
      { name: 'Grapes',          unit: '1 cup',   calories: 104, protein: 1,  carbs: 27, fat: 0.2 },
      { name: 'Avocado',         unit: '½ fruit', calories: 120, protein: 2,  carbs: 6,  fat: 11  },
      { name: 'Pineapple',       unit: '1 cup',   calories: 82,  protein: 1,  carbs: 22, fat: 0.2 },
      { name: 'Watermelon',      unit: '1 cup',   calories: 46,  protein: 1,  carbs: 12, fat: 0.2 },
    ],
  },
  {
    label: 'Dairy',
    icon: '🥛',
    foods: [
      { name: 'Milk',            unit: '1 cup',   calories: 149, protein: 8,  carbs: 12, fat: 8   },
      { name: 'Cheddar cheese',  unit: '28g',     calories: 113, protein: 7,  carbs: 0,  fat: 9   },
      { name: 'Mozzarella',      unit: '28g',     calories: 85,  protein: 6,  carbs: 1,  fat: 6   },
      { name: 'Butter',          unit: '1 tbsp',  calories: 102, protein: 0,  carbs: 0,  fat: 12  },
      { name: 'Heavy cream',     unit: '1 tbsp',  calories: 52,  protein: 0,  carbs: 0,  fat: 5.6 },
      { name: 'Sour cream',      unit: '2 tbsp',  calories: 60,  protein: 1,  carbs: 1,  fat: 6   },
    ],
  },
  {
    label: 'Fats & Nuts',
    icon: '🥜',
    foods: [
      { name: 'Olive oil',       unit: '1 tbsp',  calories: 119, protein: 0,  carbs: 0,  fat: 14  },
      { name: 'Coconut oil',     unit: '1 tbsp',  calories: 117, protein: 0,  carbs: 0,  fat: 14  },
      { name: 'Peanut butter',   unit: '2 tbsp',  calories: 188, protein: 8,  carbs: 6,  fat: 16  },
      { name: 'Almond butter',   unit: '2 tbsp',  calories: 196, protein: 7,  carbs: 6,  fat: 18  },
      { name: 'Almonds',         unit: '28g',     calories: 164, protein: 6,  carbs: 6,  fat: 14  },
      { name: 'Walnuts',         unit: '28g',     calories: 185, protein: 4,  carbs: 4,  fat: 18  },
      { name: 'Cashews',         unit: '28g',     calories: 157, protein: 5,  carbs: 9,  fat: 12  },
      { name: 'Chia seeds',      unit: '2 tbsp',  calories: 138, protein: 5,  carbs: 12, fat: 9   },
      { name: 'Flaxseeds',       unit: '2 tbsp',  calories: 110, protein: 4,  carbs: 6,  fat: 9   },
    ],
  },
  {
    label: 'Pantry Staples',
    icon: '🥫',
    foods: [
      { name: 'Canned tuna',     unit: '100g',    calories: 116, protein: 26, carbs: 0,  fat: 1   },
      { name: 'Canned beans',    unit: '½ cup',   calories: 110, protein: 7,  carbs: 20, fat: 0.5 },
      { name: 'Canned tomatoes', unit: '½ cup',   calories: 20,  protein: 1,  carbs: 5,  fat: 0.1 },
      { name: 'Honey',           unit: '1 tbsp',  calories: 64,  protein: 0,  carbs: 17, fat: 0   },
      { name: 'Soy sauce',       unit: '1 tbsp',  calories: 11,  protein: 2,  carbs: 1,  fat: 0   },
      { name: 'Hot sauce',       unit: '1 tsp',   calories: 1,   protein: 0,  carbs: 0,  fat: 0   },
      { name: 'Protein bars',    unit: '1 bar',   calories: 200, protein: 20, carbs: 22, fat: 7   },
    ],
  },
];

// Flat lookup by name for quick macro access
export const FOOD_MACROS: Record<string, FoodItem> = Object.fromEntries(
  FOOD_CATEGORIES.flatMap(c => c.foods).map(f => [f.name, f])
);
