# Equipment images

The Thallo app renders equipment via real product photography, not
emoji or generic icons. There are two layers:

- **Bundled PNGs** (`assets/images/equipment/<slug>.png`) — the primary
  source. Each maps to one or more equipment slugs in
  `src/utils/equipmentImages.ts`'s `EQUIPMENT_IMAGE_ALIASES` table.
- **Ionicons fallback** — when no PNG is mapped for a slug, the
  client renders a neutral `barbell-outline` vector glyph. This is
  the safe fallback; we never render emoji.

## Adding photos for missing equipment

Twenty equipment slugs in the seed currently have no PNG mapping —
they render the generic `barbell-outline` fallback. The
`scripts/sync-equipment-images.sh` script pulls candidate photos from
Pexels (free commercial license).

### One-time setup

```bash
# 1. Get a free Pexels API key — https://www.pexels.com/api/
export PEXELS_API_KEY=your-key-here

# 2. Dry-run to see what each slug would fetch (no downloads)
./scripts/sync-equipment-images.sh --dry-run

# 3. Real run — downloads PNGs into assets/images/equipment/
./scripts/sync-equipment-images.sh
```

### Adding the require() mapping

After the script lands a file, it prints a copy-paste-ready block:

```ts
  {
    keys: ['sled', 'sled'],
    source: require('../../assets/images/equipment/sled.png'),
  },
```

Append it to `src/utils/equipmentImages.ts` inside the
`EQUIPMENT_IMAGE_ALIASES` array. Metro requires literal `require()`
paths (no dynamic), so this step is intentionally manual.

### Spot-fixing one slug

If a single fetched photo isn't right, delete its PNG and re-run with
`--slug=<slug>`:

```bash
rm assets/images/equipment/sled.png
./scripts/sync-equipment-images.sh --slug=sled
```

You can also adjust the search query per slug — edit the
`QUERY_OVERRIDES` map at the top of the script (e.g. tighten "sled" to
"weight push sled gym").

## Attribution

Pexels' license doesn't require attribution but the company appreciates
it. The script appends a credit line per downloaded image to
`assets/images/equipment/EQUIPMENT_CREDITS.md`.

## When NOT to bundle a photo

Some "equipment" entries are conceptual — `bodyweight` is the explicit
absence of equipment, and a stock photo of someone doing a push-up
would be misleading. These intentionally fall through to the
`barbell-outline` Ionicons fallback; leave them out of the
`EQUIPMENT_IMAGE_ALIASES` table and they'll render correctly.

## Why not AI-generate?

Equipment in particular benefits from being a recognisable, real
object — a user opening the equipment picker should see what's
literally in their gym, not a stylised hallucination. Pexels' library
has the equipment we need, and licensing is unambiguous.

For exercise form demos we'd skip AI generation for a different reason:
subtly-wrong joint angles or rep mechanics can lead to injury. See
`scripts/sync-exercise-demos.sh` for the form-demo pipeline.

## Removing emoji from the UI

The codebase used to ship a `category.icon.includes('-') ? <Ionicons /> :
<Text>{emoji}</Text>` ternary in a handful of category headers
(equipment / food / supplements). The emoji branch is gone — every
fallback now renders a vector Ionicons glyph. Slug → glyph defaults:

- Equipment categories → `barbell-outline`
- Food categories → `restaurant-outline`
- Supplement categories → `flask-outline`
- Pace cards → `speedometer-outline`

If you add a new category, set its seed `icon` to an Ionicons name
(any string containing `-`, e.g. `dumbbell-outline`). The ternary will
prefer your icon; the fallback is only for legacy emoji entries.
