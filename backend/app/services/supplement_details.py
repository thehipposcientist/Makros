"""Curated supplement detail metadata used by catalog + stack backfills."""
from __future__ import annotations

from copy import deepcopy
from typing import Any


SUPPLEMENT_DETAIL_METADATA: dict[str, dict[str, list[str]]] = {
    "creatine_monohydrate": {
        "common_uses": [
            "Strength and power output",
            "Lean mass support during resistance training",
            "Repeated sprint or high-intensity work",
        ],
        "deficiency_risks": [
            "No established deficiency syndrome",
            "Low meat or fish intake can mean lower baseline muscle creatine stores",
        ],
        "excess_risks": [
            "Stomach upset at large single doses",
            "Temporary water-weight gain",
            "Avoid unsupervised use with kidney disease",
        ],
        "food_sources": ["Beef", "Pork", "Salmon", "Tuna", "Herring"],
    },
    "whey_protein": {
        "common_uses": [
            "Helping hit daily protein targets",
            "Post-workout or convenient meal protein",
            "Muscle repair during dieting or high training load",
        ],
        "deficiency_risks": [
            "Protein shortfalls can impair recovery and lean-mass retention",
            "Low protein intake can reduce satiety during fat-loss phases",
        ],
        "excess_risks": [
            "Bloating or GI discomfort in lactose-sensitive users",
            "Can crowd out higher-fiber whole foods when overused",
        ],
        "food_sources": ["Milk", "Greek yogurt", "Cottage cheese", "Cheese", "Kefir"],
    },
    "caffeine": {
        "common_uses": [
            "Pre-workout alertness and perceived-effort reduction",
            "Endurance and strength performance support",
            "Short-term focus",
        ],
        "deficiency_risks": [
            "No nutritional deficiency risk",
            "Habitual users may get withdrawal headaches or fatigue when stopping suddenly",
        ],
        "excess_risks": [
            "Sleep disruption, anxiety, jitters, or elevated heart rate",
            "Higher risk when stacked across coffee, energy drinks, and pre-workouts",
        ],
        "food_sources": ["Coffee", "Espresso", "Tea", "Yerba mate", "Dark chocolate"],
    },
    "vitamin_d3": {
        "common_uses": [
            "Correcting low vitamin D status",
            "Bone and muscle function support",
            "Immune-health support when intake or sun exposure is low",
        ],
        "deficiency_risks": [
            "Low bone mineralization and higher fracture risk over time",
            "Muscle weakness or aches",
            "Deficiency is more common with limited sun exposure",
        ],
        "excess_risks": [
            "High long-term doses can raise blood calcium",
            "Too much can cause nausea, weakness, kidney stones, or kidney injury",
        ],
        "food_sources": ["Salmon", "Sardines", "Egg yolks", "Fortified milk", "UV-exposed mushrooms"],
    },
    "omega_3": {
        "common_uses": [
            "Raising EPA/DHA intake when seafood is low",
            "Heart-health and triglyceride support",
            "Joint and training-recovery support",
        ],
        "deficiency_risks": [
            "Low EPA/DHA intake can worsen omega-3 to omega-6 balance",
            "Very low intake may affect cardiovascular and inflammatory markers",
        ],
        "excess_risks": [
            "Fishy reflux or GI upset",
            "High doses may increase bleeding risk, especially with blood thinners",
        ],
        "food_sources": ["Salmon", "Sardines", "Mackerel", "Anchovies", "Trout"],
    },
    "magnesium": {
        "common_uses": [
            "Supporting sleep quality and relaxation",
            "Muscle and nerve function",
            "Filling low dietary magnesium intake",
        ],
        "deficiency_risks": [
            "Muscle cramps, weakness, or poor sleep can show up with low intake",
            "Low intake may affect blood pressure and glucose regulation over time",
        ],
        "excess_risks": [
            "Loose stools or stomach cramping, especially from citrate or oxide",
            "High supplemental doses are risky with kidney disease",
        ],
        "food_sources": ["Pumpkin seeds", "Spinach", "Black beans", "Almonds", "Dark chocolate"],
    },
    "electrolytes": {
        "common_uses": [
            "Replacing sweat losses during long or hot training",
            "Supporting hydration on low-carb or fasting days",
            "Reducing dehydration-related performance drops",
        ],
        "deficiency_risks": [
            "Low sodium during heavy sweating can cause headache, weakness, or cramping",
            "Poor fluid-electrolyte replacement can hurt endurance performance",
        ],
        "excess_risks": [
            "High sodium intake can be an issue for blood-pressure management",
            "Too much potassium is unsafe with some medications or kidney disease",
        ],
        "food_sources": ["Salted foods", "Bananas", "Potatoes", "Dairy", "Coconut water"],
    },
    "iron": {
        "common_uses": [
            "Correcting confirmed iron deficiency",
            "Supporting oxygen transport when ferritin or iron labs are low",
            "Higher-risk cases include heavy menstrual bleeding or low animal-food intake",
        ],
        "deficiency_risks": [
            "Fatigue, shortness of breath, reduced endurance, or anemia",
            "Low ferritin can impair training tolerance before anemia appears",
        ],
        "excess_risks": [
            "Iron overload can damage organs",
            "Constipation, nausea, and medication interactions are common concerns",
            "Do not supplement iron without bloodwork unless directed by a clinician",
        ],
        "food_sources": ["Beef", "Clams", "Sardines", "Lentils", "Spinach"],
    },
    "vitamin_b12": {
        "common_uses": [
            "Correcting low B12 status",
            "Supporting red blood cell and nerve function",
            "Filling gaps in vegan or vegetarian diets",
        ],
        "deficiency_risks": [
            "Fatigue, anemia, numbness, tingling, or cognitive changes",
            "Risk is higher with vegan diets, older age, and some GI conditions or medications",
        ],
        "excess_risks": [
            "Generally low toxicity at typical supplement doses",
            "High-dose use can obscure whether the underlying cause of deficiency was fixed",
        ],
        "food_sources": ["Clams", "Beef", "Salmon", "Eggs", "Milk"],
    },
    "beta_alanine": {
        "common_uses": [
            "Repeated high-intensity efforts lasting about 1-4 minutes",
            "Intervals, circuits, combat sports, and high-rep sets",
            "Raising muscle carnosine over weeks of daily use",
        ],
        "deficiency_risks": [
            "No established deficiency syndrome",
            "Low intake mainly means less carnosine support for specific high-intensity efforts",
        ],
        "excess_risks": [
            "Harmless tingling or flushing at large single doses",
            "GI discomfort when taken too much at once",
        ],
        "food_sources": ["Chicken", "Beef", "Pork", "Fish", "Turkey"],
    },
}


