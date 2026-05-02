"""Equipment normalization shared by deterministic workout planners."""
from __future__ import annotations

from app.seed_exercises_data import SEED_EQUIPMENT


_EQUIPMENT_NAME_ALIASES = {
    "resistance bands": "resistance_bands",
    "resistance band": "resistance_bands",
    "bands": "resistance_bands",
    "tube bands": "resistance_bands",
    "mini band": "mini_band",
    "mini bands": "mini_band",
    "loop band": "mini_band",
    "loop bands": "mini_band",
    "swiss ball": "swiss_ball",
    "stability ball": "swiss_ball",
    "exercise ball": "swiss_ball",
    "plyo box": "plyo_box",
    "box": "plyo_box",
    "step": "step_platform",
    "aerobic step": "step_platform",
    "slider": "slider_discs",
    "sliders": "slider_discs",
    "sliding discs": "slider_discs",
    "pullup bar": "pull_up_bar",
    "pull-up bar": "pull_up_bar",
    "rower": "rowing_machine",
    "ski erg": "skierg",
    "ski_erg": "skierg",
    "versa climber": "versaclimber",
}


def resolve_equipment_entry(raw: str, name_to_slug: dict[str, str], valid_slugs: set[str]) -> str | None:
    lowered = (raw or "").lower().strip()
    slugish = lowered.replace("-", "_").replace(" ", "_")
    if raw in valid_slugs:
        return raw
    if slugish in valid_slugs:
        return slugish
    return name_to_slug.get(lowered) or _EQUIPMENT_NAME_ALIASES.get(lowered) or _EQUIPMENT_NAME_ALIASES.get(slugish)


def expand_owned_equipment_aliases(owned: set[str]) -> set[str]:
    if "adjustable_dumbbells" in owned:
        owned.add("dumbbells")
    if "adjustable_bench" in owned:
        owned.update({"flat_bench", "incline_bench", "decline_bench"})
    if "incline_bench" in owned or "decline_bench" in owned:
        owned.add("adjustable_bench")
    if "power_rack" in owned:
        owned.add("squat_rack")
    return owned


def resolve_owned_equipment_slugs(equipment: list[str] | None) -> set[str]:
    name_to_slug = {e["name"].lower(): e["slug"] for e in SEED_EQUIPMENT}
    valid_slugs = {e["slug"] for e in SEED_EQUIPMENT}
    owned: set[str] = set()
    for raw in equipment or []:
        if not raw:
            continue
        slug = resolve_equipment_entry(str(raw), name_to_slug, valid_slugs)
        if slug:
            owned.add(slug)
    expand_owned_equipment_aliases(owned)
    for bucket in ("bodyweight", "home", "dumbbells", "gym", "other"):
        if bucket in (equipment or []):
            owned.add(bucket)
    return owned
