"""
Seed food data — structured for FoodNutrition + FoodServings + FoodAliases.

Each entry is a dict:
  name:      Display name
  category:  FoodCategory enum value string
  nutrition: Per-100g macros: {calories, protein, carbs, fat, fiber?, sugar?, sodium_mg?}
  servings:  List of {label, grams, is_default?} — first entry is default if none flagged
  aliases:   List of alternate search terms

To add a new food, just append to the appropriate list below.
To add a whole new category file later, create seed_foods_<category>.py and
import its list into SEED_FOODS in this file.

Macro validation: calories should ≈ protein*4 + carbs*4 + fat*9 (±10%).
The seeder will warn on mismatches but still insert.
"""

from app.enums import FoodCategory

# ─── Animal Proteins ─────────────────────────────────────────────────────────

PROTEINS = [
    {
        "name": "Chicken Breast",
        "category": FoodCategory.PROTEINS,
        "nutrition": {"calories": 165, "protein": 31, "carbs": 0, "fat": 3.6, "fiber": 0},
        "servings": [
            {"label": "100g", "grams": 100, "is_default": True},
            {"label": "4 oz (small breast)", "grams": 113},
            {"label": "6 oz (medium breast)", "grams": 170},
            {"label": "8 oz (large breast)", "grams": 227},
        ],
        "aliases": ["chicken", "grilled chicken", "baked chicken", "chicken breast skinless"],
    },
    {
        "name": "Chicken Thighs",
        "category": FoodCategory.PROTEINS,
        "nutrition": {"calories": 209, "protein": 26, "carbs": 0, "fat": 11},
        "servings": [
            {"label": "100g", "grams": 100, "is_default": True},
            {"label": "1 thigh (bone-in)", "grams": 130},
            {"label": "1 thigh (boneless)", "grams": 115},
        ],
        "aliases": ["chicken thigh", "dark meat chicken"],
    },
    {
        "name": "Ground Beef (Lean 93/7)",
        "category": FoodCategory.PROTEINS,
        "nutrition": {"calories": 176, "protein": 26, "carbs": 0, "fat": 7},
        "servings": [
            {"label": "100g", "grams": 100, "is_default": True},
            {"label": "4 oz patty", "grams": 113},
            {"label": "6 oz serving", "grams": 170},
        ],
        "aliases": ["ground beef", "lean ground beef", "extra lean beef", "hamburger meat"],
    },
    {
        "name": "Ground Beef (80/20)",
        "category": FoodCategory.PROTEINS,
        "nutrition": {"calories": 254, "protein": 26, "carbs": 0, "fat": 17},
        "servings": [
            {"label": "100g", "grams": 100, "is_default": True},
            {"label": "4 oz patty", "grams": 113},
        ],
        "aliases": ["regular ground beef", "80 20 beef"],
    },
    {
        "name": "Sirloin Steak",
        "category": FoodCategory.PROTEINS,
        "nutrition": {"calories": 207, "protein": 26, "carbs": 0, "fat": 11},
        "servings": [
            {"label": "100g", "grams": 100, "is_default": True},
            {"label": "6 oz steak", "grams": 170},
            {"label": "8 oz steak", "grams": 227},
        ],
        "aliases": ["steak", "sirloin", "beef steak", "grilled steak"],
    },
    {
        "name": "Turkey Breast",
        "category": FoodCategory.PROTEINS,
        "nutrition": {"calories": 135, "protein": 30, "carbs": 0, "fat": 1},
        "servings": [
            {"label": "100g", "grams": 100, "is_default": True},
            {"label": "4 oz", "grams": 113},
            {"label": "6 oz", "grams": 170},
        ],
        "aliases": ["turkey", "roasted turkey", "turkey breast sliced"],
    },
    {
        "name": "Deli Turkey",
        "category": FoodCategory.PROTEINS,
        "nutrition": {"calories": 106, "protein": 21, "carbs": 1.8, "fat": 1, "sodium_mg": 900},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "2 oz (4 slices)", "grams": 57, "is_default": True},
        ],
        "aliases": ["turkey deli", "sliced turkey", "turkey slices", "lunch meat turkey"],
    },
    {
        "name": "Rotisserie Chicken",
        "category": FoodCategory.PROTEINS,
        "nutrition": {"calories": 185, "protein": 27, "carbs": 0, "fat": 8},
        "servings": [
            {"label": "100g", "grams": 100, "is_default": True},
            {"label": "1/4 chicken", "grams": 200},
            {"label": "1 drumstick", "grams": 95},
        ],
        "aliases": ["store bought chicken", "whole roasted chicken"],
    },
    {
        "name": "Pork Loin",
        "category": FoodCategory.PROTEINS,
        "nutrition": {"calories": 182, "protein": 26, "carbs": 0, "fat": 8},
        "servings": [
            {"label": "100g", "grams": 100, "is_default": True},
            {"label": "4 oz", "grams": 113},
            {"label": "6 oz chop", "grams": 170},
        ],
        "aliases": ["pork", "pork chop", "pork tenderloin"],
    },
    {
        "name": "Salmon",
        "category": FoodCategory.PROTEINS,
        "nutrition": {"calories": 208, "protein": 20, "carbs": 0, "fat": 13, "fiber": 0},
        "servings": [
            {"label": "100g", "grams": 100, "is_default": True},
            {"label": "4 oz fillet", "grams": 113},
            {"label": "6 oz fillet", "grams": 170},
        ],
        "aliases": ["atlantic salmon", "grilled salmon", "baked salmon", "salmon fillet"],
    },
    {
        "name": "Tuna (canned in water)",
        "category": FoodCategory.PROTEINS,
        "nutrition": {"calories": 116, "protein": 26, "carbs": 0, "fat": 1},
        "servings": [
            {"label": "100g", "grams": 100, "is_default": True},
            {"label": "1 can (5 oz drained)", "grams": 142},
            {"label": "1 packet (2.6 oz)", "grams": 74},
        ],
        "aliases": ["tuna", "canned tuna", "tuna fish", "tuna packet"],
    },
    {
        "name": "Shrimp",
        "category": FoodCategory.PROTEINS,
        "nutrition": {"calories": 99, "protein": 24, "carbs": 0, "fat": 0.3},
        "servings": [
            {"label": "100g", "grams": 100, "is_default": True},
            {"label": "6 large shrimp", "grams": 84},
            {"label": "12 medium shrimp", "grams": 84},
        ],
        "aliases": ["prawns", "grilled shrimp"],
    },
    {
        "name": "Cod",
        "category": FoodCategory.PROTEINS,
        "nutrition": {"calories": 82, "protein": 18, "carbs": 0, "fat": 0.7},
        "servings": [
            {"label": "100g", "grams": 100, "is_default": True},
            {"label": "6 oz fillet", "grams": 170},
        ],
        "aliases": ["cod fish", "baked cod", "white fish"],
    },
    {
        "name": "Tilapia",
        "category": FoodCategory.PROTEINS,
        "nutrition": {"calories": 96, "protein": 20, "carbs": 0, "fat": 1.7},
        "servings": [
            {"label": "100g", "grams": 100, "is_default": True},
            {"label": "1 fillet (4 oz)", "grams": 113},
        ],
        "aliases": ["tilapia fillet"],
    },
    {
        "name": "Eggs",
        "category": FoodCategory.PROTEINS,
        "nutrition": {"calories": 143, "protein": 13, "carbs": 0.7, "fat": 10},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 large egg", "grams": 50, "is_default": True},
            {"label": "2 large eggs", "grams": 100},
            {"label": "3 large eggs", "grams": 150},
        ],
        "aliases": ["egg", "whole egg", "scrambled eggs", "fried egg", "boiled egg", "hard boiled egg"],
    },
    {
        "name": "Egg Whites",
        "category": FoodCategory.PROTEINS,
        "nutrition": {"calories": 52, "protein": 11, "carbs": 0.7, "fat": 0.2},
        "servings": [
            {"label": "100g", "grams": 100, "is_default": True},
            {"label": "1 large egg white", "grams": 33},
            {"label": "1/2 cup liquid", "grams": 121},
        ],
        "aliases": ["egg white", "whites only"],
    },
    {
        "name": "Protein Powder (Whey)",
        "category": FoodCategory.PROTEINS,
        "nutrition": {"calories": 375, "protein": 78, "carbs": 9, "fat": 4.7},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 scoop (32g)", "grams": 32, "is_default": True},
            {"label": "2 scoops", "grams": 64},
        ],
        "aliases": ["whey protein", "protein shake", "protein powder", "whey", "protein scoop"],
    },
    {
        "name": "Protein Bar",
        "category": FoodCategory.PROTEINS,
        "nutrition": {"calories": 333, "protein": 33, "carbs": 35, "fat": 12},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 bar (60g)", "grams": 60, "is_default": True},
        ],
        "aliases": ["quest bar", "kind bar", "rx bar", "one bar"],
    },
    {
        "name": "Chicken Sausage",
        "category": FoodCategory.PROTEINS,
        "nutrition": {"calories": 165, "protein": 18, "carbs": 3.5, "fat": 8},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 link (85g)", "grams": 85, "is_default": True},
        ],
        "aliases": ["chicken sausage link", "aidells chicken sausage"],
    },
    {
        "name": "Sardines (canned in oil)",
        "category": FoodCategory.PROTEINS,
        "nutrition": {"calories": 208, "protein": 25, "carbs": 0, "fat": 11},
        "servings": [
            {"label": "100g", "grams": 100, "is_default": True},
            {"label": "1 can (3.75 oz)", "grams": 106},
        ],
        "aliases": ["sardines", "canned sardines"],
    },
    {
        "name": "Ham",
        "category": FoodCategory.PROTEINS,
        "nutrition": {"calories": 145, "protein": 21, "carbs": 1.5, "fat": 5.5, "sodium_mg": 1200},
        "servings": [
            {"label": "100g", "grams": 100, "is_default": True},
            {"label": "3 oz (2 slices)", "grams": 85},
        ],
        "aliases": ["deli ham", "sliced ham", "ham slices"],
    },
]

