from __future__ import annotations

import math
import re
from dataclasses import dataclass


@dataclass(frozen=True)
class LabMarker:
    key: str
    label: str
    default_unit: str
    aliases: tuple[str, ...] = ()


LAB_MARKERS: tuple[LabMarker, ...] = (
    LabMarker("a1c", "A1C", "%", ("hba1c", "hemoglobin_a1c", "glycated_hemoglobin")),
    LabMarker("fasting_glucose", "Fasting glucose", "mg/dL", ("glucose", "blood_glucose", "fasting_blood_glucose", "fpg")),
    LabMarker("fasting_insulin", "Fasting insulin", "uIU/mL", ("insulin", "fasting_serum_insulin")),
    LabMarker("total_cholesterol", "Total cholesterol", "mg/dL", ("cholesterol", "tc")),
    LabMarker("ldl", "LDL", "mg/dL", ("ldl_cholesterol", "ldl_c", "ldl-c")),
    LabMarker("hdl", "HDL", "mg/dL", ("hdl_cholesterol", "hdl_c", "hdl-c")),
    LabMarker("triglycerides", "Triglycerides", "mg/dL", ("tg", "trigs")),
    LabMarker("ferritin", "Ferritin", "ng/mL", ("serum_ferritin",)),
    LabMarker("iron", "Iron", "ug/dL", ("serum_iron",)),
    LabMarker("tibc", "TIBC", "ug/dL", ("total_iron_binding_capacity",)),
    LabMarker("transferrin_saturation", "Transferrin saturation", "%", ("tsat", "iron_saturation")),
    LabMarker("vitamin_d", "Vitamin D", "ng/mL", ("25_oh_vitamin_d", "25-oh vitamin d", "25ohd", "vit_d")),
    LabMarker("vitamin_b12", "Vitamin B12", "pg/mL", ("b12", "cobalamin")),
    LabMarker("folate", "Folate", "ng/mL", ("serum_folate",)),
    LabMarker("total_testosterone", "Total testosterone", "ng/dL", ("testosterone", "serum_testosterone", "total_t")),
    LabMarker("free_testosterone", "Free testosterone", "pg/mL", ("free_t", "calculated_free_testosterone")),
    LabMarker("shbg", "SHBG", "nmol/L", ("sex_hormone_binding_globulin",)),
    LabMarker("estradiol", "Estradiol", "pg/mL", ("e2", "estrogen")),
    LabMarker("progesterone", "Progesterone", "ng/mL", ("p4",)),
    LabMarker("lh", "LH", "mIU/mL", ("luteinizing_hormone",)),
    LabMarker("fsh", "FSH", "mIU/mL", ("follicle_stimulating_hormone",)),
    LabMarker("prolactin", "Prolactin", "ng/mL", ("prl",)),
    LabMarker("cortisol", "Cortisol", "ug/dL", ("morning_cortisol", "serum_cortisol")),
    LabMarker("dhea_s", "DHEA-S", "ug/dL", ("dheas", "dhea_sulfate")),
    LabMarker("tsh", "TSH", "mIU/L", ("thyroid_stimulating_hormone",)),
    LabMarker("free_t4", "Free T4", "ng/dL", ("ft4",)),
    LabMarker("free_t3", "Free T3", "pg/mL", ("ft3",)),
    LabMarker("hs_crp", "hs-CRP", "mg/L", ("high_sensitivity_crp", "hscrp")),
    LabMarker("crp", "CRP", "mg/L", ("c_reactive_protein",)),
    LabMarker("hemoglobin", "Hemoglobin", "g/dL", ("hgb",)),
    LabMarker("hematocrit", "Hematocrit", "%", ("hct",)),
    LabMarker("wbc", "White blood cells", "10^3/uL", ("white_blood_cell_count", "white_blood_cells")),
    LabMarker("platelets", "Platelets", "10^3/uL", ("plt", "platelet_count")),
    LabMarker("alt", "ALT", "U/L", ("alanine_aminotransferase",)),
    LabMarker("ast", "AST", "U/L", ("aspartate_aminotransferase",)),
    LabMarker("creatinine", "Creatinine", "mg/dL", ("serum_creatinine",)),
    LabMarker("egfr", "eGFR", "mL/min/1.73m2", ("estimated_gfr", "gfr")),
    LabMarker("sodium", "Sodium", "mmol/L", ("na",)),
    LabMarker("potassium", "Potassium", "mmol/L", ("k",)),
    LabMarker("calcium", "Calcium", "mg/dL", ("ca",)),
    LabMarker("magnesium", "Magnesium", "mg/dL", ("mg",)),
    LabMarker("bone_mineral_density", "Bone mineral density", "g/cm2", ("bmd", "dexa_bmd", "bone_density", "bone_density_bmd")),
    LabMarker("bone_density_t_score", "Bone density T-score", "T-score", ("dexa_t_score", "t_score", "bmd_t_score", "t-score")),
    LabMarker("bone_density_z_score", "Bone density Z-score", "Z-score", ("dexa_z_score", "z_score", "bmd_z_score", "z-score")),
)


