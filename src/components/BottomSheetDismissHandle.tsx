import { useMemo } from 'react';
import {
  PanResponder,
  Pressable,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type PanResponderCallbacks,
  type PanResponderGestureState,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

interface Props {
  onClose: () => void;
  color: string;
  containerStyle?: StyleProp<ViewStyle>;
  handleStyle?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}

const DISMISS_DISTANCE = 36;
const DISMISS_VELOCITY = 0.65;
const MIN_VERTICAL_DRAG = 6;

interface SwipeDismissOptions {
  enabled?: boolean;
  canStart?: () => boolean;
  capture?: boolean;
  distance?: number;
  velocity?: number;
}

function isDownwardDismissGesture(gesture: PanResponderGestureState): boolean {
  return gesture.dy > MIN_VERTICAL_DRAG && Math.abs(gesture.dy) > Math.abs(gesture.dx) * 1.15;
}

export function useBottomSheetSwipeDismiss(
  onClose: () => void,
  {
    enabled = true,
    canStart,
    capture = false,
    distance = DISMISS_DISTANCE,
    velocity = DISMISS_VELOCITY,
  }: SwipeDismissOptions = {},
) {
  return useMemo(() => {
    const shouldStart = (_evt: GestureResponderEvent, gesture: PanResponderGestureState) => {
      if (!enabled) return false;
      if (canStart && !canStart()) return false;
      return isDownwardDismissGesture(gesture);
    };

    const maybeClose = (_evt: GestureResponderEvent, gesture: PanResponderGestureState) => {
      if (gesture.dy > distance || gesture.vy > velocity) {
        onClose();
      }
    };

    const config: PanResponderCallbacks = {
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: shouldStart,
      onPanResponderRelease: maybeClose,
      onPanResponderTerminationRequest: () => true,
    };

    if (capture) {
      config.onMoveShouldSetPanResponderCapture = shouldStart;
    }

    return PanResponder.create(config).panHandlers;
  }, [canStart, capture, distance, enabled, onClose, velocity]);
}

export default function BottomSheetDismissHandle({
  onClose,
  color,
  containerStyle,
  handleStyle,
  accessibilityLabel = 'Close sheet',
}: Props) {
  const panHandlers = useBottomSheetSwipeDismiss(onClose);

  return (
    <Pressable
      {...panHandlers}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={{ top: 10, bottom: 10, left: 48, right: 48 }}
      onPress={onClose}
      style={({ pressed }) => [styles.container, containerStyle, pressed && styles.pressed]}>
      <View pointerEvents="none" style={[styles.handle, { backgroundColor: color }, handleStyle]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    minHeight: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.72,
  },
  handle: {
    width: 42,
    height: 4,
    borderRadius: 999,
  },
});
