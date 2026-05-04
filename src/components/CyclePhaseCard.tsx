// Cycle phase card. Reads menstrual data from Apple Health and shows current
// phase + light training context. Shown only when data is available — opt-in
// via Apple Health, no manual toggle needed.
//
// General context only:
//   - menses:     some people prefer lighter training early in the phase
//   - follicular: energy can feel steadier for some people
//   - ovulation:  some people feel sharp and energetic here
//   - luteal:     sleep, hydration, and pacing can matter more here

import { useEffect, useState } from 'react';
import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import { getCycleStatus, CycleStatus } from '../services/appleHealth';

interface Props {
  themeName?: AppThemeName;
}

const PHASE_INFO: Record<string, { label: string; color: string; icon: any; tip: string }> = {
  menses:     { label: 'Menses',     color: '#EF4444', icon: 'water-outline',    tip: 'Some people prefer a lighter start here. Hydration and iron-rich meals can help.' },
  follicular: { label: 'Follicular', color: '#22C55E', icon: 'leaf-outline',     tip: 'Energy often feels steadier here. Normal training is fine if you feel good.' },
  ovulation:  { label: 'Ovulation',  color: '#EAB308', icon: 'sparkles-outline', tip: 'Some people feel sharp here. A normal or harder session can make sense if it feels good.' },
  luteal:     { label: 'Luteal',     color: '#A78BFA', icon: 'moon-outline',     tip: 'Sleep, hydration, and pacing matter more for many people here.' },
  unknown:    { label: 'Unknown',    color: '#9CA3AF', icon: 'help-circle-outline', tip: 'Log a period in Apple Health to see phase.' },
};

export default function CyclePhaseCard({ themeName }: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;

  const [status, setStatus] = useState<CycleStatus | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    getCycleStatus().then(s => {
      if (!alive) return;
      setStatus(s);
      setLoaded(true);
    });
    return () => { alive = false; };
  }, []);

  if (!loaded || !status || status.phase === 'unknown') return null;

  const info = PHASE_INFO[status.phase];
  const daysUntilNext = status.nextExpectedMenses
    ? Math.max(0, Math.ceil((new Date(status.nextExpectedMenses).getTime() - Date.now()) / 86400000))
    : null;
  const cycleSubtitle = status.dayOfCycle != null
    ? [
        status.phase === 'menses'
          ? `Period day ${status.dayOfCycle}`
          : `Cycle day ${status.dayOfCycle}`,
        `est. ${status.cycleLengthDays}-day cycle`,
        daysUntilNext != null ? `next in ${daysUntilNext}d` : null,
      ].filter(Boolean).join(' · ')
    : null;

  return (
    <View style={{
      backgroundColor: tc.surface, borderRadius: radius.lg, padding: 14, marginBottom: 12,
      borderWidth: 1, borderColor: tc.border,
    }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{
          width: 40, height: 40, borderRadius: 20,
          backgroundColor: info.color + '22',
          alignItems: 'center', justifyContent: 'center',
        }}>
          <Ionicons name={info.icon} size={18} color={info.color} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textMuted, letterSpacing: 0.6 }}>
            CYCLE PHASE
          </Text>
          <Text style={{ fontSize: 16, fontWeight: '800', color: info.color, marginTop: 1 }}>
            {info.label}
          </Text>
          {cycleSubtitle && (
            <Text style={{ fontSize: 11, color: tc.textSecondary, marginTop: 1 }}>
              {cycleSubtitle}
            </Text>
          )}
        </View>
      </View>
      <Text style={{ fontSize: 12, color: tc.textSecondary, lineHeight: 16, marginTop: 8 }}>
        {info.tip}
      </Text>
    </View>
  );
}
