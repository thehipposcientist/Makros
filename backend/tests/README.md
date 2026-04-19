# Backend tests

All backend tests live in this folder. Tests are intentionally NOT inside
`app/` so production code never imports test modules and CI can collect
them with one path.

## Running

From the repo root:

```bash
make test                  # runs every test suite inside the backend container
```

Or one suite at a time:

```bash
docker exec thallo-backend python -m tests.test_workout_planner
docker exec thallo-backend python -m tests.test_calorie_calculator
docker exec thallo-backend python -m tests.test_meal_assembler
```

Or all at once via the runner:

```bash
docker exec thallo-backend python -m tests.run_all
```

## What's covered

| Module | Subject |
|---|---|
| `test_calorie_calculator.py` | Mifflin-St Jeor BMR, TDEE, goal adjustments, partial overrides, macro consistency |
| `test_meal_assembler.py` | Food matching specificity, slot-aware fallback, slot completeness repair, stub detection, solver residual checks |
| `test_workout_planner.py` | Split selection, weekly volume, day templates, exercise selection, prescription, **history-aware continuity**, **session-to-session progression** |

## Adding a new test module

1. Drop a `test_<thing>.py` file in this folder.
2. Define test functions named `test_*`.
3. Add the module name to `_TEST_MODULES` in `run_all.py` (or rely on
   the `__main__` block in your file if you only want it to run via
   the direct path).

Tests use stdlib only — no pytest. Each test prints a one-line result
so you can eyeball the output without a test framework.