# ─── Dairy ───────────────────────────────────────────────────────────────────

DAIRY = [
    {
        "name": "Greek Yogurt (Nonfat)",
        "category": FoodCategory.DAIRY,
        "nutrition": {"calories": 59, "protein": 10, "carbs": 3.6, "fat": 0.4, "sugar": 3.2},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 cup (170g)", "grams": 170, "is_default": True},
            {"label": "1 container (150g)", "grams": 150},
        ],
        "aliases": ["greek yogurt", "yogurt", "plain yogurt", "nonfat yogurt", "fage", "chobani"],
    },
    {
        "name": "Cottage Cheese (2%)",
        "category": FoodCategory.DAIRY,
        "nutrition": {"calories": 86, "protein": 12, "carbs": 4.3, "fat": 2.3},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1/2 cup (113g)", "grams": 113, "is_default": True},
            {"label": "1 cup (226g)", "grams": 226},
        ],
        "aliases": ["cottage cheese", "low fat cottage cheese"],
    },
    {
        "name": "Cheddar Cheese",
        "category": FoodCategory.DAIRY,
        "nutrition": {"calories": 403, "protein": 25, "carbs": 1.3, "fat": 33},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 oz (28g)", "grams": 28, "is_default": True},
            {"label": "1 slice (21g)", "grams": 21},
            {"label": "1/4 cup shredded (28g)", "grams": 28},
        ],
        "aliases": ["cheddar", "sharp cheddar", "shredded cheddar"],
    },
    {
        "name": "Mozzarella Cheese",
        "category": FoodCategory.DAIRY,
        "nutrition": {"calories": 280, "protein": 28, "carbs": 3.1, "fat": 17},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 oz (28g)", "grams": 28, "is_default": True},
            {"label": "1 string cheese (28g)", "grams": 28},
            {"label": "1/4 cup shredded (28g)", "grams": 28},
        ],
        "aliases": ["mozzarella", "string cheese", "cheese stick", "part skim mozzarella"],
    },
    {
        "name": "Parmesan Cheese",
        "category": FoodCategory.DAIRY,
        "nutrition": {"calories": 431, "protein": 38, "carbs": 4.1, "fat": 29},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 tbsp grated (5g)", "grams": 5, "is_default": True},
            {"label": "1 oz (28g)", "grams": 28},
        ],
        "aliases": ["parmesan", "parmigiano", "grated parmesan"],
    },
    {
        "name": "Butter",
        "category": FoodCategory.DAIRY,
        "nutrition": {"calories": 717, "protein": 0.9, "carbs": 0.1, "fat": 81},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 tbsp (14g)", "grams": 14, "is_default": True},
            {"label": "1 pat (5g)", "grams": 5},
        ],
        "aliases": ["salted butter", "unsalted butter"],
    },
    {
        "name": "Whole Milk",
        "category": FoodCategory.DAIRY,
        "nutrition": {"calories": 61, "protein": 3.2, "carbs": 4.8, "fat": 3.3},
        "servings": [
            {"label": "100ml", "grams": 100},
            {"label": "1 cup (244ml)", "grams": 244, "is_default": True},
            {"label": "1/2 cup", "grams": 122},
        ],
        "aliases": ["milk", "whole milk", "full fat milk"],
    },
    {
        "name": "2% Milk",
        "category": FoodCategory.DAIRY,
        "nutrition": {"calories": 50, "protein": 3.3, "carbs": 4.9, "fat": 2},
        "servings": [
            {"label": "100ml", "grams": 100},
            {"label": "1 cup (244ml)", "grams": 244, "is_default": True},
        ],
        "aliases": ["reduced fat milk", "2 percent milk", "semi skimmed milk"],
    },
    {
        "name": "Skim Milk",
        "category": FoodCategory.DAIRY,
        "nutrition": {"calories": 34, "protein": 3.4, "carbs": 5, "fat": 0.1},
        "servings": [
            {"label": "100ml", "grams": 100},
            {"label": "1 cup (244ml)", "grams": 244, "is_default": True},
        ],
        "aliases": ["nonfat milk", "fat free milk", "skimmed milk"],
    },
    {
        "name": "Almond Milk (Unsweetened)",
        "category": FoodCategory.DAIRY,
        "nutrition": {"calories": 13, "protein": 0.4, "carbs": 0.3, "fat": 1.1},
        "servings": [
            {"label": "100ml", "grams": 100},
            {"label": "1 cup (240ml)", "grams": 240, "is_default": True},
        ],
        "aliases": ["almond milk", "unsweetened almond milk"],
    },
    {
        "name": "Cream Cheese",
        "category": FoodCategory.DAIRY,
        "nutrition": {"calories": 342, "protein": 6, "carbs": 4, "fat": 34},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 tbsp (14g)", "grams": 14, "is_default": True},
            {"label": "2 tbsp (28g)", "grams": 28},
        ],
        "aliases": ["cream cheese", "philly cream cheese"],
    },
]