SUPPLEMENT_DETAIL_METADATA.update({
    "casein_protein": {
        "common_uses": ["Slow-digesting protein serving", "Evening or between-meal protein support", "Protein target support during dieting"],
        "deficiency_risks": ["Protein shortfalls can impair recovery", "Low protein intake can reduce satiety"],
        "excess_risks": ["Dairy-related bloating or intolerance", "Can crowd out higher-fiber foods when overused"],
        "food_sources": ["Milk", "Greek yogurt", "Cottage cheese", "Kefir"],
    },
    "plant_protein": {
        "common_uses": ["Protein target support on plant-forward diets", "Post-workout protein when dairy is not desired", "Convenient meal protein"],
        "deficiency_risks": ["Low protein intake can impair lean-mass retention", "Some diets may undershoot leucine without planning"],
        "excess_risks": ["GI discomfort from some blends", "Quality varies; third-party testing is preferred"],
        "food_sources": ["Peas", "Soy foods", "Lentils", "Rice", "Hemp seeds"],
    },
    "bcaa": {
        "common_uses": ["Fasted training support", "Low-protein-day amino acid support", "Leucine-focused intra-workout drinks"],
        "deficiency_risks": ["No deficiency risk when total protein is adequate", "Low protein intake can reduce recovery"],
        "excess_risks": ["Often redundant with enough complete protein", "May displace more useful protein foods"],
        "food_sources": ["Whey", "Chicken", "Beef", "Eggs", "Soy"],
    },
    "eaa": {
        "common_uses": ["Essential amino acids around training", "Protein support when a full meal is not practical", "Fasted or low-appetite training blocks"],
        "deficiency_risks": ["Low essential amino acid intake limits muscle protein synthesis", "Low total protein can impair recovery"],
        "excess_risks": ["Can be expensive relative to protein foods", "GI discomfort from large servings"],
        "food_sources": ["Eggs", "Dairy", "Fish", "Meat", "Soy"],
    },
    "l_citrulline": {
        "common_uses": ["Pre-workout blood-flow support", "Pump-focused strength sessions", "High-effort interval training"],
        "deficiency_risks": ["No established deficiency syndrome", "Low intake mainly means no ergogenic support"],
        "excess_risks": ["GI discomfort at high doses", "Use caution with blood-pressure medications"],
        "food_sources": ["Watermelon", "Cucumber", "Pumpkin", "Squash"],
    },
    "pre_workout": {
        "common_uses": ["Convenient pre-training formula", "Energy and focus support", "Pump or endurance ingredient blend"],
        "deficiency_risks": ["No nutritional deficiency risk", "Sleep loss can drive reliance on stimulants"],
        "excess_risks": ["Stimulant stacking", "Sleep disruption", "Hidden proprietary blends or underdosed ingredients"],
        "food_sources": ["Coffee", "Tea", "Watermelon", "Beetroot"],
    },
    "l_glutamine": {
        "common_uses": ["Gut-comfort support", "Heavy training blocks", "General amino acid support"],
        "deficiency_risks": ["No established deficiency for most well-fed users", "Very high stress or illness can raise demand"],
        "excess_risks": ["Limited muscle-building benefit when protein is adequate", "GI discomfort at high doses"],
        "food_sources": ["Beef", "Chicken", "Eggs", "Milk", "Tofu"],
    },
    "zinc": {
        "common_uses": ["Correcting low zinc intake", "Immune and metabolic support", "Balancing heavy sweat losses when diet is low"],
        "deficiency_risks": ["Poor wound healing or immune function", "Taste changes", "Higher risk with low animal-food intake"],
        "excess_risks": ["Copper depletion", "Nausea", "Excess can affect immune function"],
        "food_sources": ["Oysters", "Beef", "Pumpkin seeds", "Beans", "Yogurt"],
    },
    "ashwagandha": {
        "common_uses": ["Stress perception support", "Sleep quality support", "Recovery support during high stress"],
        "deficiency_risks": ["No deficiency risk", "Not an essential nutrient"],
        "excess_risks": ["Possible thyroid or sedative medication interactions", "Avoid during pregnancy", "GI upset or drowsiness"],
        "food_sources": ["Ashwagandha root"],
    },
    "melatonin": {
        "common_uses": ["Sleep-onset timing", "Jet lag or schedule shifts", "Occasional circadian support"],
        "deficiency_risks": ["No dietary deficiency risk", "Light exposure and schedule can suppress natural rhythm"],
        "excess_risks": ["Next-day grogginess", "Vivid dreams", "Can interact with sedatives"],
        "food_sources": ["Tart cherries", "Pistachios", "Walnuts"],
    },
    "l_theanine": {
        "common_uses": ["Calm focus", "Caffeine smoothing", "Evening relaxation for some users"],
        "deficiency_risks": ["No established deficiency syndrome", "Not an essential amino acid"],
        "excess_risks": ["Possible additive sedation", "May cause lightheadedness in sensitive users"],
        "food_sources": ["Green tea", "Black tea", "Matcha"],
    },
    "l_carnitine": {
        "common_uses": ["Recovery support in some contexts", "Fatty-acid transport support", "Plant-based diet gap support"],
        "deficiency_risks": ["True deficiency is uncommon", "Lower intake is more likely on vegan diets"],
        "excess_risks": ["GI upset", "Fishy body odor", "Modest fat-loss effects"],
        "food_sources": ["Beef", "Lamb", "Pork", "Milk", "Fish"],
    },
    "collagen_peptides": {
        "common_uses": ["Tendon and ligament support", "Joint comfort", "Collagen-rich amino acid intake"],
        "deficiency_risks": ["Low total protein can impair connective-tissue repair", "Low vitamin C can impair collagen formation"],
        "excess_risks": ["Not a complete protein", "Can crowd out higher-leucine protein sources"],
        "food_sources": ["Bone broth", "Gelatin", "Chicken skin", "Fish skin"],
    },
    "zma": {
        "common_uses": ["Evening mineral stack", "Zinc and magnesium intake support", "Sleep routine support when intake is low"],
        "deficiency_risks": ["Low zinc or magnesium intake can affect recovery", "Heavy sweating can increase mineral needs"],
        "excess_risks": ["Zinc duplication", "Loose stools from magnesium", "B6 overuse if stacked"],
        "food_sources": ["Pumpkin seeds", "Beef", "Spinach", "Beans", "Nuts"],
    },
    "multivitamin": {
        "common_uses": ["Micronutrient coverage during low-variety diets", "Dieting phases", "Travel or busy periods"],
        "deficiency_risks": ["Diet gaps vary by food pattern", "Low variety can miss several micronutrients"],
        "excess_risks": ["Mega-dose fat-soluble vitamins", "Mineral duplication", "False confidence replacing food quality"],
        "food_sources": ["Vegetables", "Fruit", "Whole grains", "Dairy", "Seafood"],
    },
    "tart_cherry": {
        "common_uses": ["Soreness support around hard sessions", "Polyphenol intake", "Sleep routine support for some users"],
        "deficiency_risks": ["No deficiency risk", "Low fruit/polyphenol intake reduces dietary antioxidants"],
        "excess_risks": ["Added sugar in juice concentrate", "GI discomfort from large servings"],
        "food_sources": ["Tart cherries", "Cherry juice", "Dark berries"],
    },
    "green_tea_extract": {
        "common_uses": ["Catechin intake", "Modest fat-oxidation support", "Antioxidant intake"],
        "deficiency_risks": ["No deficiency risk", "Low tea intake has no required replacement"],
        "excess_risks": ["Liver stress from concentrated extracts", "Nausea when taken on an empty stomach", "Caffeine duplication"],
        "food_sources": ["Green tea", "Matcha", "Black tea"],
    },
    "probiotic": {
        "common_uses": ["Gut comfort support", "Strain-specific digestive support", "Fermented-food gap support"],
        "deficiency_risks": ["No classic deficiency syndrome", "Low fermented-food intake can reduce microbial variety"],
        "excess_risks": ["Gas or bloating at first", "Use caution if immunocompromised"],
        "food_sources": ["Yogurt", "Kefir", "Sauerkraut", "Kimchi", "Tempeh"],
    },
    "vitamin_c": {
        "common_uses": ["Low fruit/vegetable intake support", "Collagen formation", "Iron absorption support"],
        "deficiency_risks": ["Poor wound healing", "Bleeding gums", "Higher risk with very low produce intake"],
        "excess_risks": ["GI upset", "Kidney-stone risk in susceptible users"],
        "food_sources": ["Oranges", "Kiwi", "Strawberries", "Bell peppers", "Broccoli"],
    },
    "calcium": {
        "common_uses": ["Low dairy or calcium-food intake", "Bone health support", "Dietary gap filling"],
        "deficiency_risks": ["Low bone mineral density over time", "Higher risk with low dairy or fortified-food intake"],
        "excess_risks": ["Constipation", "Kidney-stone risk", "Avoid excessive total calcium"],
        "food_sources": ["Milk", "Yogurt", "Tofu set with calcium", "Sardines", "Kale"],
    },
    "potassium": {
        "common_uses": ["Electrolyte support when food intake is low", "Fluid balance", "Muscle function"],
        "deficiency_risks": ["Weakness, cramps, or abnormal heart rhythm in true low potassium", "Risk rises with some medications or illness"],
        "excess_risks": ["Unsafe with kidney disease", "Medication interactions", "Heart rhythm risk if excessive"],
        "food_sources": ["Potatoes", "Bananas", "Beans", "Yogurt", "Avocado"],
    },
    "selenium": {
        "common_uses": ["Low selenium intake support", "Thyroid-related nutrient coverage", "Trace mineral coverage"],
        "deficiency_risks": ["Risk varies by soil and diet pattern", "Very low intake can affect thyroid and antioxidant systems"],
        "excess_risks": ["Hair or nail changes", "Garlic breath odor", "Toxicity from high-dose stacking"],
        "food_sources": ["Brazil nuts", "Tuna", "Sardines", "Eggs", "Turkey"],
    },
    "folate": {
        "common_uses": ["Low leafy-green or legume intake", "Red blood cell support", "Prenatal nutrient support when directed"],
        "deficiency_risks": ["Megaloblastic anemia", "Fatigue", "Higher need before and during pregnancy"],
        "excess_risks": ["Can mask B12 deficiency", "Avoid high-dose stacking without clinician input"],
        "food_sources": ["Lentils", "Spinach", "Asparagus", "Avocado", "Fortified grains"],
    },
    "vitamin_k2": {
        "common_uses": ["Vitamin K intake support", "Bone-related nutrient coverage", "Fat-soluble vitamin coverage"],
        "deficiency_risks": ["Low vitamin K can affect normal clotting", "Low intake is more likely with very low greens"],
        "excess_risks": ["Warfarin interaction", "Avoid large unsupervised changes if anticoagulated"],
        "food_sources": ["Natto", "Cheese", "Egg yolks", "Fermented foods"],
    },
    "vitamin_e": {
        "common_uses": ["Low fat-food or nut/seed intake", "Antioxidant nutrient coverage", "Food-pattern gap filling"],
        "deficiency_risks": ["True deficiency is uncommon", "Higher risk with fat-malabsorption conditions"],
        "excess_risks": ["High-dose bleeding risk", "Fat-soluble vitamin stacking"],
        "food_sources": ["Sunflower seeds", "Almonds", "Avocado", "Olive oil", "Spinach"],
    },
    "coq10": {
        "common_uses": ["Mitochondrial energy-pathway support", "Statin-associated nutrient support when clinician-approved", "General antioxidant support"],
        "deficiency_risks": ["No routine dietary deficiency syndrome", "Some medication contexts may lower levels"],
        "excess_risks": ["GI upset", "Potential anticoagulant interaction"],
        "food_sources": ["Beef", "Sardines", "Mackerel", "Chicken", "Peanuts"],
    },
    "turmeric_curcumin": {
        "common_uses": ["Joint comfort", "Inflammatory-marker support", "Polyphenol intake"],
        "deficiency_risks": ["No deficiency risk", "Low spice intake has no required replacement"],
        "excess_risks": ["Blood thinner interactions", "Gallbladder symptom risk", "GI discomfort"],
        "food_sources": ["Turmeric root", "Curry spices"],
    },
    "glucosamine_chondroitin": {
        "common_uses": ["Joint comfort", "Knee support", "Cartilage-related supplement routines"],
        "deficiency_risks": ["No established deficiency syndrome", "Joint pain needs load and medical context"],
        "excess_risks": ["Shellfish allergy source concerns", "Possible anticoagulant interaction", "GI discomfort"],
        "food_sources": ["Shellfish shells", "Animal cartilage"],
    },
    "psyllium_fiber": {
        "common_uses": ["Soluble fiber intake", "Bowel regularity", "Cholesterol marker support"],
        "deficiency_risks": ["Low fiber can impair regularity and satiety", "Low soluble fiber may affect cholesterol markers"],
        "excess_risks": ["Bloating if increased quickly", "Choking risk if taken without enough water", "Medication absorption timing issues"],
        "food_sources": ["Oats", "Beans", "Lentils", "Apples", "Psyllium husk"],
    },
    "beetroot_nitrate": {
        "common_uses": ["Endurance performance support", "Interval-session support", "Dietary nitrate intake"],
        "deficiency_risks": ["No deficiency risk", "Low vegetable intake reduces nitrate/polyphenol exposure"],
        "excess_risks": ["Blood pressure lowering", "Pink or red urine/stool", "GI discomfort"],
        "food_sources": ["Beetroot", "Spinach", "Arugula", "Celery"],
    },
    "sodium_bicarbonate": {
        "common_uses": ["Repeated sprint support", "High-intensity buffering", "Competition-day ergogenic testing"],
        "deficiency_risks": ["No deficiency risk", "Not a required nutrient supplement"],
        "excess_risks": ["GI distress", "Large sodium load", "Avoid untested competition-day use"],
        "food_sources": ["Baking soda"],
    },
    "hmb": {
        "common_uses": ["New training block support", "Low-calorie phase recovery", "Older adult lean-mass support"],
        "deficiency_risks": ["No established deficiency syndrome", "Low leucine/protein intake matters more"],
        "excess_risks": ["Limited benefit when training and protein are already dialed", "GI discomfort in some users"],
        "food_sources": ["Small amounts from leucine-rich foods", "Dairy", "Meat", "Fish"],
    },
    "taurine": {
        "common_uses": ["Energy drink ingredient tracking", "Hydration and endurance support", "General amino acid support"],
        "deficiency_risks": ["No typical deficiency syndrome", "Low intake is usually not a concern"],
        "excess_risks": ["Stimulant-product stacking", "GI discomfort at high doses"],
        "food_sources": ["Shellfish", "Fish", "Dark poultry meat", "Beef"],
    },
    "glycine": {
        "common_uses": ["Sleep routine support", "Collagen amino acid support", "Evening relaxation support"],
        "deficiency_risks": ["No typical deficiency syndrome", "Low collagen-rich food intake lowers dietary glycine"],
        "excess_risks": ["GI discomfort at higher doses", "Drowsiness in some users"],
        "food_sources": ["Gelatin", "Bone broth", "Chicken skin", "Pork skin"],
    },
    "garlic": {
        "common_uses": ["Cardiovascular marker support", "Food-based botanical routine", "General wellness routines"],
        "deficiency_risks": ["No deficiency risk", "Not an essential nutrient"],
        "excess_risks": ["Bleeding risk", "Reflux or odor", "Medication interactions"],
        "food_sources": ["Garlic cloves"],
    },
    "ginger": {
        "common_uses": ["Nausea support", "Digestive comfort", "Soreness support"],
        "deficiency_risks": ["No deficiency risk", "Not an essential nutrient"],
        "excess_risks": ["Heartburn", "Blood thinner caution at high doses"],
        "food_sources": ["Ginger root"],
    },
    "berberine": {
        "common_uses": ["Glucose-response support", "Lipid-marker support", "Metabolic supplement routines"],
        "deficiency_risks": ["No deficiency risk", "Not an essential nutrient"],
        "excess_risks": ["Diabetes medication interactions", "Pregnancy caution", "GI discomfort"],
        "food_sources": ["Barberry", "Goldenseal", "Oregon grape"],
    },
    "cranberry_extract": {
        "common_uses": ["Urinary tract support routines", "Polyphenol intake", "Berry extract tracking"],
        "deficiency_risks": ["No deficiency risk", "Low berry intake has no required replacement"],
        "excess_risks": ["Warfarin caution", "Kidney-stone caution", "GI upset"],
        "food_sources": ["Cranberries", "Cranberry juice"],
    },
    "spirulina": {
        "common_uses": ["Algae-based supplement routines", "Plant-forward protein and pigment intake", "Smoothie add-ins"],
        "deficiency_risks": ["No deficiency risk", "Not a required food"],
        "excess_risks": ["Contamination risk if not tested", "Immune or liver-condition caution"],
        "food_sources": ["Spirulina algae"],
    },
    "maca": {
        "common_uses": ["Energy or mood routines", "Libido-support routines", "Smoothie add-ins"],
        "deficiency_risks": ["No deficiency risk", "Not an essential nutrient"],
        "excess_risks": ["GI discomfort", "Hormone-sensitive-condition caution"],
        "food_sources": ["Maca root"],
    },
    "panax_ginseng": {
        "common_uses": ["Energy and stress routines", "Libido-support routines", "Erectile-function supplement stacks"],
        "deficiency_risks": ["No deficiency risk", "Not an essential nutrient"],
        "excess_risks": ["Insomnia or jitteriness", "Blood-sugar and blood-thinner interaction caution", "Autoimmune-condition or pregnancy caution"],
        "food_sources": ["Panax ginseng root", "Korean red ginseng"],
    },
    "tongkat_ali": {
        "common_uses": ["Libido-support routines", "Hormone-support supplement stacks", "Stress-related vitality routines"],
        "deficiency_risks": ["No deficiency risk", "Not an essential nutrient"],
        "excess_risks": ["Limited long-term safety data", "Liver-condition caution", "Product purity and adulteration risk"],
        "food_sources": ["Eurycoma longifolia root", "Tongkat ali root"],
    },
    "fenugreek": {
        "common_uses": ["Libido-support routines", "Metabolic supplement stacks", "Seed-based herbal routines"],
        "deficiency_risks": ["No deficiency risk", "Not an essential nutrient"],
        "excess_risks": ["GI upset or maple-like body odor", "Low-blood-sugar or blood-thinner caution", "Avoid supplement doses during pregnancy"],
        "food_sources": ["Fenugreek seeds", "Fenugreek leaves"],
    },
    "saffron": {
        "common_uses": ["Mood-support routines", "Libido-support routines", "SSRI-related sexual-side-effect support when clinician-approved"],
        "deficiency_risks": ["No deficiency risk", "Not an essential nutrient"],
        "excess_risks": ["High-dose safety concern", "Pregnancy caution", "Medication-context caution for serotonergic drugs"],
        "food_sources": ["Saffron stigmas", "Crocus sativus"],
    },
    "tribulus_terrestris": {
        "common_uses": ["Libido-support routines", "Traditional botanical stacks", "Hormone-support supplement stacks"],
        "deficiency_risks": ["No deficiency risk", "Not an essential nutrient"],
        "excess_risks": ["Weak testosterone evidence despite marketing", "Kidney or liver-condition caution", "Blood-pressure and diabetes-medication caution"],
        "food_sources": ["Tribulus terrestris herb", "Puncture vine"],
    },
    "epimedium": {
        "common_uses": ["Libido-support routines", "Traditional Chinese botanical stacks", "Erectile-function supplement stacks"],
        "deficiency_risks": ["No deficiency risk", "Not an essential nutrient"],
        "excess_risks": ["Cardiovascular and arrhythmia caution", "ED-medication or nitrate interaction concern", "Limited human safety data"],
        "food_sources": ["Epimedium herb", "Horny goat weed"],
    },
    "boron": {
        "common_uses": ["Trace mineral coverage", "Bone and mineral metabolism routines", "Hormone-support supplement stacks"],
        "deficiency_risks": ["Human deficiency signs are not firmly established", "Low intakes may affect mineral metabolism in limited research"],
        "excess_risks": ["Do not exceed conservative supplemental doses", "Kidney-condition caution", "Pregnancy or breastfeeding caution for high-dose use"],
        "food_sources": ["Raisins", "Prunes", "Avocado", "Nuts", "Legumes"],
    },
    "inositol": {
        "common_uses": ["Metabolic support routines", "Cycle-related support routines", "Mood-support supplement stacks"],
        "deficiency_risks": ["No classic deficiency syndrome", "The body can synthesize inositol"],
        "excess_risks": ["GI discomfort at high doses", "Medication context matters for metabolic use"],
        "food_sources": ["Beans", "Citrus", "Cantaloupe", "Whole grains"],
    },
    "nac": {
        "common_uses": ["Glutathione-pathway support", "Respiratory mucus support", "Antioxidant routines"],
        "deficiency_risks": ["No routine deficiency syndrome", "Low cysteine/protein intake may affect glutathione substrate"],
        "excess_risks": ["Nitroglycerin interaction", "GI discomfort", "Use caution with asthma or bleeding-risk contexts"],
        "food_sources": ["Protein-rich foods", "Chicken", "Turkey", "Yogurt", "Eggs"],
    },
    "iodine": {
        "common_uses": ["Low iodine intake support", "Thyroid nutrient coverage", "Low-seafood or non-iodized-salt diets"],
        "deficiency_risks": ["Thyroid dysfunction", "Goiter", "Higher need during pregnancy"],
        "excess_risks": ["Too much can worsen thyroid issues", "Avoid stacking high-dose kelp products"],
        "food_sources": ["Iodized salt", "Seaweed", "Cod", "Milk", "Yogurt"],
    },
    "copper": {
        "common_uses": ["Balancing long-term zinc use", "Trace mineral coverage", "Low copper intake support"],
        "deficiency_risks": ["Anemia-like symptoms", "Neurologic symptoms in severe deficiency", "Risk rises with high zinc intake"],
        "excess_risks": ["Nausea", "Liver risk with excess", "Avoid high-dose stacking"],
        "food_sources": ["Oysters", "Sesame seeds", "Cashews", "Lentils", "Dark chocolate"],
    },
    "cla": {
        "common_uses": ["Body-composition supplement routines", "Fatty acid tracking", "Weight-management stacks"],
        "deficiency_risks": ["No deficiency risk", "Not an essential fatty acid target"],
        "excess_risks": ["GI discomfort", "Possible lipid or glucose marker concerns", "Small practical effect size"],
        "food_sources": ["Beef", "Dairy fat", "Lamb"],
    },
    "apple_cider_vinegar": {
        "common_uses": ["Meal-time glucose-response routines", "Appetite-support routines", "Vinegar supplement tracking"],
        "deficiency_risks": ["No deficiency risk", "Not an essential nutrient"],
        "excess_risks": ["Tooth enamel irritation", "Throat irritation if undiluted", "GI discomfort"],
        "food_sources": ["Apple cider vinegar", "Vinegar-containing foods"],
    },
})


def supplement_detail_metadata(slug: str | None) -> dict[str, list[str]]:
    if not slug:
        return {}
    data = SUPPLEMENT_DETAIL_METADATA.get(str(slug).strip().lower())
    return deepcopy(data) if data else {}


def infer_detail_slug(*values: Any) -> str | None:
    from app.services.supplement_name_match import infer_slug_from_name
    for value in values:
        slug = infer_slug_from_name(str(value or ""))
        if slug in SUPPLEMENT_DETAIL_METADATA:
            return slug
    return None


def clean_detail_list(value: Any, *, limit: int = 5, max_len: int = 120) -> list[str] | None:
    if not isinstance(value, list):
        return None
    out: list[str] = []
    for raw in value:
        text = str(raw or "").strip()
        if text and text not in out:
            out.append(text[:max_len])
        if len(out) >= limit:
            break
    return out or None
