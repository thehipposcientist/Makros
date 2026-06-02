#!/usr/bin/env bash
# Fetch product photography for equipment slugs missing PNGs.
#
# Source: Pexels API (free, attribution-required). Each slug maps to a
# search query built from the humanized slug + the word "equipment" so
# we land on product photography rather than incidental shots.
#
# Run:
#   export PEXELS_API_KEY=...   # get one at pexels.com/api
#   ./scripts/sync-equipment-images.sh
#
# Pass `--dry-run` to print the candidate URLs without downloading.
# Pass `--slug=<slug>` to fetch only one slug (handy for spot fixes).
#
# After the script lands a PNG, manually append the mapping to
# `src/utils/equipmentImages.ts` — the EQUIPMENT_IMAGE_ALIASES table.
# The script prints copy-paste ready blocks at the end so you don't
# have to write them by hand.
#
# Attribution note: Pexels' license is free-to-use commercially without
# attribution but they request a credit. We bake an `EQUIPMENT_CREDITS.md`
# file noting the photographer for each downloaded image.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${ROOT}/assets/images/equipment"
CREDITS="${ROOT}/assets/images/equipment/EQUIPMENT_CREDITS.md"

if [ -z "${PEXELS_API_KEY:-}" ]; then
  cat >&2 <<EOM
PEXELS_API_KEY is not set.

  1. Sign up at https://www.pexels.com/api/ (free).
  2. export PEXELS_API_KEY=your-key-here
  3. re-run this script.

EOM
  exit 1
fi

mkdir -p "${DEST}"

# Slugs known to be missing photos in src/utils/equipmentImages.ts.
# Keep this list in sync with the EQUIPMENT_IMAGE_ALIASES table —
# adding a mapping for a slug means it can be removed from here.
SLUGS=(
  agility_ladder
  ankle_strap
  d_handle
  dual_cable_station
  glute_kickback_machine
  high_row_machine
  hip_thrust_machine
  leverage_machines
  machine_row_station
  plyo_box
  rope_attachment
  sandbag
  seated_row_machine
  single_cable_station
  sled
  step_platform
  straight_bar_attachment
  training_cones
  v_bar_attachment
  weighted_vest
)

# Per-slug search query. Defaults to humanized slug + "equipment"; some
# benefit from a more specific phrase so we don't get a treadmill back
# when we asked for a "sled".
declare -A QUERY_OVERRIDES=(
  [agility_ladder]="agility ladder drill"
  [ankle_strap]="cable ankle strap gym"
  [d_handle]="cable d-handle attachment"
  [dual_cable_station]="dual cable crossover machine"
  [glute_kickback_machine]="glute kickback machine"
  [high_row_machine]="high row machine plate loaded"
  [hip_thrust_machine]="hip thrust machine"
  [leverage_machines]="leverage plate loaded machine"
  [machine_row_station]="seated row machine"
  [plyo_box]="plyo box jump"
  [rope_attachment]="cable rope attachment"
  [sandbag]="training sandbag fitness"
  [seated_row_machine]="seated row machine cable"
  [single_cable_station]="single cable column machine"
  [sled]="weight sled push"
  [step_platform]="aerobic step platform"
  [straight_bar_attachment]="cable straight bar attachment"
  [training_cones]="agility cones training"
  [v_bar_attachment]="cable v-bar attachment"
  [weighted_vest]="weighted vest fitness"
)

DRY_RUN=0
ONLY_SLUG=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --slug=*) ONLY_SLUG="${arg#--slug=}" ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

added_block=""
credits_block=""

fetch_one() {
  local slug="$1"
  local out="${DEST}/${slug}.png"
  if [ -s "$out" ]; then
    echo "SKIP $slug (already exists)"
    return 0
  fi
  local query="${QUERY_OVERRIDES[$slug]:-$(echo "$slug" | tr '_' ' ') equipment}"
  # Pexels orientation=square gives the squarest crop available, which
  # plays nicely with our 1:1 thumbnail UI.
  local api="https://api.pexels.com/v1/search?query=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$query")&per_page=3&orientation=square"
  local json
  json="$(curl -sS -H "Authorization: ${PEXELS_API_KEY}" "$api" --max-time 20)"
  local url
  local photographer
  url="$(echo "$json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['photos'][0]['src']['large'] if d.get('photos') else '')")"
  photographer="$(echo "$json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['photos'][0]['photographer'] if d.get('photos') else '')")"
  if [ -z "$url" ]; then
    echo "FAIL  $slug (no results for query: $query)" >&2
    return 1
  fi
  if [ "$DRY_RUN" = "1" ]; then
    echo "DRY   $slug → $url (by $photographer)"
    return 0
  fi
  curl -sS -L "$url" -o "$out" --max-time 30
  if [ ! -s "$out" ]; then
    echo "FAIL  $slug (download empty)" >&2
    rm -f "$out"
    return 1
  fi
  echo "OK    $slug → $url (by $photographer)"
  added_block="${added_block}  {
    keys: ['${slug}', '$(echo "$slug" | tr '_' ' ')'],
    source: require('../../assets/images/equipment/${slug}.png'),
  },
"
  credits_block="${credits_block}- **${slug}** — Photo by ${photographer} on Pexels (${url})
"
}

for slug in "${SLUGS[@]}"; do
  if [ -n "$ONLY_SLUG" ] && [ "$slug" != "$ONLY_SLUG" ]; then continue; fi
  fetch_one "$slug" || true
done

if [ -n "$added_block" ] && [ "$DRY_RUN" = "0" ]; then
  echo ""
  echo "=== Append to src/utils/equipmentImages.ts inside EQUIPMENT_IMAGE_ALIASES: ==="
  echo "$added_block"

  # Append to credits doc (idempotent — caller can dedupe later).
  if [ ! -f "$CREDITS" ]; then
    cat > "$CREDITS" <<EOM
# Equipment image credits

Photos sourced from [Pexels](https://www.pexels.com) — free for commercial
use under the Pexels License. Photographer credits below per the
license's "appreciated" attribution practice.

EOM
  fi
  echo "$credits_block" >> "$CREDITS"
  echo "wrote credits → $CREDITS"
fi
