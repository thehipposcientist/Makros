import {
  parseTargetRepMax,
  parseTargetRepMin,
  shouldPromptRir,
  shouldPromptUnderperformance,
} from '../setQualityPrompts.ts';

describe('set quality prompts', () => {
  it('parses the low and high ends of rep ranges', () => {
    expect(parseTargetRepMin('8-10')).toBe(8);
    expect(parseTargetRepMax('8-10')).toBe(10);
    expect(parseTargetRepMin('6')).toBe(6);
    expect(parseTargetRepMax('12+')).toBe(12);
  });

  it('asks for RIR when the user reaches the top of the target range', () => {
    expect(shouldPromptRir(9, '8-10')).toBe(false);
    expect(shouldPromptRir(10, '8-10')).toBe(true);
    expect(shouldPromptRir(11, '8-10')).toBe(true);
  });

  it('keeps underperformance prompts tied to large first-set misses', () => {
    expect(shouldPromptUnderperformance(7, '8-10')).toBe(false);
    expect(shouldPromptUnderperformance(6, '8-10')).toBe(true);
  });
});
