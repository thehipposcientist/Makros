/**
 * AnimatedNumber — counts up/down to a target value with smooth motion.
 * Uses React Native's Animated API for broad compatibility.
 */
import { useEffect, useRef, useState } from 'react';
import { Text, TextStyle, Animated, StyleSheet } from 'react-native';

interface Props {
  value: number;
  style?: TextStyle | TextStyle[] | any;
  suffix?: string;
  prefix?: string;
  decimals?: number;
  duration?: number;
}

export default function AnimatedNumber({
  value,
  style,
  suffix = '',
  prefix = '',
  decimals = 0,
  duration = 280,
}: Props) {
  const animVal = useRef(new Animated.Value(value)).current;
  const [display, setDisplay] = useState(
    `${prefix}${decimals > 0 ? value.toFixed(decimals) : Math.round(value)}${suffix}`
  );

  useEffect(() => {
    const listener = animVal.addListener(({ value: v }) => {
      setDisplay(`${prefix}${decimals > 0 ? v.toFixed(decimals) : Math.round(v)}${suffix}`);
    });

    Animated.timing(animVal, {
      toValue: value,
      duration,
      useNativeDriver: false,
    }).start();

    return () => animVal.removeListener(listener);
  }, [value, prefix, suffix, decimals, duration]);

  return <Text style={style}>{display}</Text>;
}
