"""
Per-food micronutrient backfill for the seed dataset.

The main `seed_foods_data.py` file only carries macros + occasional
fiber/sugar values inline. This module is the canonical source for every
micronutrient the assembler aggregates: fiber, sugar, sodium, plus the
extras that live in `FoodNutrition.extra_nutrients` JSON.

Lookup is keyed by lowercased canonical food name (the same `name` field
used in `seed_foods_data.SEED_FOODS`). Each value is a dict of nutrient
amounts per 100 g, matching what `FoodNutrition.reference_grams` expects.

Coverage targets the foods most likely to appear in a generated meal —
common proteins, grains, dairy, fruits, vegetables, fats. Foods missing
from this map fall back to whatever the inline `seed_foods_data` entry
provided (which is usually nothing). Adding a new entry is one dict line.

Sources: USDA FoodData Central rounded to one decimal where reasonable.
"""

# Canonical micronutrient keys. The columns at the top live on the
# FoodNutrition table itself; everything else flows into the JSON
# `extra_nutrients` column.
TOP_LEVEL_KEYS = ("fiber", "sugar", "sodium_mg")

# All keys (top-level + extras) that the meal_assembler will aggregate.
# Mirror of MICRONUTRIENT_FIELDS in services/meal_assembler.py — keep in
# sync when adding a new field.
ALL_MICRO_KEYS = (
    "fiber", "sugar", "sodium",
    "cholesterol",
    "saturated_fat", "monounsaturated_fat", "polyunsaturated_fat",
    "omega_3", "omega_6",
    "vitamin_a", "vitamin_c", "vitamin_d", "vitamin_e", "vitamin_k",
    "thiamin_b1", "riboflavin_b2", "niacin_b3", "vitamin_b6",
    "folate_b9", "vitamin_b12", "biotin_b7", "pantothenic_acid_b5",
    "calcium", "iron", "magnesium", "phosphorus", "potassium",
    "zinc", "selenium", "copper", "manganese",
)