# ─── Plant Proteins ──────────────────────────────────────────────────────────

PLANT_PROTEINS = [
    {
        "name": "Tofu (Firm)",
        "category": FoodCategory.PLANT_PROTEINS,
        "nutrition": {"calories": 76, "protein": 8, "carbs": 1.9, "fat": 4.8},
        "servings": [
            {"label": "100g", "grams": 100, "is_default": True},
            {"label": "1/2 block (150g)", "grams": 150},
            {"label": "1 cup cubed (126g)", "grams": 126},
        ],
        "aliases": ["tofu", "bean curd", "firm tofu"],
    },
    {
        "name": "Tempeh",
        "category": FoodCategory.PLANT_PROTEINS,
        "nutrition": {"calories": 193, "protein": 19, "carbs": 9, "fat": 11},
        "servings": [
            {"label": "100g", "grams": 100, "is_default": True},
            {"label": "3 oz (85g)", "grams": 85},
        ],
        "aliases": ["tempeh", "soy tempeh"],
    },
    {
        "name": "Lentils (Cooked)",
        "category": FoodCategory.PLANT_PROTEINS,
        "nutrition": {"calories": 116, "protein": 9, "carbs": 20, "fat": 0.4, "fiber": 8},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 cup (198g)", "grams": 198, "is_default": True},
            {"label": "1/2 cup", "grams": 99},
        ],
        "aliases": ["lentils", "red lentils", "green lentils", "brown lentils"],
    },
    {
        "name": "Black Beans (Cooked)",
        "category": FoodCategory.PLANT_PROTEINS,
        "nutrition": {"calories": 132, "protein": 8.9, "carbs": 24, "fat": 0.5, "fiber": 8.7},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 cup (172g)", "grams": 172, "is_default": True},
            {"label": "1/2 cup", "grams": 86},
        ],
        "aliases": ["black beans", "canned black beans"],
    },
    {
        "name": "Chickpeas (Cooked)",
        "category": FoodCategory.PLANT_PROTEINS,
        "nutrition": {"calories": 164, "protein": 8.9, "carbs": 27, "fat": 2.6, "fiber": 7.6},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 cup (164g)", "grams": 164, "is_default": True},
            {"label": "1/2 cup", "grams": 82},
        ],
        "aliases": ["chickpeas", "garbanzo beans", "canned chickpeas"],
    },
    {
        "name": "Edamame (Shelled)",
        "category": FoodCategory.PLANT_PROTEINS,
        "nutrition": {"calories": 121, "protein": 12, "carbs": 9, "fat": 5.2, "fiber": 5.2},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 cup (155g)", "grams": 155, "is_default": True},
        ],
        "aliases": ["edamame", "soybeans", "soy beans"],
    },
    {
        "name": "Hummus",
        "category": FoodCategory.PLANT_PROTEINS,
        "nutrition": {"calories": 166, "protein": 8, "carbs": 14, "fat": 10},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "2 tbsp (30g)", "grams": 30, "is_default": True},
            {"label": "1/4 cup (60g)", "grams": 60},
        ],
        "aliases": ["hummus", "chickpea dip"],
    },
    {
        "name": "Kidney Beans (Cooked)",
        "category": FoodCategory.PLANT_PROTEINS,
        "nutrition": {"calories": 127, "protein": 8.7, "carbs": 23, "fat": 0.5, "fiber": 6.4},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 cup (177g)", "grams": 177, "is_default": True},
        ],
        "aliases": ["kidney beans", "red beans"],
    },
]

