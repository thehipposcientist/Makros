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
          <Text style={styles.clearBtnText}>Clear</Text>
        </TouchableOpacity>
      )}
    </View>
  );
});

export default SearchInput;

const styles = StyleSheet.create({
  wrapper: {
    // Fill the parent's width by default so callers don't have to
    // remember to pass `containerStyle={{ flex: 1 }}` everywhere. The
    // containerStyle prop (if any) is merged AFTER, so explicit overrides
    // still win.
    position: 'relative',
    flex: 1,
    alignSelf: 'stretch',
  },
  inputWithClear: {
    // Reserve room for the pill so text doesn't collide with it.
    paddingRight: 72,
  },
  clearBtn: {
    // Full-height pill that matches the search input's height exactly.
    // top/bottom:0 stretches the button to fill the input regardless of
    // the input's concrete height (which varies by screen since we reuse
    // this component with different styles).
    position: 'absolute',
    right: 6,
    top: 4,
    bottom: 4,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clearBtnText: {
    fontSize: 12,
    lineHeight: 14,
    color: colors.textPrimary,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
});
