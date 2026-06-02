"""Lock the demo_resolver overrides against the bundled assets.

In the 2026-05 audit we found 9 overrides whose target free-exercise-db
ids had no `assets/exercise-demos/<id>/0.jpg` + `1.jpg` folder on disk
— so the exercise resolved to a "demo id" the client could never
render. The result was a silent fall-through to the YouTube demo even
though the override existed. Two of those overrides also pointed to
completely wrong movements (`dumbbell snatch` → `One-Arm_Side_Deadlift`
and `bulgarian split squat` → `Dumbbell_Bench_Step`).

This regression test walks every override target and asserts that the
asset folder exists. Future edits to `_OVERRIDES` that point at an
unbundled id will fail loudly here instead of silently breaking the
thumbnail.

Pure-function — reads the file system + the override dict. No DB.
"""
from __future__ import annotations

from pathlib import Path


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


# Try both common layouts. The backend container only has /app/, while
# host-side runs see the assets/ folder relative to the repo root.
_CANDIDATE_ASSET_DIRS = [
    Path(__file__).resolve().parents[2] / "assets" / "exercise-demos",
    Path("/app/assets/exercise-demos"),
]
ASSETS_DIR = next((p for p in _CANDIDATE_ASSET_DIRS if p.is_dir()), None)


def test_every_override_target_has_bundled_assets():
    print("\n[test] _OVERRIDES: every target must have a bundled asset folder")
    if ASSETS_DIR is None:
        # Container env doesn't mount the assets/ tree — skip with a
        # clear message so the host-run version still catches drift.
        print("  ⓘ skipped (no assets/exercise-demos/ in this env)")
        return
    from app.services.workout.demo_resolver import _OVERRIDES
    missing: list[tuple[str, str]] = []
    for source_name, demo_id in _OVERRIDES.items():
        folder = ASSETS_DIR / demo_id
        if not folder.is_dir():
            missing.append((source_name, demo_id))
            continue
        # Both frame images must be present — the client expects a
        # 2-frame loop.
        for frame in ("0.jpg", "1.jpg"):
            if not (folder / frame).is_file():
                missing.append((source_name, f"{demo_id} (missing {frame})"))
                break
    assert not missing, (
        "demo_resolver overrides point at unbundled demo ids:\n  "
        + "\n  ".join(f"{src!r} → {dst}" for src, dst in missing)
    )
    _ok(f"all {len(_OVERRIDES)} overrides have bundled assets")


def test_known_audit_fixes_landed():
    """Lock the specific fixes from the 2026-05 audit so a future edit
    can't silently roll them back. Two classes of fix:

      (a) Truly missing upstream — substituted with the closest bundled
          asset (e.g. `bulgarian split squat` → `Split_Squat_with_Dumbbells`).
      (b) Missing locally but available upstream — we pulled the file
          via the sync script and restored the exact-match override
          (e.g. `zottman curl` → `Zottman_Curl`).
    """
    print("\n[test] _OVERRIDES: 2026-05 audit fixes preserved")
    from app.services.workout.demo_resolver import _OVERRIDES
    expected_fixes = {
        # Class (a): substituted with closest bundled asset.
        "bulgarian split squat": "Split_Squat_with_Dumbbells",
        "pendlay row": "Bent_Over_Barbell_Row",
        "dumbbell row": "One-Arm_Dumbbell_Row",
        "dumbbell romanian deadlift": "Stiff-Legged_Dumbbell_Deadlift",
        "b stance rdl": "Stiff-Legged_Dumbbell_Deadlift",
        "glute bridge": "Barbell_Hip_Thrust",
        "sumo squat": "Goblet_Squat",
        "goblet sumo squat": "Goblet_Squat",
        "lateral step up": "Dumbbell_Step_Ups",
        "dumbbell snatch": "Power_Snatch",
        "snatch": "Power_Snatch",
        "wide pushups": "Pushups",
        "diamond pushups": "Pushups",
        # Class (b): pulled the missing asset from upstream — restored
        # exact match. If any of these regress to a substitute target,
        # something probably deleted the asset folder.
        "wide grip bench press": "Wide-Grip_Barbell_Bench_Press",
        "sumo deadlift": "Sumo_Deadlift",
        "seated leg curl": "Seated_Leg_Curl",
        "tricep extension": "Cable_One_Arm_Tricep_Extension",
        "clean and press": "Clean_and_Press",
        "high pull": "Clean_Pull",
        "clean pull": "Clean_Pull",
        "muscle snatch": "Muscle_Snatch",
        "zottman curl": "Zottman_Curl",
    }
    mismatches: list[tuple[str, str, str]] = []
    for source, expected in expected_fixes.items():
        actual = _OVERRIDES.get(source)
        if actual != expected:
            mismatches.append((source, expected, str(actual)))
    assert not mismatches, (
        "audit fixes drifted:\n  "
        + "\n  ".join(f"{src!r}: expected {exp!r}, got {act!r}" for src, exp, act in mismatches)
    )
    _ok(f"all {len(expected_fixes)} audit fixes still in place")


def test_no_override_targets_thoracic_rotation():
    """Audit explicitly removed the `thoracic rotation` override because
    the asset folder doesn't exist and no good substitute is bundled.
    Falling through to the YouTube demo beats a misleading photo."""
    print("\n[test] _OVERRIDES: thoracic rotation correctly omitted")
    from app.services.workout.demo_resolver import _OVERRIDES
    assert "thoracic rotation" not in _OVERRIDES, (
        "thoracic rotation override was removed in the 2026-05 audit — "
        "do not re-add it without bundling the asset folder."
    )
    _ok("thoracic rotation correctly omitted from overrides")


if __name__ == "__main__":
    cases = [v for k, v in list(globals().items()) if k.startswith("test_") and callable(v)]
    failures = 0
    for case in cases:
        try:
            case()
        except Exception as e:
            failures += 1
            print(f"  ✗ {case.__name__}: {e}")
            import traceback
            traceback.print_exc()
    print()
    if failures == 0:
        print(f"✓ All {len(cases)} tests passed.")
    else:
        print(f"✗ {failures}/{len(cases)} test(s) failed.")
    import sys
    sys.exit(1 if failures else 0)
