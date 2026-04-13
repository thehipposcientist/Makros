.PHONY: start tunnel stop reset-db wait-backend test

# Run recipes in a login zsh so ~/.zprofile (brew shellenv, etc.) is sourced
# and tools like `npx` / `node` are on PATH.
SHELL := /bin/zsh
.SHELLFLAGS := -l -c

start:
	@echo ""
	@echo "  ███╗   ███╗ █████╗ ██╗  ██╗██████╗  ██████╗ ███████╗"
	@echo "  ████╗ ████║██╔══██╗██║ ██╔╝██╔══██╗██╔═══██╗██╔════╝"
	@echo "  ██╔████╔██║███████║█████╔╝ ██████╔╝██║   ██║███████╗"
	@echo "  ██║╚██╔╝██║██╔══██║██╔═██╗ ██╔══██╗██║   ██║╚════██║"
	@echo "  ██║ ╚═╝ ██║██║  ██║██║  ██╗██║  ██║╚██████╔╝███████║"
	@echo "  ╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝"
	@echo ""
	@echo "Starting Makros..."
	@echo ""
	@echo "[1/3] Starting PostgreSQL + Backend (Docker Compose)..."
	@docker compose up -d --build || (echo "      ERROR: Docker Compose failed. Is Docker Desktop running?" && exit 1)
	@echo "      Done."
	@echo ""
	@echo "[2/3] Waiting for backend to be ready..."
	@$(MAKE) wait-backend
	@echo "      Done."
	@echo ""
	@echo "[3/3] Starting Expo (LAN mode)..."
	@echo "      Scan the QR code with Expo Go on your phone."
	@echo "      Both devices must be on the same WiFi network."
	@echo ""
	npx expo start --clear

tunnel:
	@echo ""
	@echo "Starting Makros (TUNNEL mode)..."
	@echo ""
	@echo "NOTE: Tunnel mode requires a free ngrok account."
	@echo "      If you see an error, run: npx ngrok authtoken YOUR_TOKEN"
	@echo ""
	@echo "[1/3] Starting PostgreSQL + Backend (Docker Compose)..."
	@docker compose up -d --build || (echo "      ERROR: Docker Compose failed. Is Docker Desktop running?" && exit 1)
	@echo "      Done."
	@echo ""
	@echo "[2/3] Waiting for backend to be ready..."
	@$(MAKE) wait-backend
	@echo "      Done."
	@echo ""
	@echo "[3/3] Starting Expo (tunnel)..."
	npx expo start --clear --tunnel

stop:
	@echo ""
	@echo "Stopping Makros..."
	@echo ""
	@echo "[1/2] Stopping Expo / Metro (port 8081)..."
	@lsof -ti:8081 | xargs kill -9 2>/dev/null || true
	@echo "      Done."
	@echo ""
	@echo "[2/2] Stopping PostgreSQL + Backend (Docker Compose)..."
	@# Use `stop` (not `down`) so containers + network + volumes are preserved.
	@# Only `make reset-db` is allowed to destroy database state.
	@docker compose stop
	@echo "      Done."
	@echo ""
	@echo "All services stopped. Data preserved. Run 'make start' to resume."

reset-db:
	@echo ""
	@echo "  WARNING: This will delete ALL data and recreate the database from scratch."
	@echo ""
	@read -p "Are you sure? (y/N): " confirm; \
	if [ "$$confirm" != "y" ] && [ "$$confirm" != "Y" ]; then echo "Cancelled."; exit 1; fi
	@echo ""
	@echo "[1/3] Stopping everything..."
	@docker compose down -v
	@echo "      Done."
	@echo ""
	@echo "[2/3] Rebuilding and starting fresh..."
	@docker compose up -d --build || (echo "      ERROR: Docker Compose failed. Is Docker Desktop running?" && exit 1)
	@echo "      Done."
	@echo ""
	@echo "[3/3] Waiting for backend to seed database..."
	@$(MAKE) wait-backend
	@echo "      Done."
	@echo ""
	@echo "Database reset complete. Run 'make start' to launch the app."

wait-backend:
	@until curl -sf http://localhost:8000/health >/dev/null 2>&1; do sleep 2; done

test:
	@echo ""
	@echo "Running backend test suites..."
	@echo ""
	@docker exec makros-backend python -m tests.run_all