# ─── Grains & Carbs ──────────────────────────────────────────────────────────

GRAINS_CARBS = [
    {
        "name": "White Rice (Cooked)",
        "category": FoodCategory.GRAINS_CARBS,
        "nutrition": {"calories": 130, "protein": 2.7, "carbs": 28, "fat": 0.3},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 cup (158g)", "grams": 158, "is_default": True},
            {"label": "1/2 cup", "grams": 79},
        ],
        "aliases": ["white rice", "rice", "steamed rice", "plain rice"],
    },
    {
        "name": "Brown Rice (Cooked)",
        "category": FoodCategory.GRAINS_CARBS,
        "nutrition": {"calories": 112, "protein": 2.6, "carbs": 24, "fat": 0.9},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 cup (195g)", "grams": 195, "is_default": True},
            {"label": "1/2 cup", "grams": 98},
        ],
        "aliases": ["brown rice", "whole grain rice"],
    },
    {
        "name": "Oats (Dry)",
        "category": FoodCategory.GRAINS_CARBS,
        "nutrition": {"calories": 389, "protein": 17, "carbs": 66, "fat": 7, "fiber": 11},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1/2 cup dry (40g)", "grams": 40, "is_default": True},
            {"label": "1 cup dry (80g)", "grams": 80},
        ],
        "aliases": ["oats", "oatmeal", "rolled oats", "old fashioned oats", "porridge"],
    },
    {
        "name": "Pasta (Cooked)",
        "category": FoodCategory.GRAINS_CARBS,
        "nutrition": {"calories": 131, "protein": 5, "carbs": 25, "fat": 1.1},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 cup (140g)", "grams": 140, "is_default": True},
            {"label": "2 oz dry (makes ~1 cup)", "grams": 140},
        ],
        "aliases": ["pasta", "spaghetti", "penne", "rigatoni", "noodles", "macaroni"],
    },
    {
        "name": "Whole Wheat Pasta (Cooked)",
        "category": FoodCategory.GRAINS_CARBS,
        "nutrition": {"calories": 124, "protein": 5, "carbs": 27, "fat": 0.5, "fiber": 4},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 cup (140g)", "grams": 140, "is_default": True},
        ],
        "aliases": ["whole wheat pasta", "whole grain pasta", "wheat spaghetti"],
    },
    {
        "name": "Quinoa (Cooked)",
        "category": FoodCategory.GRAINS_CARBS,
        "nutrition": {"calories": 120, "protein": 4.4, "carbs": 21, "fat": 1.9, "fiber": 2.8},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 cup (185g)", "grams": 185, "is_default": True},
            {"label": "1/2 cup", "grams": 93},
        ],
        "aliases": ["quinoa"],
    },
    {
        "name": "Bread (White)",
        "category": FoodCategory.GRAINS_CARBS,
        "nutrition": {"calories": 265, "protein": 9, "carbs": 49, "fat": 3.2},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 slice (30g)", "grams": 30, "is_default": True},
            {"label": "2 slices", "grams": 60},
        ],
        "aliases": ["white bread", "bread", "toast", "sandwich bread"],
    },
    {
        "name": "Bread (Whole Wheat)",
        "category": FoodCategory.GRAINS_CARBS,
        "nutrition": {"calories": 247, "protein": 13, "carbs": 41, "fat": 3.4, "fiber": 7},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 slice (33g)", "grams": 33, "is_default": True},
            {"label": "2 slices", "grams": 66},
        ],
        "aliases": ["whole wheat bread", "wheat bread", "brown bread"],
    },
    {
        "name": "Sweet Potato",
        "category": FoodCategory.GRAINS_CARBS,
        "nutrition": {"calories": 86, "protein": 1.6, "carbs": 20, "fat": 0.1, "fiber": 3},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 medium (130g)", "grams": 130, "is_default": True},
            {"label": "1 large (180g)", "grams": 180},
        ],
        "aliases": ["sweet potato", "yam", "baked sweet potato"],
    },
    {
        "name": "Potato",
        "category": FoodCategory.GRAINS_CARBS,
        "nutrition": {"calories": 77, "protein": 2, "carbs": 17, "fat": 0.1, "fiber": 2.2},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 medium (150g)", "grams": 150, "is_default": True},
            {"label": "1 large (300g)", "grams": 300},
        ],
        "aliases": ["potato", "baked potato", "russet potato", "white potato", "boiled potato"],
    },
    {
        "name": "Bagel",
        "category": FoodCategory.GRAINS_CARBS,
        "nutrition": {"calories": 257, "protein": 10, "carbs": 50, "fat": 1.6},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 medium bagel (105g)", "grams": 105, "is_default": True},
        ],
        "aliases": ["bagel", "plain bagel", "everything bagel"],
    },
    {
        "name": "Flour Tortilla",
        "category": FoodCategory.GRAINS_CARBS,
        "nutrition": {"calories": 312, "protein": 8, "carbs": 52, "fat": 8},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 medium (45g)", "grams": 45, "is_default": True},
            {"label": "1 large burrito (64g)", "grams": 64},
        ],
        "aliases": ["flour tortilla", "tortilla", "wrap", "burrito tortilla"],
    },
    {
        "name": "Granola",
        "category": FoodCategory.GRAINS_CARBS,
        "nutrition": {"calories": 471, "protein": 10, "carbs": 64, "fat": 20},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1/2 cup (60g)", "grams": 60, "is_default": True},
            {"label": "1/4 cup (30g)", "grams": 30},
        ],
        "aliases": ["granola", "granola cereal"],
    },
    {
        "name": "Honey",
        "category": FoodCategory.GRAINS_CARBS,
        "nutrition": {"calories": 304, "protein": 0.3, "carbs": 82, "fat": 0},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 tbsp (21g)", "grams": 21, "is_default": True},
        ],
        "aliases": ["honey", "raw honey"],
    },
]

