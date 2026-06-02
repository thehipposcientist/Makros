# Thallo — Deployment Playbook

End-to-end guide for deploying backend + iOS client. Covers first-time setup and every subsequent update cycle. Battle-tested against the initial pilot deploy — gotchas called out inline.

**Stack:**
- Backend: Python 3.12 / FastAPI in Docker → AWS ECR → AWS App Runner (us-east-1)
- Database: AWS RDS Postgres 16 (us-east-1, same VPC as App Runner)
- iOS client: Expo React Native → EAS Build → TestFlight

**Cost target:** ~$20–40/month for a 20–50 person pilot.

---

## 0. One-time prereqs

- AWS account + admin user with an Access Key.
- `brew install awscli` then `aws configure` (region `us-east-1`).
- Docker Desktop installed and running.
- Apple Developer Program membership active (`$99/year`, required for TestFlight).
- Node 20+, `npm install -g eas-cli`, `eas login`.
- Expo account (free) — created via `eas login` if you don't have one.

Sanity check: `aws sts get-caller-identity` returns your account ID; `eas whoami` returns your Expo username.

---

# Backend deploy

Target: a live App Runner service at `https://<id>.us-east-1.awsapprunner.com` answering `/health` and `/ready`.

## 1. Provision RDS Postgres (one-time)

1. AWS Console → top-right region selector → **us-east-1**. (RDS and App Runner must share a region.)
2. RDS → Databases → **Create database**.
3. Settings:
   - Engine: **PostgreSQL 16.x**
   - Template: **Free tier** (or Dev/Test)
   - DB identifier: `thallo-db`
   - Master username: `thallo_admin`
   - Master password: generate strong → **save to 1Password**
