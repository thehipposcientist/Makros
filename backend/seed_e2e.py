"""Seed deterministic E2E personas into the configured backend database."""
from __future__ import annotations

import os
import sys

from sqlmodel import Session

sys.path.insert(0, os.path.dirname(__file__))

from app.database import engine  # noqa: E402
from app.e2e_seed import seed_e2e_data  # noqa: E402


def main() -> int:
    if os.getenv("E2E_SEED_RUN_MIGRATIONS", "0") == "1":
        from app.database import create_db_and_tables

        create_db_and_tables()
    with Session(engine) as session:
        summary = seed_e2e_data(session)

    print("Seeded E2E personas:")
    for user in summary["users"]:
        tier = user["subscription_tier"]
        print(f"  {user['key']}: {user['email']} ({tier})")
    print(f"Password: {summary['password']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
