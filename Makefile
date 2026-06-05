.PHONY: start start-fresh tunnel stop reset-db wait-backend test dev maintenance seed-e2e seed-e2e-recovery-apply \
        deploy deploy-backend prepare-ios-build-version deploy-ios deploy-ios-clean smoke-prod smoke-mobile smoke-mobile-seeded \
        smoke-mobile-workouts smoke-mobile-state smoke-mobile-social smoke-mobile-free-gates \
        smoke-mobile-plan-adaptation smoke-mobile-android-platform smoke-mobile-preflight smoke-mobile-preflight-fast smoke-mobile-preflight-parallel

# ── AWS / deploy config ──────────────────────────────────────────────────────
AWS_ACCOUNT_ID  := 225629394823
AWS_REGION      := us-east-1
ECR_REPO        := $(AWS_ACCOUNT_ID).dkr.ecr.$(AWS_REGION).amazonaws.com/thallo-backend
APP_RUNNER_URL  := https://q4q8mjjhmp.us-east-1.awsapprunner.com
MAESTRO_DRIVER_STARTUP_TIMEOUT ?= 120000
MAESTRO ?= MAESTRO_DRIVER_STARTUP_TIMEOUT=$(MAESTRO_DRIVER_STARTUP_TIMEOUT) maestro
MAESTRO_FAST_FLAGS ?=
MAESTRO_PARALLEL_SHARDS ?= 2
MAESTRO_PARALLEL_DEVICES ?=
MAESTRO_PARALLEL_DEVICE_ARG = $(if $(MAESTRO_PARALLEL_DEVICES),--device "$(MAESTRO_PARALLEL_DEVICES)",)

# Run recipes in a login zsh so ~/.zprofile (brew shellenv, etc.) is sourced
# and tools like `npx` / `node` are on PATH.
SHELL := /bin/zsh
.SHELLFLAGS := -l -c

# Flags for `npx expo start`. `make start` runs Expo Go over a tunnel with a
# warm cache (fast, and reaches the phone across networks). `make start-fresh`
# adds `--clear` for a cold rebuild; `make tunnel` / `make dev` cover the other
# modes. Drop `--tunnel` here if your phone + Mac are always on the same WiFi.
EXPO_START_FLAGS ?= --go --tunnel

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
	@echo "[3/3] Starting Expo (flags: $(EXPO_START_FLAGS))..."
	@echo "      Clearing any stale Metro / Expo servers first..."
	@pkill -f "expo start" 2>/dev/null || true
	@echo "      Scan the QR with Expo Go (tunnel reaches across networks)."
	@echo ""
	npx expo start $(EXPO_START_FLAGS)

start-fresh:
	@$(MAKE) start EXPO_START_FLAGS="--go --clear"

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

maintenance:
	@echo ""
	@echo "Running backend maintenance jobs..."
	@echo ""
	@docker exec thallo-backend python -m app.maintenance_jobs --all

seed-e2e:
	@echo ""
	@echo "Seeding deterministic E2E personas..."
	@echo ""
	@docker exec thallo-backend python seed_e2e.py

seed-e2e-recovery-apply: seed-e2e
	@echo ""
	@echo "Applying seeded recovery coach recommendation..."
	@echo ""
	@docker exec thallo-backend python seed_e2e_recovery_apply.py

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

# ── Deploy: iOS (local Xcode build + submit to TestFlight) ────────────────────
# Builds on this machine — no EAS cloud build credits consumed.
# Requires Xcode + valid Apple certs/provisioning in your keychain.
# --auto-submit is not supported with --local, so submit runs separately.
prepare-ios-build-version:
	@echo ""
	@echo "Syncing native iOS targets to the next EAS build number..."
	@IOS_BUILD_NUMBER=$$(eas build:version:get --platform ios --profile production --json --non-interactive 2>/dev/null \
	  | node -e 'let input=""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => { const version = JSON.parse(input); const next = Number(version.buildNumber) + 1; if (!Number.isInteger(next)) throw new Error(`Invalid iOS buildNumber: $${version.buildNumber}`); process.stdout.write(String(next)); });') \
	  node scripts/sync-ios-build-versions.mjs

