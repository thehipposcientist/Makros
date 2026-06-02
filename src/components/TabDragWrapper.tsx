/**
 * TabDragWrapper — drag the current tab's content with your finger.
 *
 * Wraps a single tab's content. While the user drags horizontally, the
 * content translates with their finger (rubber-band at the edges of
 * the tab range). On release past a commit threshold (or with enough
 * velocity), animates the content fully off-screen in the direction
 * of the swipe, then fires `onCommit(direction)` so the parent can
 * change tabs. On release below the threshold, springs back to zero.
 *
 * Transition smoothing: when the parent swaps content (resetKey
 * changes) after a swipe commit, the new content is pre-positioned
 * off-screen on the opposite side and slid in. The end-to-end motion
 * reads as a single continuous slide — drag-off + slide-in — rather
 * than the slide-off + abrupt center-replace it used to be. Tab-tap
 * transitions (no swipe direction recorded) instant-snap to center
 * as before.
 *
 * No native dep — pure reanimated + gesture-handler, works in Expo Go.
 */
import { ReactNode, useCallback, useEffect, useMemo, useRef } from 'react';
import { LayoutChangeEvent, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  runOnUI,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

// Commit thresholds. 25% of the measured tab width OR a clear flick velocity.
// Calibrated to feel premium without being hair-trigger.
const COMMIT_RATIO = 0.25;
const COMMIT_VELOCITY = 700;
const MIN_VELOCITY_TRANSLATION = 16;
const SLIDE_OUT_MS = 200;
const SLIDE_IN_MS = 240;
// Easing curves chosen so the two halves of the transition fit
// together: slide-out is an accelerating-out cubic, slide-in is a
// decelerating-out cubic. End-to-end the motion reads as one arc.
const SLIDE_OUT_EASING = Easing.bezier(0.32, 0, 0.67, 0);
const SLIDE_IN_EASING = Easing.out(Easing.cubic);
const SPRING_BACK = { damping: 22, stiffness: 240, mass: 1 };

interface Props {
  /** Whether the user can swipe left (advance to next tab). */
  canGoNext: boolean;
  /** Whether the user can swipe right (go to previous tab). */
  canGoPrev: boolean;
  /** Fires after the slide-out animation completes. Direction matches
   *  the swipe (-1 = previous tab, 1 = next tab). */
  onCommit: (direction: -1 | 1) => void;
  /** When this key changes the wrapper picks up the most recent swipe
   *  direction and slides the new content in from the opposite side.
   *  If no swipe was recorded (e.g. tab-tap), it instant-snaps to 0. */
  resetKey?: string | number;
  children: ReactNode;
}

export default function TabDragWrapper({
  canGoNext, canGoPrev, onCommit, resetKey, children,
}: Props) {
  const gestureEnabled = canGoNext || canGoPrev;
  const { width: windowWidth } = useWindowDimensions();
  const tx = useSharedValue(0);
  const pageWidth = useSharedValue(Math.max(1, windowWidth));
  const commitInFlight = useSharedValue(false);
  // Records the direction of the last *committed* swipe so the
  // resetKey effect knows which side to slide the new content in from.
  // 0 = tab-tap or first mount → instant snap.
  const pendingSlideDir = useSharedValue<-1 | 0 | 1>(0);
  // Mirror canGoNext/canGoPrev into SharedValues so the gesture's
  // worklet reads them via .value and the gesture itself stays
  // mounted across tab changes. Previously these were in useMemo
  // deps, which meant the gesture was destroyed and re-created
  // whenever navigation flags flipped — if it happened mid-touch
  // the in-flight gesture was lost and the user had to lift and
  // re-touch (the "swipe stops working" symptom).
  const canGoNextSv = useSharedValue(canGoNext);
  const canGoPrevSv = useSharedValue(canGoPrev);
  useEffect(() => { canGoNextSv.value = canGoNext; }, [canGoNext, canGoNextSv]);
  useEffect(() => { canGoPrevSv.value = canGoPrev; }, [canGoPrev, canGoPrevSv]);

  const syncPageWidth = useCallback((nextWidth: number) => {
    if (!Number.isFinite(nextWidth) || nextWidth <= 0) return;
    runOnUI((width: number) => {
      'worklet';
      pageWidth.value = width;
      if (!commitInFlight.value && Math.abs(tx.value) > width) {
        tx.value = Math.sign(tx.value) * width;
      }
    })(nextWidth);
  }, [commitInFlight, pageWidth, tx]);

  useEffect(() => {
    syncPageWidth(windowWidth);
  }, [syncPageWidth, windowWidth]);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    syncPageWidth(event.nativeEvent.layout.width);
  }, [syncPageWidth]);

  // Parent swapped content. If the swap follows a swipe commit, slide
  // the new content in from the opposite side. Otherwise (tab-tap),
  // instant-snap. Either way, clear pendingSlideDir for next round.
  //
  // CRITICAL: run all SharedValue writes on the UI thread atomically.
  // Setting `tx.value = width` then `tx.value = withTiming(0)` from
  // the JS thread can drop the first write — the UI thread only sees
  // the latest value, so tx skips the starting position and the slide-
  // in either doesn't happen or animates from the wrong direction.
  // Result was tx stuck at the slide-out edge after a commit → page off-screen,
  // no interaction possible. runOnUI guarantees both writes land in
  // the same UI-thread frame.
  useEffect(() => {
    runOnUI(() => {
      'worklet';
      cancelAnimation(tx);
      commitInFlight.value = false;
      const width = pageWidth.value;
      const dir = pendingSlideDir.value;
      if (dir === 1) {
        // Swiped left → new content enters from the right.
        tx.value = width;
        tx.value = withTiming(0, { duration: SLIDE_IN_MS, easing: SLIDE_IN_EASING });
      } else if (dir === -1) {
        // Swiped right → new content enters from the left.
        tx.value = -width;
        tx.value = withTiming(0, { duration: SLIDE_IN_MS, easing: SLIDE_IN_EASING });
      } else {
        tx.value = 0;
      }
      pendingSlideDir.value = 0;
    })();
  }, [resetKey, tx, pendingSlideDir, pageWidth, commitInFlight]);

  // Keep `onCommit` in a ref so the gesture's onEnd closure always
  // calls the LATEST handler. Without this, when canGoNext/canGoPrev
  // don't change between tabs (e.g., Trends → Body where both stay
  // [true, true]), the gesture useMemo doesn't recreate, and the
  // captured onCommit points to the previous tab's swipeXxxTab which
  // closes over a stale tab index. The next commit then navigates
  // from the wrong starting position and the chain breaks.
  const onCommitRef = useRef(onCommit);
  useEffect(() => { onCommitRef.current = onCommit; }, [onCommit]);
  const handleCommit = useCallback((direction: -1 | 1) => {
    onCommitRef.current(direction);
  }, []);

  const gesture = useMemo(() => {
    return Gesture.Pan()
      .activeOffsetX([-12, 12])
      .failOffsetY([-16, 16])
      .onBegin(() => {
        'worklet';
        cancelAnimation(tx);
        commitInFlight.value = false;
        // Defensive reset: a previous swipe might have been cancelled
        // mid-flight (gesture aborted, view recycled, etc.), leaving
        // pendingSlideDir non-zero with no matching commit. Starting
        // fresh on every touch prevents the leftover from triggering
        // a wrong-direction slide-in on the *next* successful commit.
        pendingSlideDir.value = 0;
      })
      .onUpdate((e) => {
        'worklet';
        let next = e.translationX;
        // Edge resistance: if there's no adjacent tab in that direction,
        // damp the drag heavily so the user feels the boundary.
        if ((next < 0 && !canGoNextSv.value) || (next > 0 && !canGoPrevSv.value)) {
          next = next * 0.3;
        }
        tx.value = next;
      })
      .onEnd((e) => {
        'worklet';
        const width = pageWidth.value;
        const distanceCommit = width * COMMIT_RATIO;
        const dx = e.translationX;
        const vx = e.velocityX;

        const wantsForward =
          dx <= -distanceCommit ||
          (dx <= -MIN_VELOCITY_TRANSLATION && vx <= -COMMIT_VELOCITY);
        const wantsBackward =
          dx >= distanceCommit ||
          (dx >= MIN_VELOCITY_TRANSLATION && vx >= COMMIT_VELOCITY);

        if (wantsForward && canGoNextSv.value) {
          commitInFlight.value = true;
          pendingSlideDir.value = 1;
          tx.value = withTiming(
            -width,
            { duration: SLIDE_OUT_MS, easing: SLIDE_OUT_EASING },
            (finished) => {
              if (finished) {
                runOnJS(handleCommit)(1);
              } else if (commitInFlight.value) {
                commitInFlight.value = false;
                pendingSlideDir.value = 0;
                tx.value = withSpring(0, SPRING_BACK);
              }
            },
          );
        } else if (wantsBackward && canGoPrevSv.value) {
          commitInFlight.value = true;
          pendingSlideDir.value = -1;
          tx.value = withTiming(
            width,
            { duration: SLIDE_OUT_MS, easing: SLIDE_OUT_EASING },
            (finished) => {
              if (finished) {
                runOnJS(handleCommit)(-1);
              } else if (commitInFlight.value) {
                commitInFlight.value = false;
                pendingSlideDir.value = 0;
                tx.value = withSpring(0, SPRING_BACK);
              }
            },
          );
        } else {
          commitInFlight.value = false;
          pendingSlideDir.value = 0;
          tx.value = withSpring(0, SPRING_BACK);
        }
      })
      .onFinalize((_e, success) => {
        'worklet';
        if (!success && !commitInFlight.value) {
          pendingSlideDir.value = 0;
          tx.value = withSpring(0, SPRING_BACK);
        }
      });
    // Empty dep array — all live values are SharedValues with stable
    // refs, so the gesture is built exactly once. This keeps the
    // gesture handler attached for the lifetime of the wrapper.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }],
  }));

  if (!gestureEnabled) {
    return (
      <Animated.View collapsable={false} onLayout={handleLayout} style={[{ flex: 1 }, animatedStyle]}>
        {children}
      </Animated.View>
    );
  }

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View collapsable={false} onLayout={handleLayout} style={[{ flex: 1 }, animatedStyle]}>
        {children}
      </Animated.View>
    </GestureDetector>
  );
}
