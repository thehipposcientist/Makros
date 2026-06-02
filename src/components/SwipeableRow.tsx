/**
 * Swipeable row with right-side action reveal.
 * Gracefully degrades to plain children if gesture-handler isn't available.
 */
import React, { useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export interface SwipeAction {
  icon: string;
  color: string;
  bgColor: string;
  onPress: () => void;
  label?: string;
}

interface Props {
  actions: SwipeAction[];
  children: React.ReactNode;
  enabled?: boolean;
}

let SwipeableComponent: any = null;
try {
  const gh = require('react-native-gesture-handler');
  SwipeableComponent = gh?.Swipeable;
} catch {}

export default function SwipeableRow({ actions, children, enabled = true }: Props) {
  const swipeRef = useRef<any>(null);
  const actionPendingRef = useRef(false);

  if (!enabled || actions.length === 0 || !SwipeableComponent) {
    return <>{children}</>;
  }

  const renderRightActions = (_progress: any, dragX: any) => {
    return (
      <View style={styles.actionsRow}>
        {actions.map((action, i) => {
          const translate = dragX.interpolate({
            inputRange: [-(actions.length * 64), 0],
            outputRange: [0, (actions.length - i) * 64],
            extrapolate: 'clamp',
          });
          return (
            <Animated.View key={i} style={[styles.actionBtn, { backgroundColor: action.bgColor, transform: [{ translateX: translate }] }]}>
              <TouchableOpacity
                style={styles.actionTouchable}
                onPress={() => {
                  if (actionPendingRef.current) return;
                  actionPendingRef.current = true;
                  swipeRef.current?.close?.();
                  setTimeout(() => {
                    actionPendingRef.current = false;
                    action.onPress();
                  }, 80);
                }}>
                <Ionicons name={action.icon as any} size={18} color={action.color} />
                {action.label && <Text style={[styles.actionLabel, { color: action.color }]}>{action.label}</Text>}
              </TouchableOpacity>
            </Animated.View>
          );
        })}
      </View>
    );
  };

  return (
    <SwipeableComponent
      ref={swipeRef}
      renderRightActions={renderRightActions}
      rightThreshold={40}
      overshootRight={false}
      friction={2}>
      {children}
    </SwipeableComponent>
  );
}

const styles = StyleSheet.create({
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  actionBtn: {
    width: 64,
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionTouchable: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
  },
  actionLabel: {
    fontSize: 10,
    fontWeight: '600',
    marginTop: 2,
  },
});
