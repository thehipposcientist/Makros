import type { GearItem } from '../services/api';

export function findMatchingGearForSession(
  gear: GearItem[],
  focusLabel: string,
  exerciseNames: string[],
): GearItem[] {
  const focusLower = focusLabel.toLowerCase();
  const exerciseNamesLower = exerciseNames.map(name => name.toLowerCase());
  return gear.filter(item => {
    const keywords = (item.auto_track_keywords ?? [])
      .map(keyword => keyword.trim().toLowerCase())
      .filter(Boolean);
    if (keywords.length === 0) return false;
    return keywords.some(keyword =>
      focusLower.includes(keyword) ||
      exerciseNamesLower.some(name => name.includes(keyword))
    );
  });
}