4. Instance class: **db.t4g.micro** (or db.t3.micro if arm isn't offered)
5. Storage: gp3, 20 GiB, autoscale to 100 GiB
6. Availability: **Single DB instance**
7. Connectivity:
   - Default VPC
   - Public access: **No**
   - VPC security group: **Create new** → `thallo-rds-sg`
   - Port: 5432
8. Additional configuration (expand — this section is collapsed by default):
   - **Initial database name: `thallo`** (or whatever you pick; case-sensitive, remember it exactly)
   - Backups: 7 days retention
   - Encryption: on (default KMS key)
   - Deletion protection: on
9. Create.

Wait ~5 min. When Status = **Available**, copy the **endpoint** (RDS → Databases → your DB → Connectivity & security tab → Endpoint). Looks like `thallo-db.xxxxx.us-east-1.rds.amazonaws.com`.

Build your connection string:
```
postgresql+psycopg2://thallo_admin:<PASSWORD>@<ENDPOINT>:5432/<INITIAL_DB_NAME>
```
URL-encode any special chars (`@ # % & + / : ?`) in the password.

> **Gotcha:** if you spell the initial DB name differently in the connection string than what you typed in RDS, the backend crashes on startup with exit code 255. Double-check the exact spelling.

## 2. Push container to ECR (first time AND every update)

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=us-east-1
REPO=$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/thallo-backend
```

First time only, create the repo:
```bash
aws ecr create-repository --repository-name thallo-backend --region $REGION
```

Every build:
```bash
# 1. Auth Docker to ECR (credential expires hourly — re-run when pushes fail with 401)
aws ecr get-login-password --region $REGION \
  | docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com

# 2. Build for linux/amd64
cd /Users/sawyerhannel/Documents/GitHub/Makros/backend
docker build --platform linux/amd64 -t thallo-backend .

# 3. Tag + push
docker tag thallo-backend:latest $REPO:latest
docker push $REPO:latest
```

> **Gotcha — critical on Apple Silicon:** `--platform linux/amd64` is MANDATORY. App Runner runs x86 only. An arm64 image gets pulled successfully, then the container exits immediately with code 255 and no application logs (it never runs a line of Python). Symptom is the deploy failing right after "Successfully pulled image" with zero traceback anywhere.

> **Gotcha — build context:** you must `cd backend` first. Running `docker build .` from the repo root will either not find the Dockerfile or COPY the whole monorepo into the image (bloated + confusing).

After `docker push` completes, ECR → your repo → Images shows a `latest` tag with a size around 300–400 MB.

## 3. Create the App Runner service (one-time)

AWS Console → App Runner → **Create service**.

### Source
- Source type: **Container registry** → Amazon ECR.
- Image: Browse → `thallo-backend` → tag `latest`.
- Deployment trigger: **Automatic** (future `docker push` cycles auto-redeploy within ~60 s).
- ECR access role: **Create new service role** (default name `AppRunnerECRAccessRole`).

### Configure service
- Service name: `thallo-backend-prod`
- Virtual CPU: **0.25 vCPU** / Memory: **0.5 GB**
- **Port: 8000** (default is 8080 — MUST change)
- Start command: blank (Dockerfile CMD handles it)

### Environment variables
Use plain text for each. **Do not leave any value blank** — App Runner rejects empty strings. If you want a variable empty, just don't add it.

| Name | Value |
|---|---|
| `SECRET_KEY` | output of `openssl rand -hex 32` |
| `OPENAI_API_KEY` | your OpenAI key |
| `USDA_FDC_API_KEY` | your USDA key |
| `FATSECRET_CLIENT_ID` | FatSecret Platform client ID, omit until approved/configured |
| `FATSECRET_CLIENT_SECRET` | FatSecret Platform client secret, omit until approved/configured |
| `FATSECRET_SCOPE` | `basic` initially; use `premier` for Premier/Premier Free search v5 |
| `FATSECRET_SEARCH_VERSION` | `v1` initially; use `v5` with Premier access |
| `DATABASE_URL` | connection string from step 1 |
| `ALGORITHM` | `HS256` |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `10080` |
| `MODEL_CHAT` | `gpt-4o-mini` |
| `MODEL_CHAT_FALLBACK` | `gpt-4o-mini` |
| `MODEL_INTENT` | `gpt-4o-mini` |
| `MODEL_FOOD_ENRICHMENT` | `gpt-4o-mini` |
| `MODEL_PLAN_GENERATION` | `gpt-4o-mini` |
| `MODEL_PLAN_UPDATE` | `gpt-4o-mini` |
| `MODEL_MEAL_PARSING` | `gpt-4o-mini` |
| `MODEL_TRANSCRIPTION` | `gpt-4o-mini-transcribe` |
| `MODEL_IMAGE` | `gpt-5.4-mini` |
| `PLAN_REVIEW_ENABLED` | `0` |
| `NUTRITION_REVIEW_ENABLED` | `0` |
| `STARTUP_DATA_MAINTENANCE_ENABLED` | `0` |
| `STARTUP_BACKFILLS_ENABLED` | `0` |
| `LOG_LEVEL` | `INFO` |
| `SMTP_HOST` | SMTP hostname from SES/Postmark/SendGrid/etc. |
| `SMTP_PORT` | usually `587` |
| `SMTP_USERNAME` | SMTP username |
| `SMTP_PASSWORD` | SMTP password |
| `SMTP_FROM_EMAIL` | verified sender address, e.g. `support@thallo.app` |
| `SMTP_FROM_NAME` | `Thallo` |
| `SMTP_USE_TLS` | `1` |
| `EMAIL_VERIFICATION_URL_TEMPLATE` | optional deep-link/web template containing `{email}` and `{token}` |
| `PASSWORD_RESET_URL_TEMPLATE` | optional deep-link/web template containing `{email}` and `{token}` |
| `SOCIAL_FEED_ENABLED` | omit or set `1`; set `0` only to disable friends activity feed |
| `GOOGLE_CLIENT_IDS` | comma-separated Google OAuth client IDs accepted by the backend, including the web/iOS/Android IDs used by builds |

**Do NOT set `DEV_PASSWORD_RESET`.** Omitting it disables the dev-mode password reset endpoint in prod.

Use a branded sender for beta if possible: `support@thallo.app` through Google Workspace, Postmark, SES, SendGrid, or any equivalent SMTP provider. A plain Gmail address can work for a tiny private pilot, but it looks less trustworthy in password-reset and verification emails.

Set `CORS_ORIGINS` only for browser clients, as a comma-separated list of exact HTTPS origins such as `https://thallo.app,https://www.thallo.app`. For native-app-only production deployments, leave it unset; production then allows no browser origins. Never set `CORS_ORIGINS=*` in production.

For production, leave `BETA_FULL_ACCESS_ENABLED=0` and use `SIGNUP_TRIAL_DAYS=7` for the new-user Pro trial. Paid access should come from RevenueCat webhooks or `/billing/revenuecat/sync`; only set `BETA_FULL_ACCESS_ENABLED=1` for an intentional free beta build. The visible RevenueCat signup banner and purchase/restore buttons are guarded by `EXPO_PUBLIC_BILLING_REVENUECAT=1`.

### Networking
- Incoming: Public endpoint.
- Outgoing: **Custom VPC** → **Add new VPC connector**:
  - Name: `thallo-vpc-connector`
  - VPC: same as RDS (check RDS → Connectivity tab to confirm the VPC ID).
  - Subnets: select all available (usually 2–3 across AZs).
  - Security groups: create new `thallo-apprunner-sg`.

### Health check
- Protocol: HTTP
- Path: `/health`
- Interval: 10 s, Timeout: 5 s
- Healthy threshold: 1, Unhealthy: 5

### Auto-scaling
- Use default, OR create a custom config `thallo-small` with Min 1 / Max 2 / Max concurrency 100.

Click **Create & deploy**. First deploy takes ~4–5 min.

## 4. Open RDS to App Runner (one-time)

After App Runner is deployed, the `/health` probe will pass (it doesn't touch the DB) but `/ready` will fail with 503 until the RDS security group allows inbound from App Runner.

1. App Runner → your service → **Configuration** → **Network** → click the VPC connector name → copy its **Security group ID** (starts with `sg-`).
2. EC2 → Security Groups → find `thallo-rds-sg` → **Inbound rules** → **Edit inbound rules** → **Add rule**:
   - Type: **PostgreSQL** (auto-fills port 5432).
   - Source: **Custom** → paste the App Runner SG ID from step 1.
   - Description: `App Runner to RDS`.
3. Save.

Within 30–60 s `/ready` flips to 200.

## 5. Smoke test the backend

```bash
API=https://<your-app-runner-url>

curl -s $API/health    # {"status":"ok","version":"0.1.0"}
curl -s $API/ready     # {"ready":true}

# Full integration suite (requires Docker backend running locally as runner):
SMOKE_BASE_URL=$API docker exec thallo-backend python -m tests.test_api_smoke
# Expect 17 ✓s
```

## 6. Backend updates (every future deploy)

Code change → commit → push. Then:
```bash
cd /Users/sawyerhannel/Documents/GitHub/Makros/backend
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com
docker build --platform linux/amd64 -t thallo-backend .
docker tag thallo-backend:latest $ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/thallo-backend:latest
docker push $ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/thallo-backend:latest
```

App Runner auto-redeploys within ~60 s. Watch progress on the service's Activity tab.

---

# iOS deploy

Target: a build in TestFlight installable by invited testers.

## 7. Apple Developer one-time setup

### Apple Developer Program membership
- developer.apple.com/account → confirm your $99/year membership is **active**. If you see "Enroll", enroll and wait for Apple's approval (usually same-day).

### Register the App ID (if not already)
1. developer.apple.com → **Certificates, Identifiers & Profiles** → **Identifiers** → `+`.
2. App IDs → App → Continue.
3. Description: `Thallo`. Bundle ID: **Explicit** → `com.thallo.app`.
4. Capabilities: check **HealthKit** (app reads Apple Health). Leave others off unless you add features.
5. Continue → Register.

### Create the App Store Connect app record
1. appstoreconnect.apple.com → My Apps → `+` → **New App**.
2. Platform: iOS. Name: **Thallo** (must be unique in the App Store). Language: English. Bundle ID: pick `com.thallo.app` from dropdown (refresh the page if it's not there after the App ID registration above).
3. SKU: `thallo-001`. User Access: Full.
4. Create.

You can leave metadata/screenshots blank — TestFlight doesn't need them.

## 8. Wire the client to the backend

Edit `app.json` → `expo.extra.apiBaseUrl` → paste your App Runner URL:
```json
"extra": {
  "apiBaseUrl": "https://q4q8mjjhmp.us-east-1.awsapprunner.com",
  "freeBetaFullAccess": false,
  "featureFlags": { "billing": { "revenueCat": false } }
}
```
`freeBetaFullAccess` only opens client-side UI gates and should stay false for production billing. RevenueCat API keys are injected by `app.config.js` from `EXPO_PUBLIC_REVENUECAT_IOS_API_KEY`, `EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY`, and `EXPO_PUBLIC_REVENUECAT_PRO_ENTITLEMENT_ID`; set `EXPO_PUBLIC_BILLING_REVENUECAT=1` only for the paid-subscription beta build.
Commit and push.

For Google sign-in, add the OAuth client IDs to the EAS build environment before building. These IDs are public identifiers, not secrets, and `app.config.js` exposes them to the app through Expo `extra`.

Required for iOS:
```bash
eas env:create --environment production --name GOOGLE_IOS_CLIENT_ID --value "<ios-client-id>.apps.googleusercontent.com" --visibility plaintext
eas env:create --environment production --name GOOGLE_WEB_CLIENT_ID --value "<web-client-id>.apps.googleusercontent.com" --visibility plaintext
```

Required for Android later:
```bash
eas env:create --environment production --name GOOGLE_ANDROID_CLIENT_ID --value "<android-client-id>.apps.googleusercontent.com" --visibility plaintext
```

For local builds, export the same variables in your shell or put the `EXPO_PUBLIC_GOOGLE_*` equivalents in a root `.env` file.

## 9. First iOS build (EAS)

```bash
cd /Users/sawyerhannel/Documents/GitHub/Makros
eas build --platform ios --profile production
```

First run prompts:
- "No eas.json found, initialize?" → **Yes** (creates `eas.json`).
- "Create EAS project?" → **Yes**.
- "iOS app only uses standard/exempt encryption?" → **Yes** (HTTPS, bcrypt, JWT are all standard; saves a week of export-compliance paperwork).
- "How to validate Apple account?" → **device / SMS** or **device / email** — use your registered Apple ID.
- Enter the 6-digit 2FA code when prompted.
- Apple team → pick yours.
- "Generate new Apple Distribution Certificate?" → **Yes**.
- "Generate new Apple Provisioning Profile?" → **Yes**.
- "Create Push Notifications Key?" → **Yes** (required by expo-notifications).

Build uploads to Expo's build farm. ~15–25 min on the free tier. Watch at the URL it prints (`https://expo.dev/accounts/<you>/projects/thallo/builds/<id>`).

> **Gotcha — entitlement mismatch:** if `app.json → ios.entitlements` declares a capability the App ID doesn't have, the Xcode build step fails with:
> ```
> Provisioning profile "..." doesn't match the entitlements file's value for the com.apple.developer.X entitlement
> ```
> Fix: remove the entitlement from `app.json` OR add the matching capability on the App ID (developer.apple.com → Identifiers → your App ID → edit capabilities). We hit this with `com.apple.developer.healthkit.background-delivery` — not used by the app, so it was removed from `app.json`.

## 10. Submit to TestFlight

```bash
eas submit --platform ios --latest
```

First-time prompts:
- "Submission method?" → **App Store Connect API Key** (recommended — saves you from re-entering Apple credentials every submit).
- Follow EAS's link to App Store Connect → Users and Access → Integrations → **App Store Connect API** → generate a key with role **App Manager**. Download the `.p8` file. Paste the path + Issuer ID + Key ID back into EAS.
- Confirm app, bundle ID → submits.

Takes ~5 min to upload. Then Apple processes for another 5–15 min. Status in App Store Connect → TestFlight tab walks through: **Processing** → **Ready to Test** (or **Missing Compliance** — if so, click the build and answer "Does your app use encryption?" Yes/exempt to resolve).

## 11. Invite testers

1. App Store Connect → your app → **TestFlight** tab.
2. Left sidebar → **Internal Testing** → `+` → name the group `Pilot`.
3. Add testers by email (up to 100 internal testers — must be App Store Connect users on your team).
4. Click into the new build → toggle it on for the `Pilot` group.
5. Testers get an email → install the free **TestFlight** app from the App Store → redeem invite → Thallo installs.

**External testing** (up to 10,000, includes non-team members via email or a public link) requires a one-time Apple Beta App Review per major version — 1–2 day turnaround. Use Internal for the pilot.

## 12. iOS updates (every future release)

Code change → bump `expo.version` in `app.json` → commit + push. Then:
```bash
eas build --platform ios --profile production
eas submit --platform ios --latest
```

Skips all first-time prompts (credentials, API key, etc are cached). Testers get the new build automatically in TestFlight within an hour.

---

# Common gotchas (quick-reference)

| Symptom | Root cause | Fix |
|---|---|---|
| App Runner deploys pull image fine but container exits with code 255 instantly, no app logs | arm64 image on amd64 runtime | Rebuild with `docker build --platform linux/amd64 ...` |
| App Runner health check targets port 8080 | Left the default Port field | Service config → Port → change to **8000** |
| `/ready` returns 503 but `/health` is 200 | RDS security group blocks App Runner | Add inbound rule on RDS SG → PostgreSQL from App Runner VPC connector SG |
| Container starts but crashes with `database … does not exist` | DB name mismatch in `DATABASE_URL` vs actual RDS initial DB name | Fix either side — RDS Configuration tab shows the real name |
| `zsh: command not found: aws` | AWS CLI not installed | `brew install awscli` |
| `docker: invalid reference format` when running compound command | zsh mangled the line-continuation backslashes on paste | Put the whole `docker run` on one line |
| App Runner deploy fails with arch mismatch warning | Locally pushed an arm64 image | Add `--platform linux/amd64` to the `docker build` step |
| EAS iOS build fails with "Provisioning profile doesn't match entitlements" | Declared entitlement in `app.json` with no matching App ID capability | Remove from `app.json` OR enable capability on App ID |
| Build succeeds but app can't reach backend | `app.json → extra.apiBaseUrl` is blank or wrong | Set it, rebuild (`eas build`), resubmit |
| TestFlight build stuck on "Missing Compliance" | Export-compliance question unanswered | Click the build → answer "Uses standard encryption" |

---

# Region + cost notes

- **All AWS resources must be in us-east-1** (or whichever single region you pick). Cross-region VPC plumbing is more trouble than it's worth for pilot scale.
- Latency from California → us-east-1 adds ~140 ms round-trip — not noticeable for this app since AI calls dominate.
- Current monthly cost (rough):
  - App Runner 0.25 vCPU / 0.5 GB, 1 instance idle: ~$5–15
  - RDS db.t4g.micro single-AZ + 20 GB storage + 7-day backups: ~$15
  - ECR storage for 1–2 image tags: <$0.50
  - Data egress at pilot volume: negligible
  - Total: **~$25–35/month**
- No need for Secrets Manager at this scale — plain env vars on App Runner are encrypted at rest and access-gated by IAM.

---

# What's NOT covered here

- **Custom domain / HTTPS cert.** App Runner's default domain works; when you're ready, see App Runner → Custom domains for the one-click flow.
- **Sentry / error reporting.** Recommended before public launch. `docs/RECOMMENDATIONS.md` has the item tracked.
- **CI/CD GitHub Actions.** Current workflow is manual `docker push` + `eas build`. Automate before the team grows past one dev.
- **Public App Store release.** Needs screenshots, app description, hosted privacy policy and terms URLs from `docs/legal/`, review submission. Not a pilot concern.
- **Alembic migrations.** Backend currently uses SQLModel `create_all` + idempotent `ALTER TYPE`/`ALTER TABLE … IF NOT EXISTS` helpers. Fine for pilot additive changes; revisit before the first breaking schema change.
