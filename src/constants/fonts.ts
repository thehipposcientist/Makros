export const fontFamilies = {
  brandSemiBold: 'ThalloDisplay-SemiBold',
  brandBold: 'ThalloDisplay-Bold',
  brandExtraBold: 'ThalloDisplay-ExtraBold',
} as const;

export const fontAssets = {
  [fontFamilies.brandSemiBold]: require('../../assets/fonts/Sora-SemiBold.ttf'),
  [fontFamilies.brandBold]: require('../../assets/fonts/Sora-Bold.ttf'),
  [fontFamilies.brandExtraBold]: require('../../assets/fonts/Sora-ExtraBold.ttf'),
} as const;
