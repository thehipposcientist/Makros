# Thallo Backend — AWS Deployment (App Runner + RDS)

The simplest managed path that isn't Lightsail. **AWS App Runner** builds
the container, runs it with HTTPS, auto-scales on request load, and
auto-deploys on every `git push` to your main branch. **RDS Postgres**
gives you managed Postgres with automated backups.

**Monthly cost (rough):** ~$20–40/mo for pilot-scale.
- App Runner `0.25 vCPU / 0.5 GB` on auto-pause ≈ $5–15/mo idle-ish.
- RDS `db.t4g.micro` single-AZ ≈ $13/mo + storage.
- Data egress: negligible at pilot traffic.

For a small closed TestFlight pilot (≤50 users) this is more than enough.

---

## 0. Prereqs

- AWS account with admin access.
- GitHub repo (this one). Branch you want to deploy — typically `main`.
- Docker image builds locally (`docker compose build backend` currently works).
- AWS CLI installed (optional — everything below is clickable in the
  console, but CLI is copy-paste-faster).
- All API keys (OpenAI, USDA) on hand.

---

## 1. Ship the blockers first

Before you push the App Runner "Deploy" button, fix the **BLOCKER** items
in `docs/RECOMMENDATIONS.md`:

- [ ] `SECRET_KEY` startup validation.
- [ ] CORS locked to your client origin(s), read from env var.
- [ ] Rate limiting on auth endpoints (`slowapi`).
- [ ] Replace or disable dev-mode `/auth/reset-password`.

Also confirm `backend/.gitignore` ignores `.env` (it does) and that the
Docker build doesn't `COPY .env` into the image — the repo's Dockerfile
should only copy application source. If it doesn't, add `.env` and
`.env*` to a `backend/.dockerignore`.

---

## 2. Provision Postgres (RDS)

Console → RDS → Create database.

- Engine: **PostgreSQL 16** (matches local Docker).
- Template: **Free tier** (fine for pilot) or **Dev/Test**.
- DB instance class: `db.t4g.micro`.
- Storage: 20 GB gp3, auto-scaling to 100 GB.
- Credentials: set a master username (`thallo_admin`) and strong password. **Save to 1Password**.
- Connectivity:
  - VPC: default.
  - Public access: **No** (App Runner will reach it via VPC connector).
  - VPC security group: create a new one called `thallo-rds-sg`. You'll
    edit its inbound rule in step 4.
- Additional config:
  - Initial database name: `thallo`.
  - Backups: 7 days retention.
  - Encryption: on (default KMS key is fine).
  - Maintenance window: pick a low-traffic time.

Hit **Create database**. Takes ~5 minutes.

When it's up, copy the **endpoint** (e.g. `thallo.xxxxx.us-east-1.rds.amazonaws.com`). Your `DATABASE_URL` will be:

```
postgresql+psycopg2://thallo_admin:<password>@<endpoint>:5432/thallo
```

---

## 3. Put secrets in Secrets Manager

Console → AWS Secrets Manager → Store a new secret.

- Secret type: **Other type of secret**.
- Key/value pairs (one secret per key is fine, but grouping is cheaper):
  - `SECRET_KEY` — fresh 64-char hex (`openssl rand -hex 32`).
  - `OPENAI_API_KEY`
  - `USDA_FDC_API_KEY`
  - `DATABASE_URL` — the full string from step 2.
  - `CORS_ORIGINS` — comma-separated origins you'll allow. For TestFlight, include the Expo dev URL and eventually your production app scheme.
- Secret name: `thallo/backend/prod`.
- Leave rotation off for now.

---

## 4. Create the App Runner service

Console → App Runner → Create service.

### Source

- Source type: **Source code repository** (builds from your GitHub). Alternatively use **Container registry** → ECR if you prefer to build images yourself.
- Connect to GitHub → authorize the AWS Connector for GitHub → pick the repo.
- Branch: `main`.
- Deployment trigger: **Automatic** (push-to-deploy).

### Build