# Per 100 g unless noted. Field meanings:
#   fiber, sugar             g
#   sodium                   mg  (also stored as sodium_mg on FoodNutrition column)
#   cholesterol              mg
#   saturated/mono/poly fat  g
#   omega_3, omega_6         g
#   vitamin_a                µg RAE
#   vitamin_c, vitamin_e     mg
#   vitamin_d, vitamin_k     µg
#   thiamin_b1..vitamin_b6   mg
#   folate_b9, biotin_b7     µg
#   vitamin_b12              µg
#   calcium, iron, magnesium, phosphorus, potassium, zinc  mg
#   selenium                 µg
#   copper, manganese        mg
MICRONUTRIENTS: dict[str, dict[str, float]] = {

    # ── Animal Proteins ────────────────────────────────────────────────────
    "chicken breast": {
        "fiber": 0, "sugar": 0, "sodium": 74, "cholesterol": 85,
        "saturated_fat": 1.0, "monounsaturated_fat": 1.2, "polyunsaturated_fat": 0.8,
        "omega_3": 0.07, "omega_6": 0.7,
        "niacin_b3": 13.7, "vitamin_b6": 0.9, "vitamin_b12": 0.3,
        "phosphorus": 220, "potassium": 256, "selenium": 27.6,
    },
    "chicken thighs": {
        "fiber": 0, "sugar": 0, "sodium": 88, "cholesterol": 130,
        "saturated_fat": 3.0, "monounsaturated_fat": 4.6, "polyunsaturated_fat": 2.4,
        "omega_3": 0.13, "omega_6": 2.1,
        "niacin_b3": 6.0, "vitamin_b6": 0.36, "vitamin_b12": 0.5,
        "phosphorus": 200, "potassium": 240, "iron": 1.3, "zinc": 2.0,
    },
    "ground beef (lean 93/7)": {
        "fiber": 0, "sugar": 0, "sodium": 66, "cholesterol": 78,
        "saturated_fat": 3.0, "monounsaturated_fat": 3.0, "polyunsaturated_fat": 0.3,
        "iron": 2.6, "zinc": 5.7, "vitamin_b12": 2.5, "niacin_b3": 5.5,
        "phosphorus": 200, "potassium": 320, "selenium": 22,
    },
    "ground beef (80/20)": {
        "fiber": 0, "sugar": 0, "sodium": 75, "cholesterol": 88,
        "saturated_fat": 6.6, "monounsaturated_fat": 7.4, "polyunsaturated_fat": 0.6,
        "iron": 2.4, "zinc": 5.3, "vitamin_b12": 2.3, "niacin_b3": 5.1,
        "phosphorus": 180, "potassium": 290,
    },
    "sirloin steak": {
        "fiber": 0, "sugar": 0, "sodium": 60, "cholesterol": 75,
        "saturated_fat": 4.4, "monounsaturated_fat": 4.7, "polyunsaturated_fat": 0.4,
        "iron": 2.7, "zinc": 5.0, "vitamin_b12": 2.6, "niacin_b3": 7.5,
        "phosphorus": 220, "potassium": 360, "selenium": 25,
    },
    "turkey breast": {
        "fiber": 0, "sugar": 0, "sodium": 75, "cholesterol": 60,
        "saturated_fat": 0.3, "monounsaturated_fat": 0.2, "polyunsaturated_fat": 0.3,
        "niacin_b3": 11.8, "vitamin_b6": 0.8, "vitamin_b12": 0.4,
        "phosphorus": 220, "potassium": 305, "selenium": 28,
    },
    "deli turkey": {
        "fiber": 0, "sugar": 1.0, "sodium": 900, "cholesterol": 50,
        "saturated_fat": 0.4, "phosphorus": 200, "potassium": 230,
    },
    "rotisserie chicken": {
        "fiber": 0, "sugar": 0, "sodium": 350, "cholesterol": 110,
        "saturated_fat": 4.0, "niacin_b3": 8.0, "vitamin_b6": 0.5,
    },
    "pork loin": {
        "fiber": 0, "sugar": 0, "sodium": 50, "cholesterol": 80,
        "saturated_fat": 2.5, "thiamin_b1": 0.9, "vitamin_b6": 0.5,
        "niacin_b3": 6.5, "phosphorus": 230, "potassium": 380,
    },
    "tuna (canned in water)": {
        "fiber": 0, "sugar": 0, "sodium": 320, "cholesterol": 30,
        "saturated_fat": 0.3, "omega_3": 0.3, "omega_6": 0.05,
        "vitamin_d": 1.0, "vitamin_b12": 2.5, "niacin_b3": 13.0,
        "selenium": 80, "phosphorus": 180,
    },
    "shrimp": {
        "fiber": 0, "sugar": 0, "sodium": 110, "cholesterol": 200,
        "saturated_fat": 0.3, "omega_3": 0.5, "omega_6": 0.05,
        "vitamin_b12": 1.5, "selenium": 38, "phosphorus": 240,
        "calcium": 70, "iodine": 35,
    },
    "salmon": {
        "fiber": 0, "sugar": 0, "sodium": 60, "cholesterol": 60,
        "saturated_fat": 3.1, "monounsaturated_fat": 3.8, "polyunsaturated_fat": 3.9,
        "omega_3": 2.3, "omega_6": 0.6,
        "vitamin_d": 11.0, "vitamin_b12": 3.2, "niacin_b3": 8.5,
        "vitamin_b6": 0.6, "phosphorus": 240, "potassium": 360, "selenium": 36,
    },
    "cod": {
        "fiber": 0, "sugar": 0, "sodium": 78, "cholesterol": 50,
        "saturated_fat": 0.2, "omega_3": 0.2, "vitamin_b12": 1.0,
        "phosphorus": 200, "potassium": 410, "selenium": 33,
    },
    "tilapia": {
        "fiber": 0, "sugar": 0, "sodium": 50, "cholesterol": 50,
        "saturated_fat": 0.8, "omega_3": 0.2, "vitamin_b12": 1.6,
        "phosphorus": 200, "potassium": 380, "selenium": 47,
    },
    "eggs": {
        "fiber": 0, "sugar": 1.1, "sodium": 142, "cholesterol": 372,
        "saturated_fat": 3.1, "monounsaturated_fat": 3.7, "polyunsaturated_fat": 1.4,
        "omega_3": 0.07, "omega_6": 1.2,
        "vitamin_a": 160, "vitamin_d": 2.0, "vitamin_e": 1.0, "vitamin_k": 0.3,
        "vitamin_b12": 0.9, "riboflavin_b2": 0.5, "folate_b9": 47,
        "calcium": 56, "iron": 1.8, "phosphorus": 198, "selenium": 30,
        "choline": 294,
    },
    "egg whites": {
        "fiber": 0, "sugar": 0.7, "sodium": 166, "cholesterol": 0,
        "riboflavin_b2": 0.4, "potassium": 163, "selenium": 20,
    },
    "protein powder (whey)": {
        "fiber": 1.0, "sugar": 5, "sodium": 200, "cholesterol": 30,
        "saturated_fat": 1.5, "calcium": 280, "iron": 1.5, "potassium": 350,
    },
    "sardines (canned in oil)": {
        "fiber": 0, "sugar": 0, "sodium": 380, "cholesterol": 142,
        "saturated_fat": 1.5, "omega_3": 1.5, "vitamin_d": 4.8,
        "vitamin_b12": 8.9, "calcium": 382, "iron": 2.9, "selenium": 52,
    },
    "ham": {
        "fiber": 0, "sugar": 1.5, "sodium": 1200, "cholesterol": 53,
        "saturated_fat": 1.2, "thiamin_b1": 0.6, "phosphorus": 200,
    },
    "ground turkey (93/7)": {
        "fiber": 0, "sugar": 0, "sodium": 80, "cholesterol": 88,
        "saturated_fat": 2.3, "niacin_b3": 5.5, "vitamin_b12": 1.4,
        "phosphorus": 200, "selenium": 25,
    },

    # ── Plant Proteins ─────────────────────────────────────────────────────
    "tofu (firm)": {
        "fiber": 1.9, "sugar": 0.6, "sodium": 7, "cholesterol": 0,
        "saturated_fat": 0.7, "calcium": 350, "iron": 2.7, "magnesium": 60,
        "phosphorus": 190, "potassium": 121, "zinc": 1.6,
    },
    "tempeh": {
        "fiber": 0, "sugar": 0, "sodium": 9, "cholesterol": 0,
        "saturated_fat": 2.2, "calcium": 111, "iron": 2.7, "magnesium": 81,
        "phosphorus": 266, "potassium": 412, "manganese": 1.3,
    },
    "lentils (cooked)": {
        "fiber": 7.9, "sugar": 1.8, "sodium": 2, "cholesterol": 0,
        "iron": 3.3, "folate_b9": 181, "potassium": 369, "magnesium": 36,
        "phosphorus": 180, "zinc": 1.3, "manganese": 0.5,
    },
    "black beans (cooked)": {
        "fiber": 8.7, "sugar": 0.3, "sodium": 1, "cholesterol": 0,
        "iron": 2.1, "folate_b9": 149, "potassium": 355, "magnesium": 70,
        "phosphorus": 140, "zinc": 1.1,
    },
    "chickpeas (cooked)": {
        "fiber": 7.6, "sugar": 4.8, "sodium": 7, "cholesterol": 0,
        "iron": 2.9, "folate_b9": 172, "potassium": 291, "magnesium": 48,
        "phosphorus": 168, "manganese": 1.0,
    },
    "edamame": {
        "fiber": 5.2, "sugar": 2.2, "sodium": 6, "cholesterol": 0,
        "iron": 2.3, "folate_b9": 311, "calcium": 63, "potassium": 436,
        "magnesium": 64, "vitamin_k": 26,
    },

    # ── Grains & Carbs ─────────────────────────────────────────────────────
    "white rice (cooked)": {
        "fiber": 0.4, "sugar": 0.05, "sodium": 1,
        "iron": 1.2, "thiamin_b1": 0.16, "niacin_b3": 1.5, "magnesium": 12,
        "phosphorus": 43, "manganese": 0.5,
    },
    "brown rice (cooked)": {
        "fiber": 1.8, "sugar": 0.4, "sodium": 4,
        "iron": 0.4, "magnesium": 43, "phosphorus": 83, "potassium": 79,
        "manganese": 1.1, "selenium": 9.8, "thiamin_b1": 0.18, "niacin_b3": 1.5,
    },
    "oats (dry)": {
        "fiber": 10.6, "sugar": 1.0, "sodium": 2,
        "iron": 4.7, "magnesium": 177, "phosphorus": 523, "potassium": 429,
        "zinc": 4.0, "manganese": 4.9, "thiamin_b1": 0.76, "folate_b9": 56,
    },
    "pasta (cooked)": {
        "fiber": 1.8, "sugar": 0.6, "sodium": 1,
        "iron": 1.3, "magnesium": 18, "selenium": 26.4, "thiamin_b1": 0.16,
    },
    "whole wheat pasta (cooked)": {
        "fiber": 4.5, "sugar": 0.8, "sodium": 4,
        "iron": 1.1, "magnesium": 42, "phosphorus": 100, "manganese": 0.9,
    },
    "sweet potato (cooked)": {
        "fiber": 3.3, "sugar": 6.5, "sodium": 27,
        "vitamin_a": 961, "vitamin_c": 19.6, "potassium": 475,
        "manganese": 0.5, "vitamin_b6": 0.29,
    },
    "white potato (cooked)": {
        "fiber": 1.8, "sugar": 0.8, "sodium": 5,
        "vitamin_c": 13, "potassium": 421, "vitamin_b6": 0.3,
    },
    "quinoa (cooked)": {
        "fiber": 2.8, "sugar": 0.9, "sodium": 7,
        "iron": 1.5, "magnesium": 64, "phosphorus": 152, "potassium": 172,
        "folate_b9": 42, "manganese": 0.6,
    },
    "bread (whole wheat)": {
        "fiber": 6.0, "sugar": 6, "sodium": 460,
        "iron": 2.5, "calcium": 107, "magnesium": 76, "manganese": 1.9,
        "thiamin_b1": 0.4, "niacin_b3": 4.4,
    },
    "bread (white)": {
        "fiber": 2.4, "sugar": 5, "sodium": 491,
        "iron": 3.6, "calcium": 144, "thiamin_b1": 0.5, "niacin_b3": 4.5,
    },
    "tortilla (flour)": {
        "fiber": 3.5, "sugar": 1.7, "sodium": 590,
        "iron": 3.4, "calcium": 145, "thiamin_b1": 0.5,
    },
    "bagel": {
        "fiber": 2.4, "sugar": 5, "sodium": 460,
        "iron": 3.8, "thiamin_b1": 0.6, "niacin_b3": 4.5,
    },
    "couscous (cooked)": {
        "fiber": 1.4, "sugar": 0.1, "sodium": 5,
        "selenium": 27, "thiamin_b1": 0.08, "niacin_b3": 1.0,
    },

    # ── Dairy ──────────────────────────────────────────────────────────────
    "greek yogurt (nonfat)": {
        "fiber": 0, "sugar": 3.6, "sodium": 36, "cholesterol": 5,
        "calcium": 110, "potassium": 141, "phosphorus": 135,
        "vitamin_b12": 0.75, "riboflavin_b2": 0.28,
    },
    "cottage cheese (2%)": {
        "fiber": 0, "sugar": 4.1, "sodium": 308, "cholesterol": 17,
        "saturated_fat": 1.2, "calcium": 91, "phosphorus": 159,
        "vitamin_b12": 0.5, "selenium": 9.7,
    },
    "cheddar cheese": {
        "fiber": 0, "sugar": 0.5, "sodium": 621, "cholesterol": 99,
        "saturated_fat": 19, "calcium": 710, "phosphorus": 512,
        "vitamin_a": 263, "vitamin_b12": 1.1, "zinc": 3.1,
    },
    "mozzarella cheese": {
        "fiber": 0, "sugar": 1.0, "sodium": 627, "cholesterol": 79,
        "saturated_fat": 13, "calcium": 505, "phosphorus": 354,
        "vitamin_b12": 2.3, "zinc": 2.9,
    },
    "parmesan cheese": {
        "fiber": 0, "sugar": 0.9, "sodium": 1602, "cholesterol": 88,
        "saturated_fat": 19, "calcium": 1184, "phosphorus": 694,
        "vitamin_b12": 1.2, "zinc": 2.8,
    },
    "milk (whole)": {
        "fiber": 0, "sugar": 5.1, "sodium": 43, "cholesterol": 12,
        "saturated_fat": 1.9, "calcium": 113, "phosphorus": 84,
        "potassium": 132, "vitamin_a": 46, "vitamin_d": 1.3, "vitamin_b12": 0.5,
        "riboflavin_b2": 0.18,
    },
    "milk (skim)": {
        "fiber": 0, "sugar": 5.1, "sodium": 42, "cholesterol": 2,
        "calcium": 122, "phosphorus": 101, "potassium": 156,
        "vitamin_a": 49, "vitamin_d": 1.2, "vitamin_b12": 0.5,
    },
    "almond milk (unsweetened)": {
        "fiber": 0.4, "sugar": 0, "sodium": 72,
        "calcium": 188, "vitamin_a": 207, "vitamin_d": 1.0, "vitamin_e": 6.3,
    },
    "butter": {
        "fiber": 0, "sugar": 0.06, "sodium": 11, "cholesterol": 215,
        "saturated_fat": 51, "monounsaturated_fat": 21, "polyunsaturated_fat": 3.0,
        "vitamin_a": 684, "vitamin_d": 1.5, "vitamin_e": 2.3, "vitamin_k": 7.0,
    },

    # ── Fruits ─────────────────────────────────────────────────────────────
    "banana": {
        "fiber": 2.6, "sugar": 12.2, "sodium": 1,
        "vitamin_c": 8.7, "vitamin_b6": 0.37, "potassium": 358,
        "manganese": 0.27, "magnesium": 27,
    },
    "apple": {
        "fiber": 2.4, "sugar": 10.4, "sodium": 1,
        "vitamin_c": 4.6, "potassium": 107, "vitamin_k": 2.2,
    },
    "blueberries": {
        "fiber": 2.4, "sugar": 9.7, "sodium": 1,
        "vitamin_c": 9.7, "vitamin_k": 19.3, "manganese": 0.34,
    },
    "strawberries": {
        "fiber": 2.0, "sugar": 4.9, "sodium": 1,
        "vitamin_c": 58.8, "folate_b9": 24, "manganese": 0.39,
    },
    "orange": {
        "fiber": 2.4, "sugar": 9.4, "sodium": 0,
        "vitamin_c": 53.2, "folate_b9": 30, "calcium": 40, "potassium": 181,
    },
    "avocado": {
        "fiber": 6.7, "sugar": 0.7, "sodium": 7,
        "saturated_fat": 2.1, "monounsaturated_fat": 9.8, "polyunsaturated_fat": 1.8,
        "potassium": 485, "vitamin_k": 21, "folate_b9": 81, "vitamin_e": 2.1,
    },

    # ── Vegetables ─────────────────────────────────────────────────────────
    "broccoli": {
        "fiber": 2.6, "sugar": 1.7, "sodium": 33,
        "vitamin_c": 89.2, "vitamin_k": 102, "folate_b9": 63,
        "vitamin_a": 31, "potassium": 316, "calcium": 47,
    },
    "spinach (raw)": {
        "fiber": 2.2, "sugar": 0.4, "sodium": 79,
        "vitamin_a": 469, "vitamin_c": 28.1, "vitamin_k": 483,
        "folate_b9": 194, "iron": 2.7, "magnesium": 79, "potassium": 558,
    },
    "bell peppers": {
        "fiber": 2.1, "sugar": 4.2, "sodium": 4,
        "vitamin_c": 127.7, "vitamin_a": 157, "vitamin_b6": 0.29, "folate_b9": 46,
    },
    "carrots": {
        "fiber": 2.8, "sugar": 4.7, "sodium": 69,
        "vitamin_a": 835, "vitamin_k": 13.2, "vitamin_c": 5.9, "potassium": 320,
    },
    "tomatoes": {
        "fiber": 1.2, "sugar": 2.6, "sodium": 5,
        "vitamin_c": 13.7, "vitamin_a": 42, "vitamin_k": 7.9, "potassium": 237,
    },
    "kale": {
        "fiber": 4.1, "sugar": 0, "sodium": 38,
        "vitamin_a": 500, "vitamin_c": 120, "vitamin_k": 705,
        "calcium": 254, "potassium": 348,
    },
    "asparagus": {
        "fiber": 2.1, "sugar": 1.9, "sodium": 2,
        "vitamin_k": 41.6, "folate_b9": 52, "vitamin_a": 38, "vitamin_c": 5.6,
    },
    "cauliflower": {
        "fiber": 2.0, "sugar": 1.9, "sodium": 30,
        "vitamin_c": 48.2, "vitamin_k": 15.5, "folate_b9": 57,
    },
    "zucchini": {
        "fiber": 1.0, "sugar": 2.5, "sodium": 8,
        "vitamin_c": 17.9, "vitamin_a": 10, "potassium": 261,
    },
    "green beans": {
        "fiber": 2.7, "sugar": 3.3, "sodium": 6,
        "vitamin_c": 12.2, "vitamin_k": 43, "folate_b9": 33, "potassium": 211,
    },

    # ── Fats / Oils / Nuts ─────────────────────────────────────────────────
    "olive oil": {
        "fiber": 0, "sugar": 0, "sodium": 2, "cholesterol": 0,
        "saturated_fat": 13.8, "monounsaturated_fat": 73, "polyunsaturated_fat": 10.5,
        "omega_3": 0.76, "omega_6": 9.8, "vitamin_e": 14.4, "vitamin_k": 60.2,
    },
    "almonds": {
        "fiber": 12.5, "sugar": 4.4, "sodium": 1,
        "saturated_fat": 3.8, "monounsaturated_fat": 31, "polyunsaturated_fat": 12,
        "vitamin_e": 25.6, "calcium": 269, "iron": 3.7, "magnesium": 270,
        "potassium": 733,
    },
    "peanut butter": {
        "fiber": 6.0, "sugar": 9.2, "sodium": 459, "cholesterol": 0,
        "saturated_fat": 10, "monounsaturated_fat": 24, "polyunsaturated_fat": 16,
        "vitamin_e": 9.0, "magnesium": 169, "potassium": 649, "niacin_b3": 13.7,
    },
    "almond butter": {
        "fiber": 10.3, "sugar": 4.4, "sodium": 7,
        "saturated_fat": 4.4, "monounsaturated_fat": 36, "polyunsaturated_fat": 14,
        "vitamin_e": 24.2, "calcium": 347, "iron": 3.7, "magnesium": 286,
    },
    "walnuts": {
        "fiber": 6.7, "sugar": 2.6, "sodium": 2,
        "saturated_fat": 6.1, "monounsaturated_fat": 8.9, "polyunsaturated_fat": 47,
        "omega_3": 9.1, "omega_6": 38, "vitamin_e": 0.7, "magnesium": 158,
    },
    "chia seeds": {
        "fiber": 34.4, "sugar": 0, "sodium": 16,
        "saturated_fat": 3.3, "polyunsaturated_fat": 23.7, "omega_3": 17.8,
        "calcium": 631, "iron": 7.7, "magnesium": 335, "phosphorus": 860,
    },

    # ── Beverages / Misc ───────────────────────────────────────────────────
    "orange juice": {
        "fiber": 0.2, "sugar": 8.4, "sodium": 1,
        "vitamin_c": 50, "folate_b9": 30, "potassium": 200, "thiamin_b1": 0.09,
    },
}


