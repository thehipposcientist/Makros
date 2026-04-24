// Scroll-wheel birthday picker — three snapping columns (Month / Day /
// Year). Inline, zero native dependencies, matches iOS wheel feel:
//  • fixed-height rows, centre row selected
//  • snapToInterval + decelerationRate="fast" gives the paddle-to-stop
//    feel users expect from a native wheel picker
//  • centre row gets a pair of faint top/bottom guide lines so it's
//    obvious where the selection lives
//  • every snap fires a light haptic so the wheel feels mechanical
//
// Value is surfaced via onChange as an ISO YYYY-MM-DD string, or null
// when the three columns haven't yet converged on a real calendar date
// (eg Feb 30 — assembleIso catches this and returns null).

import { useEffect, useRef, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet,
  NativeSyntheticEvent, NativeScrollEvent,
} from 'react-native';
import { getTheme } from '../constants/theme';
import { AppThemeName } from '../types';

interface Props {
  /** ISO YYYY-MM-DD or null/undefined when unset. */
  value?: string | null;
  onChange: (iso: string | null) => void;
  themeName?: AppThemeName;
  label?: string;
  hint?: string;
  /** Earliest year to show — defaults to 120 years back, matches the
   *  backend's validation range. */
  minYear?: number;
  /** Latest year to show — defaults to this year minus 13 so the wheel
   *  can't land on an underage birthday. Users who need to change to a
   *  younger age can still edit server-side. */
  maxYear?: number;
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
const ROW_HEIGHT = 38;
const VISIBLE_ROWS = 5; // 2 above + selected + 2 below
const PICKER_HEIGHT = ROW_HEIGHT * VISIBLE_ROWS;

function splitIso(iso: string | null | undefined): { m: number; d: number; y: number } | null {
  if (!iso) return null;
  const parts = iso.split('-');
  if (parts.length !== 3) return null;
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!y || !m || !d) return null;
  return { y, m, d };
}

function daysInMonth(year: number, month1: number): number {
  // month1 is 1-12. new Date(year, month, 0) = last day of month (month
  // here is 1-indexed because we pass month1 without subtracting).
  return new Date(year, month1, 0).getDate();
}

function assembleIso(y: number, m: number, d: number): string | null {
  if (!y || !m || !d) return null;
  const maxD = daysInMonth(y, m);
  if (d > maxD) return null;
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

interface WheelProps {
  items: string[];
  selectedIndex: number;
  onIndexChange: (i: number) => void;
  width: number;
  colors: ReturnType<typeof getTheme>['colors'];
}

function Wheel({ items, selectedIndex, onIndexChange, width, colors }: WheelProps) {
  const scrollRef = useRef<ScrollView>(null);
  const lastIndex = useRef(selectedIndex);

  // Keep scroll position in sync with the controlled selectedIndex.
  useEffect(() => {
    if (lastIndex.current === selectedIndex) return;
    lastIndex.current = selectedIndex;
    scrollRef.current?.scrollTo({ y: selectedIndex * ROW_HEIGHT, animated: true });
  }, [selectedIndex]);

  const onMomentumEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    const i = Math.round(y / ROW_HEIGHT);
    const clamped = Math.max(0, Math.min(items.length - 1, i));
    if (clamped !== selectedIndex) {
      // Light haptic on wheel-settle so the picker feels mechanical.
      import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {});
      lastIndex.current = clamped;
      onIndexChange(clamped);
    }
  };

  // Pad above + below so the first/last entry can still sit in the
  // centre row. Without padding, the wheel couldn't reach index 0 or
  // items.length - 1.
  const padRows = Math.floor(VISIBLE_ROWS / 2);
  const pad = (
    <View style={{ height: ROW_HEIGHT * padRows }} />
  );

  return (
    <View style={{ width, height: PICKER_HEIGHT, overflow: 'hidden' }}>
      <ScrollView
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        snapToInterval={ROW_HEIGHT}
        decelerationRate="fast"
        onMomentumScrollEnd={onMomentumEnd}
        contentOffset={{ x: 0, y: selectedIndex * ROW_HEIGHT }}
      >
        {pad}
        {items.map((item, i) => {
          const isSelected = i === selectedIndex;
          const distance = Math.abs(i - selectedIndex);
          // Fade unselected rows so the centre row reads as "the pick".
          const opacity = isSelected ? 1 : Math.max(0.22, 0.55 - distance * 0.14);
          return (
            <View key={i} style={{ height: ROW_HEIGHT, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{
                fontSize: isSelected ? 20 : 17,
                fontWeight: isSelected ? '800' : '600',
                color: isSelected ? colors.textPrimary : colors.textSecondary,
                opacity,
              }}>
                {item}
              </Text>
            </View>
          );
        })}
        {pad}
      </ScrollView>
      {/* Centre-row guide lines — drawn OVER the scroll content so the
          selected row always has a visual frame. pointerEvents=none so
          taps still hit the ScrollView underneath. */}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute', left: 0, right: 0,
          top: ROW_HEIGHT * Math.floor(VISIBLE_ROWS / 2),
          height: ROW_HEIGHT,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
        }}
      />
    </View>
  );
}

