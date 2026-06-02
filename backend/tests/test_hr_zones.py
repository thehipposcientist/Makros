"""Backend half of the HR-zone parity contract with the frontend.

These cases mirror `src/utils/__tests__/hrZones.test.ts` line for line.
If a constant or formula in `compute_hr_zones` drifts from the
TypeScript canonical module, both this file and the TS test will
fail — that's the signal to update both sides together rather than
let prescriptions and live-display zones diverge.

Method: %MHR (5 zones, Apple/Garmin/Whoop convention).
"""

from __future__ import annotations

from app.services.workout.cardio import compute_hr_zones, HR_ZONE_BANDS


def test_canonical_30_60_190_case():
    """Audit spec case: 30-year-old, RHR 60, MHR 190.
    Boundaries at 50/60/70/80/90/100% of 190."""
    result = compute_hr_zones(age=30, user_max_hr=190, resting_hr=60)
    assert result["method"] == "pct_max_hr"
    assert result["max_hr"] == 190
    assert result["resting_hr"] == 60
    assert result["max_hr_source"] == "user_entered"
    assert result["resting_hr_source"] == "user_profile"

    zones = result["zones"]
    assert len(zones) == 5
    expected = [
        (1, "Warm Up",   95,  114),
        (2, "Easy",      114, 133),
        (3, "Aerobic",   133, 152),
        (4, "Threshold", 152, 171),
        (5, "Maximum",   171, 190),
    ]
    for z, (zone, label, low, high) in zip(zones, expected):
        assert z["zone"] == zone
        assert z["label"] == label, f"zone {zone}: expected {label!r}, got {z['label']!r}"
        assert z["low"] == low, f"zone {zone}: expected low={low}, got {z['low']}"
        assert z["high"] == high, f"zone {zone}: expected high={high}, got {z['high']}"


def test_138_bpm_canonical_user_falls_in_aerobic_zone():
    """Spec case the redesign was triggered by: 138 bpm should not
    read as a recovery zone for the canonical user."""
    result = compute_hr_zones(age=30, user_max_hr=190, resting_hr=60)
    zones = result["zones"]
    z3 = next(z for z in zones if z["zone"] == 3)
    assert z3["low"] <= 138 < z3["high"], (
        f"138 bpm should sit in Z3 'Aerobic'; got zone band {z3}"
    )


def test_no_legacy_labels():
    """Old %HRR labels should not survive the migration."""
    result = compute_hr_zones(age=30, user_max_hr=190, resting_hr=60)
    legacy = {"recovery", "very easy", "aerobic base", "tempo", "vo₂ max", "fat burn"}
    for z in result["zones"]:
        assert z["label"].lower() not in legacy, f"unexpected legacy label: {z['label']}"


def test_missing_rhr_falls_back_to_60_for_display():
    """RHR is no longer used by the zone math but is still resolved
    and exposed on the result for display features."""
    result = compute_hr_zones(age=30)
    assert result["resting_hr"] == 60
    assert result["resting_hr_source"] == "fallback"


def test_user_max_hr_overrides_estimate():
    """User-entered MHR wins over the Tanaka age estimate."""
    result = compute_hr_zones(age=30, user_max_hr=200, resting_hr=60)
    assert result["max_hr"] == 200
    assert result["max_hr_source"] == "user_entered"
    # Z5 low = 0.9 * 200 = 180; Z5 high closes at MHR.
    assert result["zones"][4]["low"] == 180
    assert result["zones"][4]["high"] == 200


def test_observed_max_hr_wins_over_tanaka_but_loses_to_user():
    """observed > tanaka, but user-entered > observed."""
    obs = compute_hr_zones(age=30, observed_max_hr=192, resting_hr=60)
    assert obs["max_hr"] == 192
    assert obs["max_hr_source"] == "observed"
    user = compute_hr_zones(age=30, observed_max_hr=192, user_max_hr=200, resting_hr=60)
    assert user["max_hr"] == 200
    assert user["max_hr_source"] == "user_entered"


def test_rhr_priority_chain_for_display():
    """7d → 30d → profile → fallback. Carried through to the
    `resting_hr` / `resting_hr_source` display fields even though
    the zone math itself doesn't consume RHR."""
    r7 = compute_hr_zones(age=30, rhr_7d=55, rhr_30d=58, resting_hr=62)
    assert r7["resting_hr"] == 55
    assert r7["resting_hr_source"] == "apple_health_7d"
    r30 = compute_hr_zones(age=30, rhr_30d=58, resting_hr=62)
    assert r30["resting_hr"] == 58
    assert r30["resting_hr_source"] == "apple_health_30d"
    rprof = compute_hr_zones(age=30, resting_hr=62)
    assert rprof["resting_hr"] == 62
    assert rprof["resting_hr_source"] == "user_profile"


def test_below_z1_values_are_below_lowest_band():
    """A heart-rate value below Z1's lower bound (under 50% MHR) sits
    below the band table; UI may snap it to Z1 for display via
    `zoneForHeartRate` but the bands themselves are unchanged."""
    result = compute_hr_zones(age=30, user_max_hr=190, resting_hr=60)
    z1 = result["zones"][0]
    assert 90 < z1["low"]  # 50% × 190 = 95 → anything ≤94 sits below Z1


def test_parity_case_2_age_40_rhr_7d_55():
    """Mirrors the TS parity test: age=40, RHR=55 (7d), no user MHR.
    Tanaka(40) = 180. Boundaries land on integers."""
    result = compute_hr_zones(age=40, rhr_7d=55)
    assert result["max_hr"] == 180
    assert result["max_hr_source"] == "estimated_tanaka"
    assert result["resting_hr"] == 55
    assert result["resting_hr_source"] == "apple_health_7d"
    boundaries = [(z["zone"], z["low"], z["high"]) for z in result["zones"]]
    assert boundaries == [
        (1,  90, 108),
        (2, 108, 126),
        (3, 126, 144),
        (4, 144, 162),
        (5, 162, 180),
    ]


def test_band_table_has_five_zones_in_order():
    """Sanity: the band table has exactly five entries (Z1..Z5) in
    ascending-zone order, and bands are contiguous."""
    assert len(HR_ZONE_BANDS) == 5
    for i, band in enumerate(HR_ZONE_BANDS):
        assert band["zone"] == i + 1
    for i in range(1, len(HR_ZONE_BANDS)):
        assert HR_ZONE_BANDS[i]["low_pct"] == HR_ZONE_BANDS[i - 1]["high_pct"]