def get_micronutrients_for(name: str) -> dict[str, float] | None:
    """Look up the micronutrient panel for a food by canonical name.
    Match is lowercase-exact against MICRONUTRIENTS keys. Returns None
    when no entry exists (caller should treat as "no extra data")."""
    return MICRONUTRIENTS.get((name or "").strip().lower())


def split_into_columns_and_extras(panel: dict[str, float]) -> tuple[dict, dict]:
    """Split a micronutrient panel into (top_level, extras).

    Top-level keys map to dedicated FoodNutrition columns (fiber, sugar,
    sodium_mg). Everything else flows into the JSON `extra_nutrients`
    column. Inline `sodium` becomes `sodium_mg` because the column name
    on FoodNutrition uses the explicit unit suffix.
    """
    top: dict = {}
    extras: dict = {}
    for k, v in panel.items():
        if k == "fiber":
            top["fiber"] = v
        elif k == "sugar":
            top["sugar"] = v
        elif k == "sodium":
            top["sodium_mg"] = v
        else:
            extras[k] = v
    return top, extras


# ── USDA-sourced panels for seed foods that originally shipped macros-only ────
# Generated from USDA FoodData Central (per 100g) via the seed-backfill matcher
# and hand-reviewed for match correctness (e.g. white potato vs sweet potato,
# grapes vs grape leaves). Merged here so seed_foods() backfills these foods on
# the next boot — closing the 71 -> ~102 micronutrient coverage gap. setdefault
# preserves any hand-curated panel that already exists for the same key.
from app.seed_micronutrients_usda import USDA_MICRONUTRIENTS as _USDA_MICRONUTRIENTS

for _name, _panel in _USDA_MICRONUTRIENTS.items():
    MICRONUTRIENTS.setdefault(_name, _panel)
