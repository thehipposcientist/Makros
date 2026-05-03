import type { InjuryEntry } from '../../types';
import {
  applyInjuryCheckinResponse,
  findDueInjuryCheckins,
  injuryCheckinKey,
  markInjuryCheckinsAnswered,
  markInjuryCheckinsPrompted,
  parseInjuryCheckinState,
} from '../injuryCheckins.ts';

const baseInjury: InjuryEntry = {
  id: 'inj-1',
  bodyPart: 'Knee',
  description: 'Knee pain on squats',
  muscleGroups: ['quads'],
  severity: 'moderate',
  reportedAt: '2026-04-20',
  estimatedRecoveryDays: 7,
  estimatedRecoveryDate: '2026-04-27',
  status: 'active',
};

describe('injury checkins', () => {
  it('prompts when an active injury reaches its estimated recovery date', () => {
    const due = findDueInjuryCheckins([baseInjury], {}, new Date('2026-04-28T10:00:00Z'));
    expect(due.map(inj => inj.id)).toEqual(['inj-1']);
  });

  it('does not prompt again inside the answered interval', () => {
    const answered = markInjuryCheckinsAnswered({}, [baseInjury], new Date('2026-04-28T10:00:00Z'));
    const due = findDueInjuryCheckins([baseInjury], answered, new Date('2026-05-01T10:00:00Z'));
    expect(due).toEqual([]);
  });

  it('snoozes a dismissed prompt without changing injury status', () => {
    const snoozed = markInjuryCheckinsPrompted({}, [baseInjury], new Date('2026-04-28T10:00:00Z'));
    const due = findDueInjuryCheckins([baseInjury], snoozed, new Date('2026-04-29T09:00:00Z'));
    expect(due).toEqual([]);
  });

  it('marks selected injuries recovering when the user says they are improving', () => {
    const next = applyInjuryCheckinResponse([baseInjury], ['inj-1'], 'improving', new Date('2026-04-28T10:00:00Z'));
    expect(next[0].status).toBe('recovering');
    expect(next[0].statusUpdatedAt).toBe('2026-04-28T10:00:00.000Z');
  });

  it('resolves only selected injuries', () => {
    const other = { ...baseInjury, id: 'inj-2', bodyPart: 'Shoulder' };
    const next = applyInjuryCheckinResponse([baseInjury, other], ['inj-2'], 'resolved', new Date('2026-04-28T10:00:00Z'));
    expect(next.map(inj => inj.status)).toEqual(['active', 'resolved']);
  });

  it('ignores resolved injuries and invalid stored state', () => {
    const resolved = { ...baseInjury, status: 'resolved' as const };
    expect(findDueInjuryCheckins([resolved], parseInjuryCheckinState('{bad json'), new Date('2026-04-28T10:00:00Z'))).toEqual([]);
    expect(injuryCheckinKey({ ...baseInjury, id: '' })).toBe('knee|knee pain on squats|2026-04-20');
  });
});
