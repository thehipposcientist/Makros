import { Ionicons } from '@expo/vector-icons';
import { StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';

type IconName = keyof typeof Ionicons.glyphMap;

type WorkoutFocusIconDescriptor = {
  icon: IconName;
  badgeIcon?: IconName;
  badgeText?: string;
};

type WorkoutFocusIconProps = {
  focus?: string | null;
  stimulus?: string | null;
  color: string;
  size?: number;
  muted?: boolean;
  style?: StyleProp<ViewStyle>;
};

const normalize = (value?: string | null) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const includesAny = (value: string, terms: string[]) =>
  terms.some(term => value.includes(term));

export function getWorkoutFocusIconDescriptor(
  focus?: string | null,
  stimulus?: string | null,
): WorkoutFocusIconDescriptor {
  const f = normalize(focus);
  const s = normalize(stimulus);
  const text = `${f} ${s}`;

  if (includesAny(text, ['rest day', 'rest'])) return { icon: 'moon-outline' };
  if (includesAny(text, ['deload'])) return { icon: 'barbell-outline', badgeIcon: 'arrow-down' };
  if (includesAny(text, ['rehab', 'prehab'])) return { icon: 'medical-outline', badgeIcon: 'shield-outline' };
  if (includesAny(text, ['cooldown', 'cool down'])) return { icon: 'snow-outline' };
  if (includesAny(text, ['warmup', 'warm up'])) return { icon: 'flame-outline' };

  if (includesAny(text, ['pilates', 'core', 'abs'])) return { icon: 'body-outline', badgeText: 'C' };
  if (includesAny(text, ['push', 'chest', 'triceps', 'shoulders', 'upper push'])) {
    return { icon: 'barbell-outline', badgeIcon: 'arrow-up' };
  }
  if (includesAny(text, ['pull', 'back', 'biceps', 'forearms', 'neck', 'traps', 'upper pull'])) {
    return { icon: 'barbell-outline', badgeIcon: 'arrow-back' };
  }
  if (includesAny(text, ['legs', 'lower', 'glutes', 'quads', 'hamstrings', 'calves'])) {
    return { icon: 'footsteps-outline' };
  }
  if (includesAny(text, ['upper', 'full body', 'fullbody'])) return { icon: 'body-outline' };

  if (includesAny(text, ['zone 2', 'zone2', 'z2'])) {
    return { icon: 'heart-outline', badgeText: 'Z2' };
  }
  if (includesAny(text, ['hiit', 'sprint'])) {
    return { icon: 'timer-outline', badgeIcon: 'flash' };
  }
  if (includesAny(text, ['interval'])) {
    return { icon: 'timer-outline', badgeIcon: 'repeat' };
  }
  if (includesAny(text, ['cycling', 'bike'])) return { icon: 'bicycle-outline' };
  if (includesAny(text, ['swim'])) return { icon: 'water-outline' };
  if (includesAny(text, ['hiking', 'stairs', 'stair'])) {
    return { icon: 'footsteps-outline', badgeIcon: 'arrow-up' };
  }
  if (includesAny(text, ['running', 'walking', 'run', 'walk'])) return { icon: 'walk-outline' };
  if (includesAny(text, ['rowing', 'row '])) {
    return { icon: 'barbell-outline', badgeIcon: 'arrow-back' };
  }
  if (includesAny(text, ['cardio', 'conditioning', 'endurance', 'tempo'])) {
    return { icon: 'heart-outline', badgeIcon: includesAny(text, ['tempo']) ? 'speedometer-outline' : 'pulse-outline' };
  }

  if (includesAny(text, ['mobility'])) return { icon: 'sync-outline' };
  if (includesAny(text, ['stretch'])) return { icon: 'expand-outline' };
  if (includesAny(text, ['yoga', 'recovery', 'active recovery'])) {
    return { icon: 'leaf-outline', badgeIcon: includesAny(text, ['active recovery']) ? 'pulse-outline' : undefined };
  }

  if (includesAny(text, ['power', 'athletic', 'explosive'])) return { icon: 'flash-outline' };
  if (includesAny(text, ['strength', 'heavy'])) return { icon: 'barbell-outline', badgeIcon: 'shield-outline' };
  if (includesAny(text, ['hypertrophy', 'volume', 'growth'])) return { icon: 'barbell-outline', badgeIcon: 'add' };
  if (includesAny(text, ['circuit'])) return { icon: 'repeat' };

  return { icon: 'pulse-outline' };
}

export default function WorkoutFocusIcon({
  focus,
  stimulus,
  color,
  size = 48,
  muted = false,
  style,
}: WorkoutFocusIconProps) {
  const descriptor = getWorkoutFocusIconDescriptor(focus, stimulus);
  const badgeSize = Math.max(18, Math.round(size * 0.36));
  const iconSize = Math.round(size * 0.5);
  const badgeIconSize = Math.round(badgeSize * 0.6);
  const resolvedColor = muted ? color + 'AA' : color;

  return (
    <View
      accessible={false}
      importantForAccessibility="no"
      style={[
        styles.wrap,
        {
          width: size,
          height: size,
          borderRadius: Math.round(size * 0.34),
          backgroundColor: color + (muted ? '10' : '1C'),
          borderColor: color + (muted ? '22' : '3A'),
          opacity: muted ? 0.82 : 1,
        },
        style,
      ]}
    >
      <Ionicons name={descriptor.icon} size={iconSize} color={resolvedColor} />
      {(descriptor.badgeIcon || descriptor.badgeText) && (
        <View
          style={[
            styles.badge,
            {
              width: badgeSize,
              height: badgeSize,
              borderRadius: Math.round(badgeSize / 2),
              backgroundColor: color,
            },
          ]}
        >
          {descriptor.badgeIcon ? (
            <Ionicons name={descriptor.badgeIcon} size={badgeIconSize} color="#FFFFFF" />
          ) : (
            <Text style={[styles.badgeText, { fontSize: Math.max(8, Math.round(badgeSize * 0.42)) }]}>
              {descriptor.badgeText}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    position: 'relative',
    flexShrink: 0,
  },
  badge: {
    position: 'absolute',
    right: -3,
    bottom: -3,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#FFFFFF',
  },
  badgeText: {
    color: '#FFFFFF',
    fontWeight: '900',
    letterSpacing: 0,
  },
});
