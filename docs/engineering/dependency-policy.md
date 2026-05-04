# Dependency Policy

Last updated: 2026-05-04

## Install Discipline

- Use `npm ci` for reproducible installs.
- Keep `package-lock.json` committed with every dependency change.
- Do not use `latest`, `next`, `*`, Git URLs, or HTTP tarball dependencies in `package.json`.
- Local Expo modules may use `file:modules/...`; new local module names must be added to `scripts/check-dependency-policy.mjs`.
- Expo packages may keep Expo-compatible `~` ranges, but the lockfile is the source of truth for installed versions.

## Checks

```bash
npm run check:deps
npm run audit:prod
```

`check:deps` is offline and should run in CI. `audit:prod` needs registry access and should run before release builds.
