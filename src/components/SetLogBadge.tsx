// Memoized set-log badge — the checkmark / radio-button button on
// each set row of the active workout. Pulled out and memoized so a
// `setExercises(...)` update on the parent doesn't force EVERY badge
// (across every card, every set) to re-render. With 8 cards × 4-5
// sets each = 30+ badges, the savings on a hot path is real.
//
// React.memo holds when:
//   - exIdx / slot / isLogged primitives are unchanged
//   - badgeScale is an Animated.Value ref (stable per badgeKey)
//   - onLogSet is the stable handleLogSetInline from the parent's
//     useCallback (we pass exIdx + slot through, not a fresh closure)
//
// On a set log: only the badge whose `isLogged` flipped re-renders.
// All other badges (other slots, other exercises) skip via shallow
// compare. The native-side animation on the Animated.View runs
// on the UI thread regardless and is unaffected by this change.

import React from 'react';
import { Animated, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

interface Props {
  exIdx: number;
  slot: number;
  setNumber: number;
  isLogged: boolean;
  badgeScale: Animated.Value;
  onLogSet: (exIdx: number, slot: number, silent: boolean) => unknown;
  badgeStyle: any;
  badgePendingStyle: any;
  badgeTextStyle: any;
  textMutedColor: string;
  backgroundColor: string;
}

function SetLogBadge({
  exIdx,
  slot,
  setNumber,
  isLogged,
  badgeScale,
  onLogSet,
  badgeStyle,
  badgePendingStyle,
  badgeTextStyle,
  textMutedColor,
  backgroundColor,
}: Props) {
  return (
    <TouchableOpacity
      testID={`log-set-${exIdx}-${slot}`}
      style={[badgeStyle, !isLogged && badgePendingStyle]}
      onPress={() => {
        if (!isLogged) onLogSet(exIdx, slot, false);
      }}
      accessibilityRole="button"
      accessibilityLabel={isLogged ? `Set ${setNumber} logged` : `Log set ${setNumber}`}
    >
      <Animated.View style={{ transform: [{ scale: badgeScale }] }}>
        <Text style={[badgeTextStyle, !isLogged && { color: textMutedColor }]}>
          {isLogged
            ? <Ionicons name="checkmark" size={14} color={backgroundColor} />
            : <Ionicons name="radio-button-off" size={14} />}
        </Text>
      </Animated.View>
    </TouchableOpacity>
  );
}

export default React.memo(SetLogBadge);
