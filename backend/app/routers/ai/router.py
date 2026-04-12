from fastapi import APIRouter

router = APIRouter(prefix="/ai", tags=["ai"])
print("[AI ROUTER IMPORTED] CODE_VERSION=V7_MODULAR")

# Import endpoint modules so their @router decorators register routes
from . import plans, chat, scanning, progression  # noqa: F401, E402
