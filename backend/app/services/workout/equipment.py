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
    "plates": "weight_plates",
    "weight plates": "weight_plates",
    "sturdy chair": "sturdy_chair",
    "low surface": "sturdy_chair",
    "chair": "sturdy_chair",
    "nordic anchor": "nordic_anchor",
    "nordic strap": "nordic_anchor",
    "foot anchor": "nordic_anchor",
    "pullup bar": "pull_up_bar",
    "pull-up bar": "pull_up_bar",
    "rower": "rowing_machine",
    "ski erg": "skierg",
    "ski_erg": "skierg",
    "versa climber": "versaclimber",
    "machine": "leverage_machines",
    "machines": "leverage_machines",
    "selectorized machine": "leverage_machines",
    "selectorized machines": "leverage_machines",
    "plate loaded machine": "leverage_machines",
    "plate-loaded machine": "leverage_machines",
    "plate loaded machines": "leverage_machines",
    "plate-loaded machines": "leverage_machines",
    "row machine": "machine_row_station",
    "machine row": "machine_row_station",
    "plate loaded row": "machine_row_station",
    "plate-loaded row": "machine_row_station",
    "row station": "machine_row_station",
}


def _normalize_equipment_key(raw: str) -> str:
    return (raw or "").lower().strip()


def equipment_name_slug_index() -> dict[str, str]:
    """Map display names and seed aliases to canonical equipment slugs."""
    index: dict[str, str] = {}
    for entry in SEED_EQUIPMENT:
        slug = entry.get("slug")
        if not slug:
            continue
        names = [entry.get("name", ""), *(entry.get("aliases", []) or [])]
        for name in names:
            key = _normalize_equipment_key(str(name))
            if key:
                index[key] = slug
                index[key.replace("-", "_").replace(" ", "_")] = slug
    return index


def resolve_equipment_entry(raw: str, name_to_slug: dict[str, str], valid_slugs: set[str]) -> str | None:
    lowered = _normalize_equipment_key(raw)
    slugish = lowered.replace("-", "_").replace(" ", "_")
    if raw in valid_slugs:
        return raw
    if slugish in valid_slugs:
        return slugish
    return (
        name_to_slug.get(lowered)
        or name_to_slug.get(slugish)
        or _EQUIPMENT_NAME_ALIASES.get(lowered)
        or _EQUIPMENT_NAME_ALIASES.get(slugish)
    )


def custom_equipment_slug(raw: str) -> str | None:
    """Stable private-equipment key for user-entered equipment names.

    Seed equipment resolves to public slugs. Anything else can still be
    matched deterministically between a user's equipment profile and a
    user-created exercise without adding it to the global equipment table.
    """
    import re

    key = re.sub(r"[^a-z0-9]+", "_", str(raw or "").lower()).strip("_")
    if not key:
        return None
    return f"custom_equipment__{key[:80]}"


def expand_owned_equipment_aliases(owned: set[str]) -> set[str]:
    if "adjustable_dumbbells" in owned:
        owned.add("dumbbells")
    if "adjustable_bench" in owned:
        owned.update({"flat_bench", "incline_bench", "decline_bench"})
    if "incline_bench" in owned or "decline_bench" in owned:
        owned.add("adjustable_bench")
    if "power_rack" in owned:
        owned.add("squat_rack")
    cable_attachments = {
        "d_handle",
        "rope_attachment",
        "straight_bar_attachment",
        "v_bar_attachment",
    }
    has_specific_cable_station = "single_cable_station" in owned or "dual_cable_station" in owned
    if "cable_machine" in owned and not has_specific_cable_station:
        owned.update({
            "single_cable_station",
            "dual_cable_station",
            *cable_attachments,
        })
    if "single_cable_station" in owned:
        owned.update({"cable_machine", *cable_attachments})
    if "dual_cable_station" in owned:
        owned.update({"cable_machine", "single_cable_station", *cable_attachments})
    if "lat_pulldown_machine" in owned:
        owned.update({"straight_bar_attachment", "v_bar_attachment"})
    return owned


def resolve_owned_equipment_slugs(equipment: list[str] | None) -> set[str]:
    name_to_slug = equipment_name_slug_index()
    valid_slugs = {e["slug"] for e in SEED_EQUIPMENT}
    owned: set[str] = set()
    for raw in equipment or []:
        if not raw:
            continue
        slug = resolve_equipment_entry(str(raw), name_to_slug, valid_slugs)
        if slug:
            owned.add(slug)
        else:
            custom_slug = custom_equipment_slug(str(raw))
            if custom_slug:
                owned.add(custom_slug)
    expand_owned_equipment_aliases(owned)
    for bucket in ("bodyweight", "home", "dumbbells", "gym", "other"):
        if bucket in (equipment or []):
            owned.add(bucket)
    return owned
