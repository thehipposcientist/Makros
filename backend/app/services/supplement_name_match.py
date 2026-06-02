"""Map free-text supplement names (`UserSupplementStack.custom_name`) to
canonical ingredient slugs.

Why this exists: users frequently add supplements as custom entries
(brand product names like "Nutricost D3 5000 IU" or "NOW Fish Oil"
1000 mg") rather than picking from the seeded ingredient catalog.
Those custom rows have `supplement_ingredient_id = NULL`, so the
recommender's `in_stack(...)` and the nutrition score's micro crediter
both miss them — leading to "you should take Vitamin D" prompts to
users who already supplement D3.

This module is the single place that does soft, conservative name
matching. Both `supplement_recs.py` (gating recommendations) and
`score_builder.py` (crediting micros) import from here.

Conservative on purpose: false positives are worse than false
negatives. We require explicit ingredient or formula keywords; brand-only
names without a recognizable supplement term return None.
"""

from __future__ import annotations

import re
from typing import Iterable


# Keyword patterns ordered by specificity. Each entry is
# (regex_pattern, canonical_slug). The first match wins.
#
# Patterns use word boundaries (\b) where appropriate so partial words
# don't trigger (e.g. "cremate" doesn't match "creatine"). Vitamin
# letter-number combos use lookarounds so "B12" matches but "B1200"
# (a brand model number, hypothetical) doesn't.
_PATTERNS: tuple[tuple[re.Pattern, str], ...] = (
    # Vitamin D — very common as custom adds in IU dosing.
    (re.compile(r"\b(vitamin\s*d3|vit\s*d3|d-?3|cholecalciferol)\b", re.I), "vitamin_d3"),
    (re.compile(r"\bvitamin\s*d\b(?!\s*ribose)", re.I), "vitamin_d3"),
    # Omega-3 / fish oil. Krill oil and algae oil are the same micro
    # contribution from the score's perspective.
    (re.compile(r"\b(fish\s*oil|fishoil|omega[\s-]*3|epa[\s/&-]*dha|krill\s*oil|algae\s*oil)\b", re.I), "omega_3"),
    # Probiotic.
    (re.compile(r"\b(probiotic|lactobacillus|bifidobacterium)\b", re.I), "probiotic"),
    (re.compile(r"\b(multivitamin|multi vitamin|multi-vitamin)\b", re.I), "multivitamin"),
    (re.compile(r"\b(pre[\s-]*workout|preworkout)\b", re.I), "pre_workout"),
    # B12.
    (re.compile(r"\b(vitamin\s*b\s*12|b\s*12|cyanocobalamin|methylcobalamin)\b", re.I), "vitamin_b12"),
    (re.compile(r"\b(vitamin\s*k\s*2|mk-?7|menaquinone)\b", re.I), "vitamin_k2"),
    (re.compile(r"\b(vitamin\s*e|alpha[\s-]*tocopherol|tocopherol)\b", re.I), "vitamin_e"),
    # Magnesium variants — all credit the same micro key.
    (re.compile(r"\bmagnesium\b", re.I), "magnesium"),
    # Iron.
    (re.compile(r"\b(iron|ferrous\s*(?:sulfate|gluconate|bisglycinate))\b", re.I), "iron"),
    # Vitamin C.
    (re.compile(r"\b(vitamin\s*c|ascorbic\s*acid)\b", re.I), "vitamin_c"),
    # Calcium.
    (re.compile(r"\bcalcium\b", re.I), "calcium"),
    # Zinc.
    (re.compile(r"\bzinc\b", re.I), "zinc"),
    # Selenium.
    (re.compile(r"\bselenium\b", re.I), "selenium"),
    # Potassium.
    (re.compile(r"\bpotassium\b", re.I), "potassium"),
    # Iodine / copper.
    (re.compile(r"\b(iodine|iodide|kelp)\b", re.I), "iodine"),
    (re.compile(r"\bcopper\b", re.I), "copper"),
    # Folate / B9.
    (re.compile(r"\b(folate|folic\s*acid|methylfolate)\b", re.I), "folate"),
    # Creatine.
    (re.compile(r"\bcreatine\b", re.I), "creatine_monohydrate"),
    # Whey / casein / generic protein powder.
    (re.compile(r"\b(whey|whey\s*isolate|whey\s*concentrate)\b", re.I), "whey_protein"),
    (re.compile(r"\b(casein|micellar\s*casein)\b", re.I), "casein_protein"),
    (re.compile(r"\b(plant\s*protein|pea\s*protein|soy\s*protein|rice\s*protein|hemp\s*protein|vegan\s*protein)\b", re.I), "plant_protein"),
    (re.compile(r"\b(collagen|gelatin|collagen\s*peptides?)\b", re.I), "collagen_peptides"),
    (re.compile(r"\b(bcaa|branched[\s-]*chain)\b", re.I), "bcaa"),
    (re.compile(r"\b(eaa|essential\s*amino)\b", re.I), "eaa"),
    (re.compile(r"\b(beta[\s-]*alanine)\b", re.I), "beta_alanine"),
    (re.compile(r"\b(citrulline|citrulline\s*malate)\b", re.I), "l_citrulline"),
    (re.compile(r"\b(glutamine|l[\s-]*glutamine)\b", re.I), "l_glutamine"),
    (re.compile(r"\b(theanine|l[\s-]*theanine)\b", re.I), "l_theanine"),
    (re.compile(r"\b(carnitine|l[\s-]*carnitine|acetyl[\s-]*l[\s-]*carnitine|alcar)\b", re.I), "l_carnitine"),
    (re.compile(r"\b(taurine)\b", re.I), "taurine"),
    (re.compile(r"\b(glycine)\b", re.I), "glycine"),
    (re.compile(r"\b(hmb|beta[\s-]*hydroxy[\s-]*beta[\s-]*methylbutyrate)\b", re.I), "hmb"),
    (re.compile(r"\b(zma)\b", re.I), "zma"),
    (re.compile(r"\b(electrolyte|electrolytes|hydration\s*(?:mix|powder|salt))\b", re.I), "electrolytes"),
    (re.compile(r"\b(melatonin)\b", re.I), "melatonin"),
    (re.compile(r"\b(ashwagandha|ksm-?66|sensoril)\b", re.I), "ashwagandha"),
    (re.compile(r"\b(tart\s*cherry|cherry\s*extract)\b", re.I), "tart_cherry"),
    (re.compile(r"\b(green\s*tea|egcg)\b", re.I), "green_tea_extract"),
    (re.compile(r"\b(coq10|coenzyme\s*q\s*10|ubiquinol|ubiquinone)\b", re.I), "coq10"),
    (re.compile(r"\b(turmeric|curcumin)\b", re.I), "turmeric_curcumin"),
    (re.compile(r"\b(glucosamine|chondroitin)\b", re.I), "glucosamine_chondroitin"),
    (re.compile(r"\b(psyllium|fiber|fibre)\b", re.I), "psyllium_fiber"),
    (re.compile(r"\b(beetroot|beet\s*root|beet\s*juice|nitrate)\b", re.I), "beetroot_nitrate"),
    (re.compile(r"\b(sodium\s*bicarbonate|baking\s*soda)\b", re.I), "sodium_bicarbonate"),
    (re.compile(r"\b(garlic)\b", re.I), "garlic"),
    (re.compile(r"\b(ginger)\b", re.I), "ginger"),
    (re.compile(r"\b(berberine)\b", re.I), "berberine"),
    (re.compile(r"\b(cranberry)\b", re.I), "cranberry_extract"),
    (re.compile(r"\b(spirulina)\b", re.I), "spirulina"),
    (re.compile(r"\b(tongkat\s*ali|eurycoma|long\s*jack|malaysian\s*ginseng)\b", re.I), "tongkat_ali"),
    (re.compile(r"\b(panax\s*ginseng|asian\s*ginseng|korean\s*(?:red\s*)?ginseng|red\s*ginseng)\b", re.I), "panax_ginseng"),
    (re.compile(r"\b(fenugreek|trigonella)\b", re.I), "fenugreek"),
    (re.compile(r"\b(saffron|crocus\s*sativus|crocin|safranal)\b", re.I), "saffron"),
    (re.compile(r"\b(tribulus|tribulus\s*terrestris|puncture\s*vine)\b", re.I), "tribulus_terrestris"),
    (re.compile(r"\b(epimedium|horny\s*goat\s*weed|icariin|yin\s*yang\s*huo)\b", re.I), "epimedium"),
    (re.compile(r"\b(boron|borate)\b", re.I), "boron"),
    (re.compile(r"\b(maca|black\s*maca|lepidium\s*meyenii)\b", re.I), "maca"),
    (re.compile(r"\b(inositol|myo[\s-]*inositol|d[\s-]*chiro[\s-]*inositol)\b", re.I), "inositol"),
    (re.compile(r"\b(nac|n[\s-]*acetyl[\s-]*cysteine|acetylcysteine)\b", re.I), "nac"),
    (re.compile(r"\b(cla|conjugated\s*linoleic\s*acid)\b", re.I), "cla"),
    (re.compile(r"\b(apple\s*cider\s*vinegar|acv)\b", re.I), "apple_cider_vinegar"),
    # Caffeine.
    (re.compile(r"\bcaffeine\b", re.I), "caffeine"),
)


def infer_slug_from_name(name: str | None) -> str | None:
    """Return a canonical ingredient slug if `name` clearly identifies
    a common supplement, else None. Case-insensitive, partial matches OK.

    Examples
    --------
    >>> infer_slug_from_name("Nutricost D3 5000 IU")
    'vitamin_d3'
    >>> infer_slug_from_name("NOW Fish Oil 1000 mg")
    'omega_3'
    >>> infer_slug_from_name("Pre-Workout XYZ")
    'pre_workout'
    """
    if not name:
        return None
    text = str(name)
    for pattern, slug in _PATTERNS:
        if pattern.search(text):
            return slug
    return None


def infer_slugs_from_stack(rows: Iterable) -> set[str]:
    """Walk a list of UserSupplementStack rows and return the set of
    canonical slugs inferred from `custom_name` fields where
    `supplement_ingredient_id` is missing. Rows that already link to a
    catalog ingredient are skipped (callers handle those directly)."""
    slugs: set[str] = set()
    for row in rows:
        if getattr(row, "supplement_ingredient_id", None):
            continue
        inferred = infer_slug_from_name(getattr(row, "custom_name", None))
        if inferred:
            slugs.add(inferred)
    return slugs
