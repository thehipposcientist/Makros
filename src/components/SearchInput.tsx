import { forwardRef } from 'react';
import {
  View,
  TextInput,
  TextInputProps,
  TouchableOpacity,
  StyleSheet,
  StyleProp,
  ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
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
        style={[style, styles.inputTextReset, showClear ? styles.inputWithClear : null]}
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
          <Ionicons name="close-circle" size={20} color={colors.textMuted} />
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
    // Reserve room for the clear icon so text doesn't collide with it.
    paddingRight: 36,
  },
  inputTextReset: {
    letterSpacing: 0,
    fontWeight: '400',
  },
  clearBtn: {
    position: 'absolute',
    right: 10,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
