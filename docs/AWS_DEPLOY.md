# Thallo Backend — AWS Deployment

One document covers the whole pipeline: AWS backend deploy → wire the RN app to it → TestFlight upload.

**Primary path:** AWS App Runner + RDS Postgres with **plain env vars**. No Secrets Manager. Pilot-scale ~$20–40/mo.

**Alternative path (if you prefer containers-only):** ECR + ECS Fargate. Listed at the bottom; more knobs, same cost-band.

---

## 0. Prereqs

- AWS account with admin access.
- GitHub repo (`main` branch).
- Docker image builds locally (`docker compose build backend`).
- `backend/.env` is gitignored and dockerignored (verified).
- OpenAI + USDA API keys in hand.
- `npm install -g eas-cli` for the iOS build step.

---

## 1. Code blockers — already shipped

All pre-deploy BLOCKER items are in. Safe to deploy as-is:
- `SECRET_KEY` validated on startup
- CORS reads from env var
- Rate limits on `/auth/login`, `/auth/register`, `/auth/reset-password`
- `/auth/reset-password` gated behind `DEV_PASSWORD_RESET=1` (don't set in prod)

---

## 2. Provision Postgres (RDS)

Console → RDS → Create database.

- Engine: **PostgreSQL 16**.
- Template: **Free tier** or **Dev/Test**.
- DB instance class: `db.t4g.micro`.
- Storage: 20 GB gp3, auto-scaling to 100 GB.
- Master credentials: username `thallo_admin` + strong password → save to 1Password.
- Connectivity:
  - VPC: default.
  - Public access: **No**.
  - Create new security group `thallo-rds-sg`.
- Initial database name: `thallo`.
- Backups: 7 days retention. Encryption on.

~5 minutes to provision.

When it's up, copy the endpoint (e.g. `thallo.xxxxx.us-east-1.rds.amazonaws.com`). Your `DATABASE_URL` will be:

```
postgresql+psycopg2://thallo_admin:<password>@<endpoint>:5432/thallo
```

---

## 3. App Runner (Primary — Simplest)

Console → App Runner → Create service.

### Source
- Source type: **Source code repository** (build from GitHub).
- Connect to GitHub → authorize AWS Connector for GitHub → pick the repo.
- Branch: `main`.
- Deployment trigger: **Automatic** (push-to-deploy).

### Build
- App Runner detects the Dockerfile at `backend/Dockerfile` and builds from it. If it tries to auto-build as Python and fails, fall back to the ECR path (bottom of doc).
- Port: **8000**.

### Service settings
- Service name: `thallo-backend-prod`.
- CPU / memory: **0.25 vCPU / 0.5 GB** for pilot.
- Env vars (set directly — **no Secrets Manager needed**):

| Key | Value |
|---|---|
| `SECRET_KEY` | `<openssl rand -hex 32>` — generate fresh |
| `OPENAI_API_KEY` | your real key |
| `USDA_FDC_API_KEY` | your real key |
| `DATABASE_URL` | the RDS string from step 2 |
| `CORS_ORIGINS` | `https://app.yourdomain.com` if you have one; leave blank for iOS-only pilot |
| `MODEL_CHAT` | `gpt-4o-mini` |
| `MODEL_MEAL_PARSING` | `gpt-5-mini` |
| `PLAN_REVIEW_ENABLED` | `1` |
| `NUTRITION_REVIEW_ENABLED` | `1` |
| `LOG_LEVEL` | `INFO` |

**Do NOT set `DEV_PASSWORD_RESET`.** Leaving it unset disables the dev-mode password reset in production.

- Auto-scaling: default, but cap max to **2** instances for pilot cost control.
- Health check: path `/health`, interval 10s, healthy threshold 1, unhealthy 5.

### Networking
- Incoming: public endpoint.
- **Outgoing: VPC connector** — same VPC as RDS. Create a new SG for the connector allowing outbound to port 5432.
- RDS security group: add an inbound rule allowing port 5432 from the App Runner VPC connector's SG.

### Observability
- Logs → CloudWatch automatically. Set log-group retention to 30 days.
- (Optional) Enable X-Ray tracing.

Hit Create. First build ~6–10 min. When it's up you get a URL like `https://abcd.us-east-1.awsapprunner.com`. Hit `/health` — should return `{"status":"ok","version":"0.1.0"}`.

### Why not Secrets Manager?
For a closed TestFlight pilot, plain App Runner env vars are fine:
- Encrypted at rest by AWS by default.
- Only visible to accounts with App Runner `ReadService` permission.
- Easy to rotate — edit, redeploy.

Secrets Manager is worth it once you have: multiple environments (staging/prod/preview), automated rotation, or multiple services sharing secrets. Not now.

---

## 4. Smoke test

```bash
export API=https://<your-app-runner-url>

# Basic probes
curl -s $API/health
curl -s $API/ready

# Register → login → me
curl -s -X POST $API/auth/register -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","username":"you","password":"TestPilot123"}'

TOKEN=$(curl -s -X POST $API/auth/login -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"TestPilot123"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")

curl -s $API/auth/me -H "Authorization: Bearer $TOKEN"

# Seed sanity — should be 200+ exercises
curl -s $API/meta/exercises -H "Authorization: Bearer $TOKEN" \
  | python3 -c "import sys,json;print(len(json.load(sys.stdin)))"
```

If any step fails, read CloudWatch logs for the App Runner service — every log line is JSON with a `req` request-ID you can grep.

You can also run the full API smoke suite from your laptop:
```bash
SMOKE_BASE_URL=$API docker exec thallo-backend python -m tests.test_api_smoke
```

---

## 5. Wire the iOS client to App Runner

### 5a. Point the app at the new URL
Edit `app.json`:
```json
"extra": {
  "apiBaseUrl": "https://<your-app-runner-url>"
}
```
`src/services/api.ts:6` reads this via `Constants.expoConfig.extra.apiBaseUrl` and uses it as the base for every request in production builds.

Commit + push.

### 5b. EAS Build for iOS
First-time EAS setup (once):
```bash
npx eas-cli login            # log in with your Expo account
eas init                     # creates eas.json if missing
eas build:configure -p ios   # fills in iOS-specific build config
```

You'll need:
- Apple Developer account ($99/year).
- App Store Connect app record with the bundle ID from `app.json` (`com.thallo.app`).

Trigger the build:
```bash
eas build --platform ios --profile production
```
This uploads the app source to Expo's build farm, produces a signed IPA, and optionally auto-submits to TestFlight if `eas.json` has submit config. Takes ~15–25 min.

### 5c. Submit to TestFlight
If EAS didn't auto-submit:
```bash
eas submit --platform ios --latest
```
This uploads the IPA to App Store Connect. It appears under your app → TestFlight tab after Apple's processing (~5–15 min).

### 5d. Internal testers
App Store Connect → your app → TestFlight → Internal Testing → add your email + any pilot testers (up to 100 internal testers, no Apple review needed).

Testers get an email with a code — they install the **TestFlight** app from the App Store, redeem the code, and your app shows up. Updates push automatically with each new EAS build.

### 5e. External testers (if you want >100 or non-team-member testers)
App Store Connect → TestFlight → External Testing. Requires a one-time Apple Beta App Review (1–2 day turnaround). Afterwards you can invite up to 10,000 testers via email or public link.

---

## 6. Custom domain (optional, 10 min)

App Runner supports custom domains natively.

- Console → App Runner → your service → Custom domains → Add.
- Enter `api.yourdomain.com`.
- App Runner gives you DNS records → add them at your registrar (or Route 53).
- ACM issues the cert automatically.
- Update `CORS_ORIGINS` env var if you also run a web client at a known origin.
- Update `app.json → extra.apiBaseUrl` to the custom domain and rebuild TestFlight.

---

## 7. Rollback

App Runner console → your service → Deployments tab → pick the previous successful deployment → Redeploy. ~1–2 min.

Schema migrations are additive (SQLModel `create_all` + idempotent `ALTER TYPE … IF NOT EXISTS` helpers) so code rollbacks don't require DB rollbacks. This is fine for pilot; revisit before the first breaking schema change (Alembic).

---

## Alternative: ECR + ECS Fargate (more knobs)

Use this if App Runner's auto-build can't find your Dockerfile or you want more control over the task definition.

### Push image to ECR
```bash
aws ecr create-repository --repository-name thallo-backend --region us-east-1

cd backend
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin <acct>.dkr.ecr.us-east-1.amazonaws.com

docker build --platform linux/amd64 -t thallo-backend .
docker tag thallo-backend:latest <acct>.dkr.ecr.us-east-1.amazonaws.com/thallo-backend:latest
docker push <acct>.dkr.ecr.us-east-1.amazonaws.com/thallo-backend:latest
```

### Option A — ECR image via App Runner (recommended)
Easiest. App Runner pulls the ECR image and runs it — same experience as the source-code path, just with your own build step.
- Console → App Runner → Create service → **Container registry** → pick the ECR image.
- Everything else (env vars, VPC connector, health check) is identical to section 3.
- Every deploy becomes `docker push` → App Runner auto-deploys within a minute (enable auto-deploy on the service).

### Option B — ECS Fargate
More involved (~30–60 min of clicking):
1. Create an ECS cluster (Fargate, no EC2).
2. Create a Task Definition referencing the ECR image. Set:
   - Port: 8000.
   - Env vars in the task definition (same list as section 3).
   - Log driver: awslogs to a new CloudWatch log group.
   - Task role with permission to pull from ECR.
3. Create an **ALB** (Application Load Balancer) with a target group on port 8000 and health check path `/health`. Listener on port 443 with an ACM cert.
4. Create an ECS Service on the cluster:
   - Launch type Fargate.
   - Task definition from step 2.
   - Attach to the ALB target group.
   - Networking: private subnets + SG allowing the ALB SG inbound on 8000.
   - Service auto-scaling: min 1, max 2.
5. Allow the task SG outbound → RDS SG inbound on 5432.
6. DNS record → ALB → your service.

You end up with 6+ resources to maintain (cluster, task def, service, ALB, target group, listener, SGs). App Runner is one.

**When ECS makes sense:** you need background worker pools separate from the web tier, blue/green deploys via CodeDeploy, or >4 GB memory per container. Not yet.

---

## Quick reference

| Question | Answer |
|---|---|
| Which doc? | This one. |
| Simplest non-Lightsail path? | App Runner from GitHub source (section 3). |
| Do I need Secrets Manager? | No — plain App Runner env vars are fine for pilot. |
| What about ECS? | Works (see bottom), but strictly more work than App Runner for no benefit at this scale. |
| How does the iOS app know where to hit? | `app.json → extra.apiBaseUrl`, consumed by `src/services/api.ts`. |
| How do testers get the app? | EAS build → `eas submit` → invite via TestFlight tab in App Store Connect. |
