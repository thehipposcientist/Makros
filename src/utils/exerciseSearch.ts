export interface ExerciseSearchable {
  name?: string | null;
  slug?: string | null;
  description?: string | null;
  primary_muscle?: string | null;
  secondary_muscles?: string[] | null;
  equipment?: string | null;
  aliases?: string[] | null;
  programming_tags?: string[] | null;
  gear?: Array<{ slug?: string | null; name?: string | null; category?: string | null }> | null;
}

function humanizeSearchToken(value?: string | null): string {
  if (!value) return '';
  return value
    .replace(/[_\-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

function normalizeSearchText(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function exerciseSearchHaystack(item: ExerciseSearchable): string {
  const values = [
    item.name,
    item.slug,
    item.description,
    item.primary_muscle,
    humanizeSearchToken(item.primary_muscle ?? ''),
    item.equipment,
    humanizeSearchToken(item.equipment ?? ''),
    ...(item.secondary_muscles ?? []),
    ...(item.secondary_muscles ?? []).map(humanizeSearchToken),
    ...(item.aliases ?? []),
    ...(item.programming_tags ?? []),
    ...(item.programming_tags ?? []).map(humanizeSearchToken),
    ...((item.gear ?? []).flatMap(g => [g.slug, g.name, g.category])),
  ];
  return normalizeSearchText(values.filter(Boolean).join(' '));
}

export function matchesExerciseSearch(item: ExerciseSearchable, query: string): boolean {
  const tokens = normalizeSearchText(query).split(' ').filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = exerciseSearchHaystack(item);
  return tokens.every(token => tokenVariants(token).some(variant => haystack.includes(variant)));
}

function tokenVariants(token: string): string[] {
  const variants = new Set([token]);
  if (token.endsWith('ies') && token.length > 3) variants.add(`${token.slice(0, -3)}y`);
  if (token.endsWith('es') && token.length > 4) variants.add(token.slice(0, -2));
  if (token.endsWith('s') && token.length > 3) variants.add(token.slice(0, -1));
  return [...variants];
}
