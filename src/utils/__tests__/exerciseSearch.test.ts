import { matchesExerciseSearch } from '../exerciseSearch.ts';

const pectoralFly = {
  name: 'Pectoral Fly',
  aliases: ['Machine Chest Fly', 'Pec Deck'],
  primary_muscle: 'chest',
  equipment: 'gym',
};

describe('exercise search aliases', () => {
  it('matches common chest fly naming variants and misspellings', () => {
    expect(matchesExerciseSearch(pectoralFly, 'pectoral flys')).toBe(true);
    expect(matchesExerciseSearch(pectoralFly, 'chest flies')).toBe(true);
    expect(matchesExerciseSearch(pectoralFly, 'pec deck')).toBe(true);
  });

  it('matches iso-lateral machine names with or without hyphens', () => {
    const inclinePress = {
      name: 'Iso-Lateral Incline Press',
      aliases: ['Hammer Strength Incline Press', 'Plate-Loaded Incline Press'],
      primary_muscle: 'chest',
    };
    expect(matchesExerciseSearch(inclinePress, 'iso lateral incline press')).toBe(true);
    expect(matchesExerciseSearch(inclinePress, 'hammer strength incline')).toBe(true);
  });

  it('matches custom exercise programming tags', () => {
    const customPress = {
      name: 'Prime Incline Press',
      primary_muscle: 'chest',
      programming_tags: ['heavy_friendly', 'volume_friendly'],
    };
    expect(matchesExerciseSearch(customPress, 'heavy friendly')).toBe(true);
    expect(matchesExerciseSearch(customPress, 'volume')).toBe(true);
  });
});