- Configuration file: **Configure all settings here** (skip `apprunner.yaml` for now).
- Runtime: **Python 3** (the console will actually build from your Dockerfile if it detects one; confirm it picks `backend/Dockerfile`).
- If App Runner insists on a managed runtime and can't find your Dockerfile, see the **ECR path** at the bottom.
- Build command: leave empty (Dockerfile handles it).
- Start command: leave empty (Dockerfile's `CMD` handles it).
- Port: **8000**.

### Service settings

- Service name: `thallo-backend-prod`.
- CPU / memory: **0.25 vCPU / 0.5 GB** for pilot (cheapest). Bump to 0.5/1 GB if you see 499 timeouts.
- Env vars — reference Secrets Manager:
  - `SECRET_KEY` → `thallo/backend/prod:SECRET_KEY`
  - `OPENAI_API_KEY` → `thallo/backend/prod:OPENAI_API_KEY`
  - `USDA_FDC_API_KEY` → `thallo/backend/prod:USDA_FDC_API_KEY`
  - `DATABASE_URL` → `thallo/backend/prod:DATABASE_URL`
  - `CORS_ORIGINS` → `thallo/backend/prod:CORS_ORIGINS`
  - `MODEL_CHAT` = `gpt-4o-mini` (plain env, not secret)
  - `MODEL_MEAL_PARSING` = `gpt-5-mini`
  - `PLAN_REVIEW_ENABLED` = `1`
  - `NUTRITION_REVIEW_ENABLED` = `1`
- Auto-scaling: default is fine (1–25 instances). For TestFlight, cap max at 2 to avoid runaway cost.
- Health check: path `/health`, interval 10s, healthy threshold 1, unhealthy 5.

### Networking

- Incoming: public endpoint.
- **Outgoing: VPC connector** — this is how App Runner reaches your private RDS. Create a new VPC connector using the same VPC as RDS; attach a new security group (or reuse one that allows outbound to RDS on 5432).
- Back on the RDS security group (step 2), add an inbound rule allowing port 5432 from the App Runner VPC connector's security group.

### Observability

- Enable **tracing** (AWS X-Ray) if you want — free tier is generous.
- Logs go to CloudWatch automatically. Retention: set to 30 days on the log group.

Create the service. First build takes ~6–10 minutes.

When it's live, App Runner gives you a URL like `https://abcd.us-east-1.awsapprunner.com`. That's your backend. Hit `/health` — should return `{"status":"ok"}`.

---

## 5. Point the client at it

- Update `app.json` / `app.config.ts` to set `extra.apiBaseUrl` to the App Runner URL.
- Update `src/services/api.ts:15` to read from `expo-constants.expoConfig.extra.apiBaseUrl` with the App Runner URL as default.
- Rebuild TestFlight build.

---

## 6. Custom domain (optional, 10 min)

App Runner supports custom domains natively.

- Console → App Runner → your service → **Custom domains** → Add.
- Enter `api.yourdomain.com` (or similar).
- App Runner gives you DNS records — add them at your registrar (or Route 53).
- Certificate is issued automatically via ACM.
- Update `CORS_ORIGINS` if the client URL changes too.

---

## 7. Smoke test

```bash
# Register
curl -s -X POST https://<your-app-runner>/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","username":"you","password":"TestPilot123"}'

# Login
TOKEN=$(curl -s -X POST https://<your-app-runner>/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"TestPilot123"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")

# Me
curl -s https://<your-app-runner>/auth/me -H "Authorization: Bearer $TOKEN"

# Seed sanity — exercises should have 201 rows
curl -s https://<your-app-runner>/meta/exercises -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json;print(len(json.load(sys.stdin)))"
```

If any fail, CloudWatch logs for the App Runner service show the stack trace.

---

## ECR fallback (if App Runner can't build your Dockerfile)

App Runner's Python auto-build assumes a `requirements.txt` at repo root. Your repo builds via Dockerfile. If App Runner gets confused:

1. Create an ECR repo: `aws ecr create-repository --repository-name thallo-backend`.
2. Build + push:
   ```bash
   cd backend
   aws ecr get-login-password --region us-east-1 | \
     docker login --username AWS --password-stdin <acct>.dkr.ecr.us-east-1.amazonaws.com
   docker build --platform linux/amd64 -t thallo-backend .
   docker tag thallo-backend:latest <acct>.dkr.ecr.us-east-1.amazonaws.com/thallo-backend:latest
   docker push <acct>.dkr.ecr.us-east-1.amazonaws.com/thallo-backend:latest
   ```
3. In App Runner, change Source to **Container registry** and point at the ECR image.
4. Every deploy becomes `docker push` → App Runner picks it up within a minute.

Add a GitHub Actions workflow later to automate the ECR push on `main` pushes.

---

## Rollback

- In App Runner console → service → **Deployments** tab → pick the previous successful deployment → **Redeploy**. Takes 1–2 min.
- Migration failures: roll back the container AND roll back the DB manually. Since we haven't wired Alembic yet, schema changes are SQLModel `Base.metadata.create_all` on startup — additive only. That's acceptable for pilot; revisit before the first breaking change.

---

## When to graduate off App Runner

- You need more than 2 vCPU / 4 GB per instance. (You probably don't for a long time.)
- You want background workers separate from web workers (e.g. long-running plan-gen queue). Move the API to App Runner *and* spin up a Fargate service for workers; share the same ECR image.
- You want canary / blue-green deploys. Move to ECS with CodeDeploy.

For the TestFlight pilot: App Runner + RDS is the right answer.
