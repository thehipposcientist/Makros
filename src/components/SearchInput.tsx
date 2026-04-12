import { forwardRef } from 'react';
import {
  View,
  TextInput,
  TextInputProps,
  TouchableOpacity,
  Text,
  StyleSheet,
  StyleProp,
  ViewStyle,
} from 'react-native';
import { colors } from '../constants/theme';

/**
 * Drop-in replacement for `TextInput` used as a search field. Overlays a clear
 * (X) button on the right edge whenever `value` is non-empty. All regular
 * TextInput props are forwarded, so callers can keep their existing styling.
 *
 * Usage:
 *   <SearchInput
 *     style={yourTextInputStyle}
 *     value={query}
 *     onChangeText={setQuery}
 *     onClear={() => setExtraStateToo('')}   // optional side-effect
 *     placeholder="Search foods..."
 *   />
 */
type Props = TextInputProps & {
  onClear?: () => void;
  containerStyle?: StyleProp<ViewStyle>;
};

const SearchInput = forwardRef<TextInput, Props>(function SearchInput(
  { onChangeText, onClear, value, containerStyle, style, ...rest },
  ref,
) {
  const showClear = typeof value === 'string' && value.length > 0;
  return (
    <View style={[styles.wrapper, containerStyle]}>
      <TextInput
        ref={ref}
        value={value}
        onChangeText={onChangeText}
        style={[style, showClear ? styles.inputWithClear : null]}
        {...rest}
      />
      {showClear && (
        <TouchableOpacity
          style={styles.clearBtn}
          onPress={() => {
            onChangeText?.('');
            onClear?.();
          }}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityRole="button"
          accessibilityLabel="Clear search">
          <Text style={styles.clearBtnText}>✕</Text>
        </TouchableOpacity>
      )}
    </View>
  );
});

export default SearchInput;

const styles = StyleSheet.create({
  wrapper: {
    position: 'relative',
    // Let the wrapped TextInput size itself via its own `style`.
    flexShrink: 1,
    flexGrow: 0,
    alignSelf: 'stretch',
  },
  inputWithClear: {
    // Reserve room for the clear button so text doesn't collide with it.
    paddingRight: 36,
  },
  clearBtn: {
    position: 'absolute',
    right: 8,
    top: 0,
    bottom: 0,
    width: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clearBtnText: {
    fontSize: 14,
    color: colors.textMuted,
    fontWeight: '700',
  },
});
