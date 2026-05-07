"""Apply the seeded recovery-day coach recommendation for Maestro flows."""
from __future__ import annotations

import os
import sys
from datetime import date, timedelta

from sqlmodel import Session, select

sys.path.insert(0, os.path.dirname(__file__))

from app.database import engine  # noqa: E402
from app.models import User, UserDayState  # noqa: E402
from app.services.coach.apply_action import apply_action  # noqa: E402


DEFAULT_EMAIL = "e2e_recovery_apply@test.thallo"


def apply_seeded_recovery_recommendation(
    session: Session,
    *,
    email: str = DEFAULT_EMAIL,
) -> dict[str, str]:
    user = session.exec(select(User).where(User.email == email)).first()
    if user is None or user.id is None:
        raise RuntimeError(f"Seeded recovery user not found: {email}")

    result = apply_action(
        session,
        int(user.id),
        {"type": "swap_to_recovery", "count": 1},
        rec_key="e2e_recovery_maestro",
    )
    if not result.applied or result.error:
        raise RuntimeError(f"Recovery recommendation failed: {result.to_dict()}")

    tomorrow = date.today() + timedelta(days=1)
    state = session.exec(
        select(UserDayState)
        .where(UserDayState.user_id == int(user.id), UserDayState.day_key == tomorrow)
    ).first()
    if state is None or state.skipped_focus != "recovery":
        raise RuntimeError(f"Recovery override missing for {email} on {tomorrow}")

    return {
        "email": email,
        "date": tomorrow.isoformat(),
        "summary": result.summary,
    }


def main() -> int:
    if os.getenv("E2E_SEED_RUN_MIGRATIONS", "0") == "1":
        from app.database import create_db_and_tables

        create_db_and_tables()
    email = os.getenv("E2E_RECOVERY_EMAIL") or DEFAULT_EMAIL
    with Session(engine) as session:
        applied = apply_seeded_recovery_recommendation(session, email=email)

    print(
        "Applied seeded recovery recommendation: "
        f"{applied['email']} -> {applied['date']} ({applied['summary']})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