# ─── Vegetables ──────────────────────────────────────────────────────────────

VEGETABLES = [
    {
        "name": "Broccoli",
        "category": FoodCategory.VEGETABLES,
        "nutrition": {"calories": 34, "protein": 2.8, "carbs": 7, "fat": 0.4, "fiber": 2.6},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 cup chopped (91g)", "grams": 91, "is_default": True},
            {"label": "1 cup steamed (156g)", "grams": 156},
        ],
        "aliases": ["broccoli", "broccoli florets", "steamed broccoli"],
    },
    {
        "name": "Spinach (Raw)",
        "category": FoodCategory.VEGETABLES,
        "nutrition": {"calories": 23, "protein": 2.9, "carbs": 3.6, "fat": 0.4, "fiber": 2.2},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 cup raw (30g)", "grams": 30, "is_default": True},
            {"label": "1 cup cooked (180g)", "grams": 180},
        ],
        "aliases": ["spinach", "baby spinach", "fresh spinach"],
    },
    {
        "name": "Bell Peppers",
        "category": FoodCategory.VEGETABLES,
        "nutrition": {"calories": 31, "protein": 1, "carbs": 6, "fat": 0.3, "fiber": 2.1},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 cup chopped (149g)", "grams": 149, "is_default": True},
            {"label": "1 medium pepper (119g)", "grams": 119},
        ],
        "aliases": ["bell pepper", "bell peppers", "red pepper", "green pepper", "sweet pepper"],
    },
    {
        "name": "Carrots",
        "category": FoodCategory.VEGETABLES,
        "nutrition": {"calories": 41, "protein": 0.9, "carbs": 10, "fat": 0.2, "fiber": 2.8},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 medium carrot (61g)", "grams": 61, "is_default": True},
            {"label": "1 cup chopped (128g)", "grams": 128},
            {"label": "10 baby carrots (100g)", "grams": 100},
        ],
        "aliases": ["carrots", "carrot", "baby carrots"],
    },
    {
        "name": "Tomatoes",
        "category": FoodCategory.VEGETABLES,
        "nutrition": {"calories": 18, "protein": 0.9, "carbs": 3.9, "fat": 0.2, "fiber": 1.2},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 medium tomato (123g)", "grams": 123, "is_default": True},
            {"label": "1 cup chopped (180g)", "grams": 180},
        ],
        "aliases": ["tomato", "tomatoes", "fresh tomato", "roma tomato"],
    },
    {
        "name": "Cucumber",
        "category": FoodCategory.VEGETABLES,
        "nutrition": {"calories": 15, "protein": 0.7, "carbs": 3.6, "fat": 0.1, "fiber": 0.5},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 cup sliced (119g)", "grams": 119, "is_default": True},
            {"label": "1 medium (201g)", "grams": 201},
        ],
        "aliases": ["cucumber", "cucumbers"],
    },
    {
        "name": "Mushrooms (White)",
        "category": FoodCategory.VEGETABLES,
        "nutrition": {"calories": 22, "protein": 3.1, "carbs": 3.3, "fat": 0.3, "fiber": 1},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 cup sliced (70g)", "grams": 70, "is_default": True},
            {"label": "5 medium (84g)", "grams": 84},
        ],
        "aliases": ["mushrooms", "mushroom", "white mushrooms", "button mushrooms"],
    },
    {
        "name": "Asparagus",
        "category": FoodCategory.VEGETABLES,
        "nutrition": {"calories": 20, "protein": 2.2, "carbs": 3.9, "fat": 0.1, "fiber": 2.1},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 cup (134g)", "grams": 134, "is_default": True},
            {"label": "5 spears (75g)", "grams": 75},
        ],
        "aliases": ["asparagus", "asparagus spears"],
    },
    {
        "name": "Cauliflower",
        "category": FoodCategory.VEGETABLES,
        "nutrition": {"calories": 25, "protein": 1.9, "carbs": 5, "fat": 0.3, "fiber": 2},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 cup chopped (107g)", "grams": 107, "is_default": True},
        ],
        "aliases": ["cauliflower", "cauliflower rice", "riced cauliflower"],
    },
    {
        "name": "Green Beans",
        "category": FoodCategory.VEGETABLES,
        "nutrition": {"calories": 31, "protein": 1.8, "carbs": 7, "fat": 0.1, "fiber": 3.4},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 cup (125g)", "grams": 125, "is_default": True},
        ],
        "aliases": ["green beans", "string beans", "snap beans"],
    },
    {
        "name": "Kale",
        "category": FoodCategory.VEGETABLES,
        "nutrition": {"calories": 49, "protein": 4.3, "carbs": 9, "fat": 0.9, "fiber": 3.6},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 cup chopped (67g)", "grams": 67, "is_default": True},
        ],
        "aliases": ["kale", "baby kale", "curly kale"],
    },
    {
        "name": "Zucchini",
        "category": FoodCategory.VEGETABLES,
        "nutrition": {"calories": 17, "protein": 1.2, "carbs": 3.1, "fat": 0.3, "fiber": 1},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 cup sliced (113g)", "grams": 113, "is_default": True},
            {"label": "1 medium (196g)", "grams": 196},
        ],
        "aliases": ["zucchini", "courgette", "zucchini noodles", "zoodles"],
    },
    {
        "name": "Onion",
        "category": FoodCategory.VEGETABLES,
        "nutrition": {"calories": 40, "protein": 1.1, "carbs": 9, "fat": 0.1, "fiber": 1.7},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1/2 cup chopped (80g)", "grams": 80, "is_default": True},
            {"label": "1 medium (110g)", "grams": 110},
        ],
        "aliases": ["onion", "onions", "yellow onion", "white onion"],
    },
    {
        "name": "Brussels Sprouts",
        "category": FoodCategory.VEGETABLES,
        "nutrition": {"calories": 43, "protein": 3.4, "carbs": 9, "fat": 0.3, "fiber": 3.8},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 cup (88g)", "grams": 88, "is_default": True},
        ],
        "aliases": ["brussels sprouts", "brussel sprouts"],
    },
    {
        "name": "Mixed Salad Greens",
        "category": FoodCategory.VEGETABLES,
        "nutrition": {"calories": 17, "protein": 1.5, "carbs": 3.1, "fat": 0.2, "fiber": 1.8},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "2 cups (85g)", "grams": 85, "is_default": True},
        ],
        "aliases": ["salad", "mixed greens", "lettuce", "salad mix", "bagged salad"],
    },
]