deploy-ios: prepare-ios-build-version
	@echo ""
	@echo "Building iOS locally..."
	@echo "(~15-25 min depending on machine. No EAS build credits used.)"
	@echo ""
	@# EAS_SKIP_AUTO_FINGERPRINT: the bare-workflow fingerprint step traverses
	@# node_modules + native autolinking and stalls for 20+ min on this project.
	@# We don't use a fingerprint runtimeVersion policy, so skipping is safe.
	@# EAS_NO_VCS: skip eas-cli's git copy step. The repo's .git history is huge
	@# (tens of GB), so the default git-based "Compressing project files" copy
	@# hangs. With this set, eas-cli archives the working dir honoring .easignore.
	@EAS_NO_VCS=1 EAS_SKIP_AUTO_FINGERPRINT=1 eas build --platform ios --profile production --local --non-interactive --output build-latest.ipa
	@echo ""
	@echo "Build finished. Submitting to TestFlight..."
	@eas submit --platform ios --path build-latest.ipa --non-interactive

# Fresh local iOS build — clears EAS's cached entitlements / provisioning.
# Use when entitlements changed (HealthKit, Push, etc.) or app.json
# infoPlist keys changed. Required after any `ios.entitlements` or
# capability edit in Apple Developer portal.
deploy-ios-clean: prepare-ios-build-version
	@echo ""
	@echo "Building iOS locally with --clear-cache (fresh entitlements)..."
	@echo "(~20-30 min. Use after any entitlement / provisioning change.)"
	@echo ""
	@EAS_NO_VCS=1 EAS_SKIP_AUTO_FINGERPRINT=1 eas build --platform ios --profile production --local --non-interactive --clear-cache --output build-latest.ipa
	@echo ""
	@echo "Build finished. Submitting to TestFlight..."
	@eas submit --platform ios --path build-latest.ipa --non-interactive
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
	@$(MAESTRO) test .maestro/flows/signup-and-regen.yaml

smoke-mobile-seeded: seed-e2e
	@echo "Running Maestro seeded returning-user flow (requires backend + Metro running)..."
	@command -v maestro >/dev/null 2>&1 || { \
	  echo "ERROR: maestro not found. Install with:"; \
	  echo "  curl -Ls \"https://get.maestro.mobile.dev\" | bash"; \
	  exit 1; }
	@$(MAESTRO) test .maestro/flows/seeded-returning-user.yaml

smoke-mobile-workouts: seed-e2e
	@echo "Running Maestro workout E2E flows (requires backend + Metro running)..."
	@command -v maestro >/dev/null 2>&1 || { \
	  echo "ERROR: maestro not found. Install with:"; \
	  echo "  curl -Ls \"https://get.maestro.mobile.dev\" | bash"; \
	  exit 1; }
	@$(MAESTRO) test .maestro/flows/recovery-live-workouts.yaml
	@$(MAESTRO) test .maestro/flows/workout-templates.yaml
	@$(MAESTRO) test .maestro/flows/active-workout-swap-recommendations.yaml
	@$(MAESTRO) test .maestro/flows/active-workout-completion.yaml

smoke-mobile-plan-adaptation: seed-e2e-recovery-apply
	@echo "Running Maestro plan-adaptation E2E flows (requires backend + Metro running)..."
	@command -v maestro >/dev/null 2>&1 || { \
	  echo "ERROR: maestro not found. Install with:"; \
	  echo "  curl -Ls \"https://get.maestro.mobile.dev\" | bash"; \
	  exit 1; }
	@$(MAESTRO) test .maestro/flows/ppl-history-ordering.yaml
	@$(MAESTRO) test .maestro/flows/recovery-recommendation-apply.yaml

smoke-mobile-android-platform: seed-e2e
	@echo "Running Android platform parity Maestro flow (requires backend + Metro or installed Android build)..."
	@command -v maestro >/dev/null 2>&1 || { \
	  echo "ERROR: maestro not found. Install with:"; \
	  echo "  curl -Ls \"https://get.maestro.mobile.dev\" | bash"; \
	  exit 1; }
	@$(MAESTRO) test .maestro/flows/android-platform-parity.yaml

smoke-mobile-state: seed-e2e
	@echo "Running Maestro state-mutation E2E flows (requires backend + Metro running)..."
	@command -v maestro >/dev/null 2>&1 || { \
	  echo "ERROR: maestro not found. Install with:"; \
	  echo "  curl -Ls \"https://get.maestro.mobile.dev\" | bash"; \
	  exit 1; }
	@$(MAESTRO) test .maestro/flows/active-workout-completion.yaml
	@$(MAESTRO) test .maestro/flows/activity-nutrition-hydration.yaml
	@$(MAESTRO) test .maestro/flows/meals-supplements-state.yaml
	@$(MAESTRO) test .maestro/flows/meal-history-facts-alignment.yaml

