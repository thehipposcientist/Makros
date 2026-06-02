/**
 * HorizontalSwipePager — finger-drag pager built on reanimated +
 * gesture-handler. Renders all pages side-by-side in a row; the user
 * drags horizontally and the row translates with their finger. On
 * release the pager snaps to the nearest page (with a velocity bias)
 * and fires `onIndexChange`.
 *
 * No native dep — works in Expo Go.
 *
 * Design notes:
 *  - All pages are mounted simultaneously. Callers should keep this
 *    in mind: heavy tabs incur a render cost even when off-screen.
 *    For the workout/meals sub-tabs we accept this trade for the
 *    "peek next tab" feel.
 *  - Pan gesture uses activeOffsetX([-12, 12]) so a clear horizontal
 *    intent is required before the pager claims the touch — small
 *    enough to feel responsive, large enough not to fight a parent
 *    vertical ScrollView on near-vertical drags.
 *  - failOffsetY ensures the gesture releases on meaningful vertical
 *    motion, so children's vertical scrolls work normally.
 *  - When `index` changes externally (e.g. user taps a tab), we
 *    animate to that page with a spring.
 */
import { ReactNode, useEffect, useMemo, useRef } from 'react';
import { Dimensions, StyleSheet, View } from 'react-native';
import {
  Gesture, GestureDetector,
} from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

const { width: SCREEN_W } = Dimensions.get('window');

interface Props {
  index: number;
  count: number;
  onIndexChange: (next: number) => void;
  children: ReactNode;            // expected: `count` <View> children, one per page
  pageWidth?: number;             // defaults to screen width
  style?: any;
}

const SPRING_CONFIG = { damping: 22, stiffness: 220, mass: 1 };
// Threshold parameters: a swipe commits to the adjacent page if it
// crosses ~25% of page width OR carries enough velocity. Values
// calibrated to feel snappy but not hair-trigger.
const COMMIT_RATIO = 0.25;
const VELOCITY_COMMIT = 600;

export default function HorizontalSwipePager({
  index, count, onIndexChange, children, pageWidth = SCREEN_W, style,
}: Props) {
  const translateX = useSharedValue(-index * pageWidth);
  // Track the index the gesture started on so we can compute target
  // page even when the parent state hasn't updated mid-swipe.
  const startTranslate = useSharedValue(0);
  const indexRef = useRef(index);

  // Sync to external index changes (tab tap).
  useEffect(() => {
    indexRef.current = index;
    cancelAnimation(translateX);
    translateX.value = withTiming(-index * pageWidth, { duration: 240 });
  }, [index, pageWidth, translateX]);

  const handleSettle = (target: number) => {
    if (target !== indexRef.current) {
      indexRef.current = target;
      onIndexChange(target);
    }
  };

  const gesture = useMemo(
    () => Gesture.Pan()
      .activeOffsetX([-12, 12])
      .failOffsetY([-16, 16])
      .onStart(() => {
        'worklet';
        startTranslate.value = translateX.value;
      })
      .onUpdate((e) => {
        'worklet';
        let next = startTranslate.value + e.translationX;
        // Rubber-band at the edges so the user feels the boundary.
        const min = -(count - 1) * pageWidth;
        const max = 0;
        if (next > max) next = max + (next - max) * 0.35;
        if (next < min) next = min + (next - min) * 0.35;
        translateX.value = next;
      })
      .onEnd((e) => {
        'worklet';
        const current = -translateX.value / pageWidth;
        let target = Math.round(current);
        const carry = e.velocityX;
        if (carry <= -VELOCITY_COMMIT) target = Math.ceil(current);
        else if (carry >= VELOCITY_COMMIT) target = Math.floor(current);
        else {
          const remainder = current - Math.floor(current);
          if (remainder > COMMIT_RATIO && remainder < (1 - COMMIT_RATIO)) {
            // Mid-swipe — use velocity sign as tiebreaker.
            target = carry < 0 ? Math.ceil(current) : Math.floor(current);
          }
        }
        target = Math.max(0, Math.min(count - 1, target));
        translateX.value = withSpring(-target * pageWidth, SPRING_CONFIG);
        runOnJS(handleSettle)(target);
      }),
    [count, pageWidth, translateX, startTranslate],
  );

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        collapsable={false}
        style={[
          { flexDirection: 'row', width: pageWidth * count, flex: 1 },
          animatedStyle,
          style,
        ]}>
        {children}
      </Animated.View>
    </GestureDetector>
  );
}

export const HorizontalSwipePagerStyles = StyleSheet.create({
  page: { width: SCREEN_W, flex: 1 },
});
