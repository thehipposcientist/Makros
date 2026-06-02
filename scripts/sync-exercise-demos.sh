#!/usr/bin/env bash
# Re-pulls the bundled free-exercise-db demo frames and regenerates the
# require() map at src/utils/exerciseDemoAssets.ts. Run after editing
# the seed catalog or the demo_resolver overrides.
#
# Strategy:
#   1. Ask the running backend container which demo ids the seed maps to.
#   2. For each id, download 0.jpg and 1.jpg into assets/exercise-demos/.
#   3. Drop ids whose upstream files 404 (some overrides point at non-
#      existent ids — those gracefully render no card on the client).
#   4. Emit a TS file mapping id -> [require(0.jpg), require(1.jpg)].
#
# Metro requires literal string paths inside require(), so the map is
# baked at build time rather than constructed dynamically.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${ROOT}/assets/exercise-demos"
MAP="${ROOT}/src/utils/exerciseDemoAssets.ts"
BASE="https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises"

mkdir -p "${DEST}"

if ! docker ps --format '{{.Names}}' | grep -q '^thallo-backend$'; then
  echo "thallo-backend container is not running — start it first (docker compose up -d)" >&2
  exit 1
fi

ID_FILE="$(mktemp)"
trap 'rm -f "${ID_FILE}"' EXIT

docker exec thallo-backend python -c "
from app.seed_exercises_data import SEED_EXERCISES
from app.services.workout.demo_resolver import resolve_demo_db_id
ids = sorted({resolve_demo_db_id(e['name']) for e in SEED_EXERCISES if resolve_demo_db_id(e['name'])})
print('\n'.join(ids))
" > "${ID_FILE}"

ok=0
fail=0
while IFS= read -r id; do
  [ -z "${id}" ] && continue
  mkdir -p "${DEST}/${id}"
  for f in 0 1; do
    out="${DEST}/${id}/${f}.jpg"
    if [ -s "${out}" ]; then ok=$((ok+1)); continue; fi
    code=$(curl -sS -o "${out}" -w "%{http_code}" "${BASE}/${id}/${f}.jpg" --max-time 15 || echo "ERR")
    if [ "${code}" = "200" ] && [ -s "${out}" ]; then
      ok=$((ok+1))
    else
      rm -f "${out}"
      fail=$((fail+1))
      echo "FAIL ${id}/${f}.jpg http=${code}" >&2
    fi
  done
done < "${ID_FILE}"

# Drop any directory that didn't end up with both frames.
pruned=0
for d in "${DEST}"/*/; do
  d="${d%/}"
  if [ ! -s "${d}/0.jpg" ] || [ ! -s "${d}/1.jpg" ]; then
    rm -rf "${d}"
    pruned=$((pruned+1))
  fi
done

{
  echo "// AUTO-GENERATED — do not edit by hand."
  echo "// Source: assets/exercise-demos/<id>/{0,1}.jpg"
  echo "// Run scripts/sync-exercise-demos.sh to regenerate."
  echo ""
  echo "type Frames = readonly [number, number];"
  echo ""
  echo "export const DEMO_FRAMES: Readonly<Record<string, Frames>> = {"
  (cd "${DEST}" && ls -1 | sort) | while IFS= read -r id; do
    [ -z "${id}" ] && continue
    printf "  '%s': [require('../../assets/exercise-demos/%s/0.jpg'), require('../../assets/exercise-demos/%s/1.jpg')],\n" "${id}" "${id}" "${id}"
  done
  echo "};"
} > "${MAP}"

count=$(grep -c "require(" "${MAP}" || true)
echo "frames downloaded ok=${ok} fail=${fail} pruned=${pruned}"
echo "wrote ${count} entries to ${MAP}"
