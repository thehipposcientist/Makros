"""
Tiny test runner — invokes every `test_*` module under `tests/` and
aggregates their pass/fail counts.

Each test module is expected to:
  - expose a `cases = [...]` list of test functions, OR
  - guard its own `__main__` block that runs cases and exits with
    a non-zero code on failure
We use the second contract because every test module already ships
that pattern. We just import and run their `__main__` equivalent.

Run:
    docker exec thallo-backend python -m tests.run_all
"""
from __future__ import annotations

import importlib
import sys
import traceback


_TEST_MODULES = (
    "tests.test_calorie_calculator",
    "tests.test_meal_assembler",
    "tests.test_workout_planner",
    "tests.test_workout_goals",
    "tests.test_workout_archetypes",
    "tests.test_focus_differentiation",
    "tests.test_set_programming",
    "tests.test_plan_review",
    "tests.test_in_workout_review",
    "tests.test_fitness_score",
    # Planner canonical-schema + focus wiring + patch rehydration.
    "tests.test_planner_schema",
    # prev_focuses → planner rotation + meal_history → nutrition context.
    "tests.test_history_plumbing",
    # End-to-end HTTP smoke — requires backend running at localhost:8000.
    # Skipped automatically when the server isn't up; see test_api_smoke.py.
    "tests.test_api_smoke",
)


def main() -> int:
    failures = 0
    for module_name in _TEST_MODULES:
        print()
        print("#" * 64)
        print(f"#  {module_name}")
        print("#" * 64)
        try:
            mod = importlib.import_module(module_name)
        except Exception as e:
            print(f"  ✗ IMPORT ERROR: {e}")
            traceback.print_exc()
            failures += 1
            continue

        cases = getattr(mod, "cases", None) or _discover_cases(mod)
        if not cases:
            print(f"  (no test cases discovered in {module_name})")
            continue

        for case in cases:
            try:
                case()
            except AssertionError as e:
                print(f"  ✗ FAIL [{case.__name__}]: {e}")
                failures += 1
            except Exception as e:
                print(f"  ✗ ERROR [{case.__name__}] ({type(e).__name__}): {e}")
                failures += 1

    print()
    print("=" * 64)
    if failures:
        print(f"  {failures} test(s) FAILED across all modules")
        return 1
    print("  All test suites passed.")
    return 0


def _discover_cases(mod) -> list:
    """Pick up every top-level `test_*` callable from a module."""
    return [
        getattr(mod, name)
        for name in dir(mod)
        if name.startswith("test_") and callable(getattr(mod, name))
    ]


if __name__ == "__main__":
    sys.exit(main())