export default function BirthdateInput({ value, onChange, themeName, label = 'Birthday', hint, minYear, maxYear }: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;

  const thisYear = new Date().getFullYear();
  const yMax = maxYear ?? (thisYear - 13);
  const yMin = minYear ?? (thisYear - 120);
  const years: string[] = [];
  for (let y = yMax; y >= yMin; y--) years.push(String(y));
  const days: string[] = [];
  // Day column rebuilds below based on selected year+month, but we seed
  // with 31 slots to avoid a first-render flash.
  for (let d = 1; d <= 31; d++) days.push(String(d));

  // Seed defaults: mid-scroll position on each column, 1990-06-15 as
  // the "neutral" starting point. The user's stored value overrides.
  const parsed = splitIso(value);
  const [m, setM] = useState<number>(parsed?.m ?? 6);   // 1-12
  const [d, setD] = useState<number>(parsed?.d ?? 15);  // 1-31
  const [y, setY] = useState<number>(parsed?.y ?? 1990);

  // External value change (API hydration) should reflect in wheels.
  useEffect(() => {
    const p = splitIso(value);
    if (!p) return;
    if (p.m !== m) setM(p.m);
    if (p.d !== d) setD(p.d);
    if (p.y !== y) setY(p.y);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // When month/year change, if the current day is beyond the new
  // month's length (Feb 30), clamp it.
  useEffect(() => {
    const max = daysInMonth(y, m);
    if (d > max) setD(max);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [y, m]);

  // Emit whenever columns change.
  useEffect(() => {
    onChange(assembleIso(y, m, d));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [y, m, d]);

  const monthIdx = m - 1;
  const dayMax = daysInMonth(y, m);
  const dayItems = Array.from({ length: dayMax }, (_, i) => String(i + 1));
  const dayIdx = Math.max(0, Math.min(dayMax - 1, d - 1));
  // Year column is displayed newest → oldest so the most common picks
  // (recent decades) sit at the top of the scroll range.
  const yearIdx = Math.max(0, Math.min(years.length - 1, yMax - y));

  return (
    <View>
      {label ? (
        <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textSecondary, marginBottom: 6 }}>
          {label}
        </Text>
      ) : null}
      <View style={{
        flexDirection: 'row',
        backgroundColor: tc.surface,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: tc.border,
        paddingVertical: 4,
      }}>
        <Wheel
          items={MONTHS}
          selectedIndex={monthIdx}
          onIndexChange={(i) => setM(i + 1)}
          width={90}
          colors={tc}
        />
        <Wheel
          items={dayItems}
          selectedIndex={dayIdx}
          onIndexChange={(i) => setD(i + 1)}
          width={70}
          colors={tc}
        />
        <Wheel
          items={years}
          selectedIndex={yearIdx}
          onIndexChange={(i) => setY(yMax - i)}
          width={100}
          colors={tc}
        />
      </View>
      {hint ? (
        <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 6 }}>{hint}</Text>
      ) : null}
    </View>
  );
}
