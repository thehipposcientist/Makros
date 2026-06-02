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
  from?: number;
  animateOnMount?: boolean;
}

export default function AnimatedNumber({
  value,
  style,
  suffix = '',
  prefix = '',
  decimals = 0,
  duration = 280,
  from = 0,
  animateOnMount = false,
}: Props) {
  const initialValue = animateOnMount ? from : value;
  const animVal = useRef(new Animated.Value(initialValue)).current;
  const mountedRef = useRef(false);
  const [display, setDisplay] = useState(
    `${prefix}${decimals > 0 ? initialValue.toFixed(decimals) : Math.round(initialValue)}${suffix}`
  );

  useEffect(() => {
    const listener = animVal.addListener(({ value: v }) => {
      setDisplay(`${prefix}${decimals > 0 ? v.toFixed(decimals) : Math.round(v)}${suffix}`);
    });

    if (!mountedRef.current && animateOnMount) {
      animVal.setValue(from);
      setDisplay(`${prefix}${decimals > 0 ? from.toFixed(decimals) : Math.round(from)}${suffix}`);
    }
    mountedRef.current = true;

    Animated.timing(animVal, {
      toValue: value,
      duration,
      useNativeDriver: false,
    }).start();

    return () => animVal.removeListener(listener);
  }, [value, prefix, suffix, decimals, duration, from, animateOnMount]);

  return <Text style={style}>{display}</Text>;
}
