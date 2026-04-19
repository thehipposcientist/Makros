"""
Backend test suite. Tests live OUTSIDE the `app/` package so production
code never imports test modules and CI can collect them with one path.

Run all tests:
    make test

Or directly:
    docker exec thallo-backend python -m tests.run_all

Or one suite at a time:
    docker exec thallo-backend python -m tests.test_workout_planner
"""
