/**
 * StaggerList — wraps children in staggered fade+slide animations.
 * Uses the basic Animated API for Expo Go compatibility.
 */
import React from 'react';
import { ViewStyle } from 'react-native';
import FadeInView from './FadeInView';
import { staggerDelay } from '../utils/motion';

interface Props<T> {
  items: T[];
  renderItem: (item: T, index: number) => React.ReactNode;
  keyExtractor?: (item: T, index: number) => string;
  style?: ViewStyle;
  staggerMs?: number;
}

export default function StaggerList<T>({
  items,
  renderItem,
  keyExtractor,
  style,
  staggerMs = 50,
}: Props<T>) {
  return (
    <>
      {items.map((item, i) => (
        <FadeInView
          key={keyExtractor ? keyExtractor(item, i) : String(i)}
          delay={staggerDelay(i, staggerMs)}
          style={style}>
          {renderItem(item, i)}
        </FadeInView>
      ))}
    </>
  );
}
