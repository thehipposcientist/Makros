export const colors = {
  // Backgrounds
  background:    '#0D0D0D',
  surface:       '#1A1A1A',
  surfaceRaised: '#232323',
  border:        '#2A2A2A',

  // Brand — pulled from logo
  primary:      '#00C9B1',   // teal (MAKROS wordmark)
  primaryDark:  '#009E8E',
  primaryLight: '#33D9C8',
  accent:       '#4ADE80',   // green (M gradient)

  // Text
  textPrimary:   '#FFFFFF',
  textSecondary: '#AAAAAA',
  textMuted:     '#555555',

  // Semantic
  error:   '#FF4757',
  warning: '#FFA94D',
  success: '#4ADE80',
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  full: 999,
} as const;