def _slug(value: object) -> str:
    text = str(value or "").strip().lower()
    text = text.replace("%", " percent ")
    text = re.sub(r"[^a-z0-9]+", "_", text)
    return re.sub(r"_+", "_", text).strip("_")


_MARKERS_BY_KEY = {m.key: m for m in LAB_MARKERS}
_ALIASES: dict[str, str] = {}
for marker in LAB_MARKERS:
    _ALIASES[_slug(marker.key)] = marker.key
    _ALIASES[_slug(marker.label)] = marker.key
    for alias in marker.aliases:
        _ALIASES[_slug(alias)] = marker.key


def normalize_lab_type(value: object) -> str:
    key = _slug(value)
    if not key:
        return ""
    if key in _ALIASES:
        return _ALIASES[key]
    # Keep uncommon markers rather than throwing them away. Insights only read
    # known keys, but the user can still keep a clean personal lab timeline.
    return key[:80]


def lab_label(lab_type: object) -> str:
    key = normalize_lab_type(lab_type)
    marker = _MARKERS_BY_KEY.get(key)
    if marker:
        return marker.label
    return str(lab_type or key).replace("_", " ").strip().title() or "Lab"


def default_lab_unit(lab_type: object) -> str:
    marker = _MARKERS_BY_KEY.get(normalize_lab_type(lab_type))
    return marker.default_unit if marker else ""


def list_lab_markers() -> list[dict]:
    return [
        {
            "key": marker.key,
            "label": marker.label,
            "default_unit": marker.default_unit,
            "aliases": list(marker.aliases),
        }
        for marker in LAB_MARKERS
    ]


def normalize_lab_value(lab_type: object, value: object, unit: object) -> tuple[float, str]:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        raise ValueError("value must be numeric")
    if not math.isfinite(parsed):
        raise ValueError("value must be finite")

    key = normalize_lab_type(lab_type)
    raw_unit = str(unit or "").strip()
    unit_key = raw_unit.lower().replace("µ", "u").replace("μ", "u")
    unit_key = re.sub(r"\s+", "", unit_key)

    if key in {"fasting_glucose"} and unit_key in {"mmol/l", "mmol"}:
        return round(parsed * 18.0182, 2), "mg/dL"
    if key in {"total_cholesterol", "ldl", "hdl"} and unit_key in {"mmol/l", "mmol"}:
        return round(parsed * 38.67, 2), "mg/dL"
    if key == "triglycerides" and unit_key in {"mmol/l", "mmol"}:
        return round(parsed * 88.57, 2), "mg/dL"
    if key == "vitamin_d" and unit_key in {"nmol/l", "nmol"}:
        return round(parsed / 2.496, 2), "ng/mL"
    if key == "bone_mineral_density" and unit_key in {"mg/cm2", "mg/cm^2"}:
        return round(parsed / 1000.0, 4), "g/cm2"
    if key == "bone_mineral_density" and unit_key in {"g/cm2", "g/cm^2"}:
        return parsed, "g/cm2"
    if key == "bone_density_t_score":
        return parsed, raw_unit or "T-score"
    if key == "bone_density_z_score":
        return parsed, raw_unit or "Z-score"

    return parsed, raw_unit or default_lab_unit(key)