smoke-mobile-social: seed-e2e
	@echo "Running Maestro social digest flow (requires backend + Metro running)..."
	@command -v maestro >/dev/null 2>&1 || { \
	  echo "ERROR: maestro not found. Install with:"; \
	  echo "  curl -Ls \"https://get.maestro.mobile.dev\" | bash"; \
	  exit 1; }
	@$(MAESTRO) test .maestro/flows/social-digest.yaml

smoke-mobile-free-gates: seed-e2e
	@echo "Running Maestro free/pro gate flow."
	@echo "If beta full access is enabled for this build, start Metro with EXPO_PUBLIC_DISABLE_FREE_BETA_FULL_ACCESS=1."
	@command -v maestro >/dev/null 2>&1 || { \
	  echo "ERROR: maestro not found. Install with:"; \
	  echo "  curl -Ls \"https://get.maestro.mobile.dev\" | bash"; \
	  exit 1; }
	@$(MAESTRO) test .maestro/flows/free-vs-pro-gates.yaml

smoke-mobile-preflight:
	@echo "Running Maestro preflight flows with fresh E2E seed data between mutating checks..."
	@command -v maestro >/dev/null 2>&1 || { \
	  echo "ERROR: maestro not found. Install with:"; \
	  echo "  curl -Ls \"https://get.maestro.mobile.dev\" | bash"; \
	  exit 1; }
	@$(MAKE) seed-e2e
	@$(MAESTRO) test .maestro/flows/seeded-returning-user.yaml
	@$(MAKE) seed-e2e
	@$(MAESTRO) test .maestro/flows/plan-settings-immutability.yaml
	@$(MAKE) seed-e2e
	@$(MAESTRO) test .maestro/flows/ppl-history-ordering.yaml
	@$(MAKE) seed-e2e-recovery-apply
	@$(MAESTRO) test .maestro/flows/recovery-recommendation-apply.yaml
	@$(MAKE) seed-e2e
	@$(MAESTRO) test .maestro/flows/account-settings-state.yaml
	@$(MAKE) seed-e2e
	@$(MAESTRO) test .maestro/flows/auth-recovery.yaml
	@$(MAKE) seed-e2e
	@$(MAESTRO) test .maestro/flows/recovery-live-workouts.yaml
	@$(MAKE) seed-e2e
	@$(MAESTRO) test .maestro/flows/workout-templates.yaml
	@$(MAKE) seed-e2e
	@$(MAESTRO) test .maestro/flows/active-workout-swap-recommendations.yaml
	@$(MAKE) seed-e2e
	@$(MAESTRO) test .maestro/flows/active-workout-completion.yaml
	@$(MAKE) seed-e2e
	@$(MAESTRO) test .maestro/flows/activity-nutrition-hydration.yaml
	@$(MAKE) seed-e2e
	@$(MAESTRO) test .maestro/flows/meals-supplements-state.yaml
	@$(MAKE) seed-e2e
	@$(MAESTRO) test .maestro/flows/meal-history-facts-alignment.yaml
	@$(MAKE) seed-e2e
	@$(MAESTRO) test .maestro/flows/social-digest.yaml

