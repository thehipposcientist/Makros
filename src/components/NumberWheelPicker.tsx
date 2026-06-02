/**
 * NumberWheelPicker — iOS-style vertical scroll wheel for picking a
 * value from a discrete list. Pure JS (no native dep) — uses a
 * ScrollView with snap-to-interval so the selected row settles in
 * the middle slot after each scroll.
 *
 * Three visible rows by default: one above (muted), the selected
 * value (bold + primary tint, framed by thin dividers), and one
 * below (muted). Tap-and-drag scrolls; release snaps. Works inside
 * a parent ScrollView because the inner ScrollView claims the gesture
 * only while the user is dragging the wheel itself.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type {
  AccessibilityActionEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ViewStyle,
} from 'react-native';

const DEFAULT_ITEM_HEIGHT = 36;
const DEFAULT_VISIBLE = 3;

interface Props<T extends string | number> {
  values: readonly T[];
  value: T;
  onChange: (v: T) => void;
  itemHeight?: number;
  visibleCount?: number;
  width?: number | string;
  label?: string;
  labelColor?: string;
  selectedColor?: string;
  mutedColor?: string;
  dividerColor?: string;
  formatLabel?: (v: T) => string;
  accessibilityLabel?: string;
  testID?: string;
}

export default function NumberWheelPicker<T extends string | number>({
  values, value, onChange,
  itemHeight = DEFAULT_ITEM_HEIGHT,
  visibleCount = DEFAULT_VISIBLE,
  width,
  label,
  labelColor,
  selectedColor = '#fff',
  mutedColor = 'rgba(255,255,255,0.45)',
  dividerColor = 'rgba(255,255,255,0.18)',
  formatLabel,
  accessibilityLabel,
  testID,
}: Props<T>) {
  const ref = useRef<ScrollView | null>(null);
  const isInteractingRef = useRef(false);
  const momentumStartedRef = useRef(false);
  const currentIndexRef = useRef(0);
  const endDragCommitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Number of muted rows above/below the selected slot. visibleCount
  // is the TOTAL visible (incl. selected), so half on each side.
  const padRows = Math.max(1, Math.floor(visibleCount / 2));
  const containerHeight = itemHeight * (padRows * 2 + 1);

  const index = useMemo(() => {
    const i = values.findIndex(v => v === value);
    return i >= 0 ? i : 0;
  }, [values, value]);

  currentIndexRef.current = index;

  const valueLabel = useCallback((v: T) => (
    formatLabel ? formatLabel(v) : String(v)
  ), [formatLabel]);

  const selectedValueLabel = values[index] !== undefined
    ? valueLabel(values[index])
    : '';

  useEffect(() => {
    if (isInteractingRef.current) return;
    ref.current?.scrollTo({ y: index * itemHeight, animated: false });
  }, [index, itemHeight, values.length]);

  useEffect(() => () => {
    if (endDragCommitTimeoutRef.current) clearTimeout(endDragCommitTimeoutRef.current);
  }, []);

  const commitOffset = useCallback((y: number) => {
    if (values.length === 0) return;
    const nextIdx = Math.max(0, Math.min(values.length - 1, Math.round(y / itemHeight)));
    const nextVal = values[nextIdx];

    if (nextIdx !== currentIndexRef.current && nextVal !== undefined) {
      currentIndexRef.current = nextIdx;
      onChange(nextVal);
    }

    ref.current?.scrollTo({ y: nextIdx * itemHeight, animated: true });
  }, [itemHeight, onChange, values]);

  const changeBy = useCallback((delta: number) => {
    if (values.length === 0) return;
    const nextIdx = Math.max(0, Math.min(values.length - 1, index + delta));
    const nextVal = values[nextIdx];
    if (nextVal === undefined) return;
    currentIndexRef.current = nextIdx;
    onChange(nextVal);
    ref.current?.scrollTo({ y: nextIdx * itemHeight, animated: true });
  }, [index, itemHeight, onChange, values]);

  const handleAccessibilityAction = useCallback((event: AccessibilityActionEvent) => {
    switch (event.nativeEvent.actionName) {
      case 'increment':
        changeBy(1);
        break;
      case 'decrement':
        changeBy(-1);
        break;
      default:
        break;
    }
  }, [changeBy]);

  const handleScrollBeginDrag = () => {
    isInteractingRef.current = true;
    momentumStartedRef.current = false;
  };

  const handleScrollEndDrag = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    if (endDragCommitTimeoutRef.current) clearTimeout(endDragCommitTimeoutRef.current);
    endDragCommitTimeoutRef.current = setTimeout(() => {
      if (momentumStartedRef.current) return;
      commitOffset(y);
      isInteractingRef.current = false;
    }, 60);
  };

  const handleMomentumBegin = () => {
    momentumStartedRef.current = true;
    if (endDragCommitTimeoutRef.current) clearTimeout(endDragCommitTimeoutRef.current);
  };

  const handleMomentumEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (endDragCommitTimeoutRef.current) clearTimeout(endDragCommitTimeoutRef.current);
    commitOffset(e.nativeEvent.contentOffset.y);
    momentumStartedRef.current = false;
    isInteractingRef.current = false;
  };

  const containerStyle: ViewStyle = {
    width: (width as ViewStyle['width']) ?? '100%',
    height: containerHeight,
  };

  const selectedBandTop = padRows * itemHeight;
  const selectedBandBottom = selectedBandTop + itemHeight;

  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel ?? (label ? `${label} picker` : 'Value picker')}
      accessibilityHint="Swipe up or down to adjust."
      accessibilityValue={{ text: selectedValueLabel }}
      accessibilityState={{ disabled: values.length < 2 }}
      accessibilityActions={[
        { name: 'increment', label: 'Increase' },
        { name: 'decrement', label: 'Decrease' },
      ]}
      onAccessibilityAction={handleAccessibilityAction}>
      {label ? (
        <Text style={{
          fontSize: 9, fontWeight: '700', letterSpacing: 0,
          marginBottom: 4, textAlign: 'center', color: labelColor ?? mutedColor,
        }}>{label}</Text>
      ) : null}
      <View style={containerStyle}>
        <ScrollView
          ref={ref}
          testID={testID}
          accessible={false}
          showsVerticalScrollIndicator={false}
          snapToInterval={itemHeight}
          decelerationRate="fast"
          contentContainerStyle={{ paddingVertical: padRows * itemHeight }}
          onScrollBeginDrag={handleScrollBeginDrag}
          onScrollEndDrag={handleScrollEndDrag}
          onMomentumScrollBegin={handleMomentumBegin}
          onMomentumScrollEnd={handleMomentumEnd}
          bounces={false}
          alwaysBounceVertical={false}
          overScrollMode="never"
          // Without nestedScrollEnabled the wheel inside a parent
          // ScrollView can get gesture-stolen on Android.
          nestedScrollEnabled
          // Touch-mode = "drag the wheel directly".
          scrollEventThrottle={16}>
          {values.map((v, i) => {
            const selected = i === index;
            return (
              <View
                key={`${String(v)}-${i}`}
                style={{ height: itemHeight, justifyContent: 'center', alignItems: 'center' }}>
                <Text style={{
                  fontSize: selected ? 17 : 14,
                  fontWeight: selected ? '800' : '600',
                  color: selected ? selectedColor : mutedColor,
                }}>
                  {valueLabel(v)}
                </Text>
              </View>
            );
          })}
        </ScrollView>
        {/* Selected-band dividers — pointer-events disabled so they
            don't intercept scrolls. */}
        <View pointerEvents="none" style={{
          position: 'absolute', left: 0, right: 0, top: selectedBandTop,
          height: 1, backgroundColor: dividerColor,
        }} />
        <View pointerEvents="none" style={{
          position: 'absolute', left: 0, right: 0, top: selectedBandBottom,
          height: 1, backgroundColor: dividerColor,
        }} />
      </View>
    </View>
  );
}