# ─── Fruits ──────────────────────────────────────────────────────────────────

FRUITS = [
    {
        "name": "Banana",
        "category": FoodCategory.FRUITS,
        "nutrition": {"calories": 89, "protein": 1.1, "carbs": 23, "fat": 0.3, "fiber": 2.6},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 medium (118g)", "grams": 118, "is_default": True},
            {"label": "1 large (136g)", "grams": 136},
        ],
        "aliases": ["banana", "bananas"],
    },
    {
        "name": "Apple",
        "category": FoodCategory.FRUITS,
        "nutrition": {"calories": 52, "protein": 0.3, "carbs": 14, "fat": 0.2, "fiber": 2.4},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 medium (182g)", "grams": 182, "is_default": True},
            {"label": "1 large (223g)", "grams": 223},
        ],
        "aliases": ["apple", "apples", "green apple", "red apple"],
    },
    {
        "name": "Blueberries",
        "category": FoodCategory.FRUITS,
        "nutrition": {"calories": 57, "protein": 0.7, "carbs": 14, "fat": 0.3, "fiber": 2.4},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 cup (148g)", "grams": 148, "is_default": True},
            {"label": "1/2 cup", "grams": 74},
        ],
        "aliases": ["blueberries", "blueberry", "fresh blueberries", "frozen blueberries"],
    },
    {
        "name": "Strawberries",
        "category": FoodCategory.FRUITS,
        "nutrition": {"calories": 32, "protein": 0.7, "carbs": 8, "fat": 0.3, "fiber": 2},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 cup halved (152g)", "grams": 152, "is_default": True},
            {"label": "5 medium (100g)", "grams": 100},
        ],
        "aliases": ["strawberries", "strawberry", "fresh strawberries"],
    },
    {
        "name": "Orange",
        "category": FoodCategory.FRUITS,
        "nutrition": {"calories": 47, "protein": 0.9, "carbs": 12, "fat": 0.1, "fiber": 2.4},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 medium (131g)", "grams": 131, "is_default": True},
            {"label": "1 large (184g)", "grams": 184},
        ],
        "aliases": ["orange", "oranges", "navel orange"],
    },
    {
        "name": "Avocado",
        "category": FoodCategory.FRUITS,
        "nutrition": {"calories": 160, "protein": 2, "carbs": 9, "fat": 15, "fiber": 6.7},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1/2 avocado (68g)", "grams": 68, "is_default": True},
            {"label": "1 whole (136g)", "grams": 136},
            {"label": "2 tbsp mashed (30g)", "grams": 30},
        ],
        "aliases": ["avocado", "avocados", "guacamole base"],
    },
    {
        "name": "Grapes",
        "category": FoodCategory.FRUITS,
        "nutrition": {"calories": 69, "protein": 0.7, "carbs": 18, "fat": 0.2, "fiber": 0.9},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 cup (151g)", "grams": 151, "is_default": True},
        ],
        "aliases": ["grapes", "red grapes", "green grapes"],
    },
    {
        "name": "Mango",
        "category": FoodCategory.FRUITS,
        "nutrition": {"calories": 60, "protein": 0.8, "carbs": 15, "fat": 0.4, "fiber": 1.6},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 cup sliced (165g)", "grams": 165, "is_default": True},
        ],
        "aliases": ["mango", "mangoes", "fresh mango", "frozen mango"],
    },
    {
        "name": "Watermelon",
        "category": FoodCategory.FRUITS,
        "nutrition": {"calories": 30, "protein": 0.6, "carbs": 8, "fat": 0.2, "fiber": 0.4},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 cup diced (152g)", "grams": 152, "is_default": True},
            {"label": "1 wedge (286g)", "grams": 286},
        ],
        "aliases": ["watermelon"],
    },
    {
        "name": "Raspberries",
        "category": FoodCategory.FRUITS,
        "nutrition": {"calories": 52, "protein": 1.2, "carbs": 12, "fat": 0.7, "fiber": 6.5},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 cup (123g)", "grams": 123, "is_default": True},
        ],
        "aliases": ["raspberries", "raspberry", "fresh raspberries"],
    },
]

