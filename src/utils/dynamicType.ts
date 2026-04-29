import { Text, TextInput } from 'react-native';

export const DYNAMIC_TYPE_MAX = 1.35;
export const DYNAMIC_TYPE_COMPACT_MAX = 1.2;

export const dynamicTextProps = {
  allowFontScaling: true,
  maxFontSizeMultiplier: DYNAMIC_TYPE_MAX,
} as const;

export const dynamicCompactTextProps = {
  allowFontScaling: true,
  maxFontSizeMultiplier: DYNAMIC_TYPE_COMPACT_MAX,
} as const;

export const dynamicInputProps = {
  allowFontScaling: true,
  maxFontSizeMultiplier: DYNAMIC_TYPE_MAX,
} as const;

export function configureDynamicTypeDefaults() {
  const TextAny = Text as any;
  TextAny.defaultProps = {
    ...(TextAny.defaultProps ?? {}),
    ...dynamicTextProps,
  };

  const TextInputAny = TextInput as any;
  TextInputAny.defaultProps = {
    ...(TextInputAny.defaultProps ?? {}),
    ...dynamicInputProps,
  };
}
