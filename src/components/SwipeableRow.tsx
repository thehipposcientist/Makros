/**
 * Swipeable row with right-side action reveal.
 * Gracefully degrades to plain children if gesture-handler isn't available.
 */
import React, { useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

const ROW_ACTION_WIDTH = 64;
const GRID_ACTION_WIDTH = 52;
const GRID_MAX_COLUMNS = 4;
const GRID_THRESHOLD = 4;

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
  actionLayout?: 'auto' | 'row' | 'grid';
}

let SwipeableComponent: any = null;
try {
  const gh = require('react-native-gesture-handler');
  SwipeableComponent = gh?.Swipeable;
} catch {}

export default function SwipeableRow({ actions, children, enabled = true, actionLayout = 'auto' }: Props) {
  const swipeRef = useRef<any>(null);
  const actionPendingRef = useRef(false);

  if (!enabled || actions.length === 0 || !SwipeableComponent) {
    return <>{children}</>;
  }

  const useGrid = actionLayout === 'grid' || (actionLayout === 'auto' && actions.length > GRID_THRESHOLD);
  const gridColumns = Math.min(GRID_MAX_COLUMNS, Math.ceil(actions.length / 2));
  const gridRows = useGrid
    ? actions.reduce<SwipeAction[][]>((rows, action, i) => {
        if (i % gridColumns === 0) rows.push([]);
        rows[rows.length - 1].push(action);
        return rows;
      }, [])
    : [];

  const runAction = (action: SwipeAction) => {
    if (actionPendingRef.current) return;
    actionPendingRef.current = true;
    swipeRef.current?.close?.();
    setTimeout(() => {
      actionPendingRef.current = false;
      action.onPress();
    }, 80);
  };

  const renderActionContent = (action: SwipeAction, compact = false) => (
    <TouchableOpacity
      style={[styles.actionTouchable, compact && styles.actionTouchableCompact]}
      onPress={() => runAction(action)}
      accessibilityRole="button"
      accessibilityLabel={action.label}>
      <Ionicons name={action.icon as any} size={compact ? 16 : 18} color={action.color} />
      {action.label && (
        <Text
          style={[styles.actionLabel, compact && styles.actionLabelCompact, { color: action.color }]}
          numberOfLines={1}>
          {action.label}
        </Text>
      )}
    </TouchableOpacity>
  );

  const renderRightActions = (_progress: any, dragX: any) => {
    if (useGrid) {
      const gridWidth = gridColumns * GRID_ACTION_WIDTH;
      const translate = dragX.interpolate({
        inputRange: [-gridWidth, 0],
        outputRange: [0, gridWidth],
        extrapolate: 'clamp',
      });

      return (
        <Animated.View style={[styles.actionsGrid, { width: gridWidth, transform: [{ translateX: translate }] }]}>
          {gridRows.map((row, rowIndex) => (
            <View key={`row-${rowIndex}`} style={styles.actionsGridRow}>
              {row.map((action, actionIndex) => (
                <View key={`${rowIndex}-${actionIndex}`} style={[styles.actionGridBtn, { backgroundColor: action.bgColor }]}>
                  {renderActionContent(action, true)}
                </View>
              ))}
            </View>
          ))}
        </Animated.View>
      );
    }

    return (
      <View style={styles.actionsRow}>
        {actions.map((action, i) => {
          const translate = dragX.interpolate({
            inputRange: [-(actions.length * ROW_ACTION_WIDTH), 0],
            outputRange: [0, (actions.length - i) * ROW_ACTION_WIDTH],
            extrapolate: 'clamp',
          });
          return (
            <Animated.View key={i} style={[styles.actionBtn, { backgroundColor: action.bgColor, transform: [{ translateX: translate }] }]}>
              {renderActionContent(action)}
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
    width: ROW_ACTION_WIDTH,
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionsGrid: {
    alignSelf: 'stretch',
    justifyContent: 'center',
  },
  actionsGridRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  actionGridBtn: {
    flex: 1,
    minWidth: GRID_ACTION_WIDTH,
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionTouchable: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
  },
  actionTouchableCompact: {
    paddingHorizontal: 3,
  },
  actionLabel: {
    fontSize: 10,
    fontWeight: '600',
    marginTop: 2,
  },
  actionLabelCompact: {
    fontSize: 9,
    marginTop: 1,
  },
});