# ─── Fats & Oils ─────────────────────────────────────────────────────────────

FATS_OILS = [
    {
        "name": "Olive Oil",
        "category": FoodCategory.FATS_OILS,
        "nutrition": {"calories": 884, "protein": 0, "carbs": 0, "fat": 100},
        "servings": [
            {"label": "100ml", "grams": 100},
            {"label": "1 tbsp (14ml)", "grams": 14, "is_default": True},
            {"label": "1 tsp (5ml)", "grams": 5},
        ],
        "aliases": ["olive oil", "extra virgin olive oil", "evoo"],
    },
    {
        "name": "Almonds",
        "category": FoodCategory.FATS_OILS,
        "nutrition": {"calories": 579, "protein": 21, "carbs": 22, "fat": 50, "fiber": 12},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 oz (23 almonds, 28g)", "grams": 28, "is_default": True},
            {"label": "1/4 cup (36g)", "grams": 36},
        ],
        "aliases": ["almonds", "raw almonds", "roasted almonds"],
    },
    {
        "name": "Peanut Butter",
        "category": FoodCategory.FATS_OILS,
        "nutrition": {"calories": 588, "protein": 25, "carbs": 20, "fat": 50, "fiber": 6},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "2 tbsp (32g)", "grams": 32, "is_default": True},
            {"label": "1 tbsp (16g)", "grams": 16},
        ],
        "aliases": ["peanut butter", "pb", "natural peanut butter"],
    },
    {
        "name": "Almond Butter",
        "category": FoodCategory.FATS_OILS,
        "nutrition": {"calories": 614, "protein": 21, "carbs": 19, "fat": 56, "fiber": 10},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "2 tbsp (32g)", "grams": 32, "is_default": True},
            {"label": "1 tbsp (16g)", "grams": 16},
        ],
        "aliases": ["almond butter"],
    },
    {
        "name": "Walnuts",
        "category": FoodCategory.FATS_OILS,
        "nutrition": {"calories": 654, "protein": 15, "carbs": 14, "fat": 65, "fiber": 6.7},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 oz (14 halves, 28g)", "grams": 28, "is_default": True},
            {"label": "1/4 cup chopped (30g)", "grams": 30},
        ],
        "aliases": ["walnuts", "walnut halves"],
    },
    {
        "name": "Cashews",
        "category": FoodCategory.FATS_OILS,
        "nutrition": {"calories": 553, "protein": 18, "carbs": 30, "fat": 44, "fiber": 3.3},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 oz (28g)", "grams": 28, "is_default": True},
        ],
        "aliases": ["cashews", "raw cashews", "roasted cashews"],
    },
    {
        "name": "Chia Seeds",
        "category": FoodCategory.FATS_OILS,
        "nutrition": {"calories": 486, "protein": 17, "carbs": 42, "fat": 31, "fiber": 34},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 tbsp (12g)", "grams": 12, "is_default": True},
            {"label": "2 tbsp (24g)", "grams": 24},
        ],
        "aliases": ["chia seeds", "chia"],
    },
    {
        "name": "Flax Seeds",
        "category": FoodCategory.FATS_OILS,
        "nutrition": {"calories": 534, "protein": 18, "carbs": 29, "fat": 42, "fiber": 27},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 tbsp ground (7g)", "grams": 7, "is_default": True},
        ],
        "aliases": ["flax seeds", "flaxseed", "ground flax", "flax meal"],
    },
    {
        "name": "Coconut Oil",
        "category": FoodCategory.FATS_OILS,
        "nutrition": {"calories": 862, "protein": 0, "carbs": 0, "fat": 100},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 tbsp (14g)", "grams": 14, "is_default": True},
        ],
        "aliases": ["coconut oil", "virgin coconut oil"],
    },
    {
        "name": "Dark Chocolate (70%+)",
        "category": FoodCategory.FATS_OILS,
        "nutrition": {"calories": 598, "protein": 8, "carbs": 46, "fat": 43, "fiber": 11},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1 oz (28g)", "grams": 28, "is_default": True},
            {"label": "1 square (10g)", "grams": 10},
        ],
        "aliases": ["dark chocolate", "chocolate", "cacao"],
    },
    {
        "name": "Trail Mix",
        "category": FoodCategory.FATS_OILS,
        "nutrition": {"calories": 462, "protein": 14, "carbs": 42, "fat": 29},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1/4 cup (35g)", "grams": 35, "is_default": True},
        ],
        "aliases": ["trail mix", "mixed nuts and fruit"],
    },
]