# Faster local preflight: same coverage as smoke-mobile-preflight, but with
# fast deterministic reseeds and isolated flow processes.
smoke-mobile-preflight-fast:
	@echo "Running faster Maestro preflight pack with isolated flows and fast reseeds..."
	@command -v maestro >/dev/null 2>&1 || { \
	  echo "ERROR: maestro not found. Install with:"; \
	  echo "  curl -Ls \"https://get.maestro.mobile.dev\" | bash"; \
	  exit 1; }
	@$(MAKE) seed-e2e
	@$(MAESTRO) test .maestro/flows/ppl-history-ordering.yaml
	@$(MAKE) seed-e2e
	@$(MAESTRO) test $(MAESTRO_FAST_FLAGS) .maestro/flows/account-settings-state.yaml
	@$(MAKE) seed-e2e
	@$(MAESTRO) test $(MAESTRO_FAST_FLAGS) .maestro/flows/meal-history-facts-alignment.yaml
	@$(MAKE) seed-e2e
	@$(MAESTRO) test $(MAESTRO_FAST_FLAGS) .maestro/flows/social-digest.yaml
	@$(MAKE) seed-e2e
	@$(MAESTRO) test $(MAESTRO_FAST_FLAGS) .maestro/flows/auth-recovery.yaml
	@$(MAKE) seed-e2e
	@$(MAESTRO) test $(MAESTRO_FAST_FLAGS) .maestro/flows/seeded-returning-user.yaml
	@$(MAKE) seed-e2e
	@$(MAESTRO) test $(MAESTRO_FAST_FLAGS) .maestro/flows/plan-settings-immutability.yaml
	@$(MAKE) seed-e2e-recovery-apply
	@$(MAESTRO) test $(MAESTRO_FAST_FLAGS) .maestro/flows/recovery-recommendation-apply.yaml
	@$(MAKE) seed-e2e
	@$(MAESTRO) test $(MAESTRO_FAST_FLAGS) .maestro/flows/active-workout-swap-recommendations.yaml
	@$(MAKE) seed-e2e
	@$(MAESTRO) test $(MAESTRO_FAST_FLAGS) .maestro/flows/activity-nutrition-hydration.yaml
	@$(MAKE) seed-e2e
	@$(MAESTRO) test $(MAESTRO_FAST_FLAGS) .maestro/flows/meals-supplements-state.yaml
	@$(MAKE) seed-e2e
	@$(MAESTRO) test $(MAESTRO_FAST_FLAGS) .maestro/flows/workout-templates.yaml
	@$(MAKE) seed-e2e
	@$(MAESTRO) test $(MAESTRO_FAST_FLAGS) .maestro/flows/recovery-live-workouts.yaml
	@$(MAKE) seed-e2e
	@$(MAESTRO) test .maestro/flows/active-workout-completion.yaml

# Parallel local preflight. Requires MAESTRO_PARALLEL_SHARDS booted devices.
# Keep shared-user mutating flows sequential to avoid backend fixture races.
smoke-mobile-preflight-parallel:
	@echo "Running parallel Maestro preflight pack across $(MAESTRO_PARALLEL_SHARDS) devices..."
	@command -v maestro >/dev/null 2>&1 || { \
	  echo "ERROR: maestro not found. Install with:"; \
	  echo "  curl -Ls \"https://get.maestro.mobile.dev\" | bash"; \
	  exit 1; }
	@$(MAKE) seed-e2e
	@$(MAESTRO) test $(MAESTRO_FAST_FLAGS) $(MAESTRO_PARALLEL_DEVICE_ARG) --shard-split=$(MAESTRO_PARALLEL_SHARDS) \
	  .maestro/flows/ppl-history-ordering.yaml \
	  .maestro/flows/account-settings-state.yaml \
	  .maestro/flows/meal-history-facts-alignment.yaml \
	  .maestro/flows/social-digest.yaml \
	  .maestro/flows/seeded-returning-user.yaml
	@$(MAKE) seed-e2e
	@$(MAESTRO) test $(MAESTRO_FAST_FLAGS) .maestro/flows/plan-settings-immutability.yaml
	@$(MAKE) seed-e2e-recovery-apply
	@$(MAESTRO) test $(MAESTRO_FAST_FLAGS) $(MAESTRO_PARALLEL_DEVICE_ARG) --shard-split=$(MAESTRO_PARALLEL_SHARDS) \
	  .maestro/flows/recovery-recommendation-apply.yaml \
	  .maestro/flows/active-workout-swap-recommendations.yaml \
	  .maestro/flows/activity-nutrition-hydration.yaml
	@$(MAKE) seed-e2e
	@$(MAESTRO) test $(MAESTRO_FAST_FLAGS) .maestro/flows/auth-recovery.yaml
	@$(MAKE) seed-e2e
	@$(MAESTRO) test $(MAESTRO_FAST_FLAGS) .maestro/flows/meals-supplements-state.yaml
	@$(MAKE) seed-e2e
	@$(MAESTRO) test $(MAESTRO_FAST_FLAGS) .maestro/flows/workout-templates.yaml
	@$(MAKE) seed-e2e
	@$(MAESTRO) test $(MAESTRO_FAST_FLAGS) .maestro/flows/recovery-live-workouts.yaml
	@$(MAKE) seed-e2e
	@$(MAESTRO) test .maestro/flows/active-workout-completion.yaml

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
