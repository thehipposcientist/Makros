.PHONY: start tunnel stop reset-db wait-backend test dev \
        deploy deploy-backend deploy-ios smoke-prod smoke-mobile

# ── AWS / deploy config ──────────────────────────────────────────────────────
AWS_ACCOUNT_ID  := 225629394823
AWS_REGION      := us-east-1
ECR_REPO        := $(AWS_ACCOUNT_ID).dkr.ecr.$(AWS_REGION).amazonaws.com/thallo-backend
APP_RUNNER_URL  := https://q4q8mjjhmp.us-east-1.awsapprunner.com

# Run recipes in a login zsh so ~/.zprofile (brew shellenv, etc.) is sourced
# and tools like `npx` / `node` are on PATH.
SHELL := /bin/zsh
.SHELLFLAGS := -l -c

start:
	@echo ""
	@echo "  ████████╗██╗  ██╗ █████╗ ██╗     ██╗      ██████╗ "
	@echo "  ╚══██╔══╝██║  ██║██╔══██╗██║     ██║     ██╔═══██╗"
	@echo "     ██║   ███████║███████║██║     ██║     ██║   ██║"
	@echo "     ██║   ██╔══██║██╔══██║██║     ██║     ██║   ██║"
	@echo "     ██║   ██║  ██║██║  ██║███████╗███████╗╚██████╔╝"
	@echo "     ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚══════╝ ╚═════╝ "
	@echo ""
	@echo "Starting Thallo..."
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
	@echo "Starting Thallo (TUNNEL mode)..."
	@echo ""
	@echo "[1/4] Starting PostgreSQL + Backend (Docker Compose)..."
	@docker compose up -d --build || (echo "      ERROR: Docker Compose failed. Is Docker Desktop running?" && exit 1)
	@echo "      Done."
	@echo ""
	@echo "[2/4] Waiting for backend to be ready..."
	@$(MAKE) wait-backend
	@echo "      Done."
	@echo ""
	@echo "[3/4] Checking ngrok..."
	@npx @expo/ngrok --version >/dev/null 2>&1 || (echo "      Installing @expo/ngrok..." && npm install -g @expo/ngrok)
	@echo "      Done."
	@echo ""
	@echo "[4/4] Starting Expo (tunnel)..."
	@echo "      This creates a public URL so any device can connect."
	@echo ""
	npx expo start --clear --tunnel

dev:
	@echo ""
	@echo "Starting Thallo (dev client)..."
	@echo ""
	@echo "[1/3] Starting PostgreSQL + Backend (Docker Compose)..."
	@docker compose up -d --build || (echo "      ERROR: Docker Compose failed. Is Docker Desktop running?" && exit 1)
	@echo "      Done."
	@echo ""
	@echo "[2/3] Waiting for backend to be ready..."
	@$(MAKE) wait-backend
	@echo "      Done."
	@echo ""
	@echo "[3/3] Starting Expo (dev client)..."
	@echo "      Open the Thallo dev build on your phone."
	@echo ""
	npx expo start --dev-client

stop:
	@echo ""
	@echo "Stopping Thallo..."
	@echo ""
	@echo "[1/2] Stopping Expo / Metro (port 8081)..."
	@lsof -ti:8081 | xargs kill -9 2>/dev/null || true
	@echo "      Done."
	@echo ""
	@echo "[2/2] Stopping PostgreSQL + Backend (Docker Compose)..."
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
	@docker exec thallo-backend python -m tests.run_all

# ── Deploy: backend (ECR + App Runner auto-deploys) ──────────────────────────
deploy-backend:
	@echo ""
	@echo "Deploying backend to AWS (ECR -> App Runner)..."
	@echo ""
	@echo "[1/4] Authenticating Docker to ECR..."
	@aws ecr get-login-password --region $(AWS_REGION) \
	  | docker login --username AWS --password-stdin $(AWS_ACCOUNT_ID).dkr.ecr.$(AWS_REGION).amazonaws.com
	@echo "      Done."
	@echo ""
	@echo "[2/4] Building image (linux/amd64 for App Runner)..."
	@cd backend && docker build --platform linux/amd64 -t thallo-backend .
	@echo "      Done."
	@echo ""
	@echo "[3/4] Tagging + pushing to ECR..."
	@docker tag thallo-backend:latest $(ECR_REPO):latest
	@docker push $(ECR_REPO):latest
	@echo "      Done."
	@echo ""
	@echo "[4/4] App Runner will auto-deploy within ~60 seconds."
	@echo "      Monitor at https://console.aws.amazon.com/apprunner"
	@echo ""
	@echo "Done. Run 'make smoke-prod' in a minute to verify."

# ── Deploy: iOS (EAS Build + TestFlight submit) ──────────────────────────────
deploy-ios:
	@echo ""
	@echo "Building + submitting iOS to TestFlight..."
	@echo "(~15-25 min for build, another ~5-15 min for Apple processing.)"
	@echo ""
	@eas build --platform ios --profile production --non-interactive
	@echo ""
	@echo "Build finished. Submitting latest to TestFlight..."
	@eas submit --platform ios --latest --non-interactive
	@echo ""
	@echo "Done. Check App Store Connect -> TestFlight tab for processing status."

# ── Deploy everything ────────────────────────────────────────────────────────
deploy: deploy-backend deploy-ios
	@echo ""
	@echo "Full deploy kicked off. Backend is already live; iOS will appear"
	@echo "in TestFlight once Apple finishes processing."

# ── Smoke-test the mobile app via Maestro ────────────────────────────────────
smoke-mobile:
	@echo "Running Maestro smoke flow (requires backend + Metro running)..."
	@command -v maestro >/dev/null 2>&1 || { \
	  echo "ERROR: maestro not found. Install with:"; \
	  echo "  curl -Ls \"https://get.maestro.mobile.dev\" | bash"; \
	  exit 1; }
	@maestro test .maestro/flows/signup-and-regen.yaml

# ── Smoke-test the prod backend ──────────────────────────────────────────────
smoke-prod:
	@echo ""
	@echo "Smoke-testing $(APP_RUNNER_URL)..."
	@echo ""
	@curl -sS $(APP_RUNNER_URL)/health | python3 -m json.tool
	@curl -sS $(APP_RUNNER_URL)/ready | python3 -m json.tool
	@echo ""
	@echo "Running full API smoke suite against prod..."
	@SMOKE_BASE_URL=$(APP_RUNNER_URL) docker exec thallo-backend python -m tests.test_api_smoke