# ─── Condiments & Sauces ────────────────────────────────────────────────────

CONDIMENTS = [
    {
        "name": "Marinara Sauce",
        "category": FoodCategory.VEGETABLES,  # closest category
        "nutrition": {"calories": 37, "protein": 1.3, "carbs": 6, "fat": 1, "fiber": 1.5},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "1/2 cup (125g)", "grams": 125, "is_default": True},
        ],
        "aliases": ["marinara", "pasta sauce", "tomato sauce", "red sauce"],
    },
    {
        "name": "Salsa",
        "category": FoodCategory.VEGETABLES,
        "nutrition": {"calories": 36, "protein": 1.5, "carbs": 7, "fat": 0.2, "fiber": 1.5},
        "servings": [
            {"label": "100g", "grams": 100},
            {"label": "2 tbsp (30g)", "grams": 30, "is_default": True},
            {"label": "1/4 cup (65g)", "grams": 65},
        ],
        "aliases": ["salsa", "pico de gallo"],
    },
    {
        "name": "Soy Sauce",
        "category": FoodCategory.VEGETABLES,
        "nutrition": {"calories": 53, "protein": 8, "carbs": 5, "fat": 0, "sodium_mg": 5637},
        "servings": [
            {"label": "100ml", "grams": 100},
            {"label": "1 tbsp (15ml)", "grams": 15, "is_default": True},
        ],
        "aliases": ["soy sauce", "shoyu", "tamari"],
    },
    {
        "name": "Hot Sauce",
        "category": FoodCategory.VEGETABLES,
        "nutrition": {"calories": 11, "protein": 1, "carbs": 2, "fat": 0.1, "sodium_mg": 2640},
        "servings": [
            {"label": "100ml", "grams": 100},
            {"label": "1 tsp (5ml)", "grams": 5, "is_default": True},
            {"label": "1 tbsp (15ml)", "grams": 15},
        ],
        "aliases": ["hot sauce", "sriracha", "franks red hot", "tabasco"],
    },
]

# ─── Drinks & Supplements ───────────────────────────────────────────────────

DRINKS = [
    {
        "name": "Orange Juice",
        "category": FoodCategory.FRUITS,
        "nutrition": {"calories": 45, "protein": 0.7, "carbs": 10, "fat": 0.2, "sugar": 8.4},
        "servings": [
            {"label": "100ml", "grams": 100},
            {"label": "1 cup (248ml)", "grams": 248, "is_default": True},
            {"label": "1 small glass (180ml)", "grams": 180},
        ],
        "aliases": ["orange juice", "oj", "fresh squeezed oj"],
    },
    {
        "name": "Coffee (Black)",
        "category": FoodCategory.VEGETABLES,  # no "beverages" cat, use closest
        "nutrition": {"calories": 2, "protein": 0.3, "carbs": 0, "fat": 0},
        "servings": [
            {"label": "100ml", "grams": 100},
            {"label": "1 cup (240ml)", "grams": 240, "is_default": True},
            {"label": "1 shot espresso (30ml)", "grams": 30},
        ],
        "aliases": ["coffee", "black coffee", "espresso", "americano"],
    },
    {
        "name": "Creatine Monohydrate",
        "category": FoodCategory.PROTEINS,  # supplement
        "nutrition": {"calories": 0, "protein": 0, "carbs": 0, "fat": 0},
        "servings": [
            {"label": "5g (1 scoop)", "grams": 5, "is_default": True},
        ],
        "aliases": ["creatine", "creatine monohydrate"],
    },
]


# ─── Master list ─────────────────────────────────────────────────────────────

SEED_FOODS: list[dict] = (
    PROTEINS
    + DAIRY
    + PLANT_PROTEINS
    + GRAINS_CARBS
    + VEGETABLES
    + FRUITS
    + FATS_OILS
    + CONDIMENTS
    + DRINKS
)
