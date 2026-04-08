export type AppThemeName = 'midnight' | 'ember' | 'ocean' | 'forest' | 'sunrise' | 'graphite';

export interface ThemeColors {
  background: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  primary: string;
  primaryDark: string;
  primaryLight: string;
  accent: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  error: string;
  warning: string;
  success: string;
}

export interface SectionPalette {
  soft: string;
  strong: string;
  text: string;
}

export interface AppTheme {
  name: AppThemeName;
  label: string;
  description: string;
  colors: ThemeColors;
  sections: {
    workout: SectionPalette;
    meals: SectionPalette;
    planner: SectionPalette;
    account: SectionPalette;
  };
}

export const APP_THEMES: Record<AppThemeName, AppTheme> = {
  midnight: {
    name: 'midnight',
    label: 'Midnight Pulse',
    description: 'Teal workouts, ember meals, dark chrome surfaces.',
    colors: {
      background: '#0D0F14',
      surface: '#161A22',
      surfaceRaised: '#1E2430',
      border: '#2A3242',
      primary: '#15C7B8',
      primaryDark: '#0D9488',
      primaryLight: '#6EE7DC',
      accent: '#7CFCB2',
      textPrimary: '#F5F7FB',
      textSecondary: '#A8B3C7',
      textMuted: '#687388',
      error: '#FF5D73',
      warning: '#FFB454',
      success: '#59D98E',
    },
    sections: {
      workout: { soft: '#122B33', strong: '#15C7B8', text: '#8BEADF' },
      meals: { soft: '#35191D', strong: '#FF6B6B', text: '#FFB1B1' },
      planner: { soft: '#231B37', strong: '#A78BFA', text: '#D2C5FF' },
      account: { soft: '#2B2317', strong: '#F59E0B', text: '#F8C978' },
    },
  },
  ember: {
    name: 'ember',
    label: 'Ember Forge',
    description: 'Warmer panels with copper highlights and bold meal contrast.',
    colors: {
      background: '#15110F',
      surface: '#201916',
      surfaceRaised: '#2B211D',
      border: '#43312B',
      primary: '#F97316',
      primaryDark: '#C2410C',
      primaryLight: '#FDBA74',
      accent: '#FB7185',
      textPrimary: '#FFF7ED',
      textSecondary: '#D6B8A8',
      textMuted: '#8D6E63',
      error: '#FF6B6B',
      warning: '#FBBF24',
      success: '#4ADE80',
    },
    sections: {
      workout: { soft: '#2E2016', strong: '#F97316', text: '#FDBA74' },
      meals: { soft: '#34161F', strong: '#FB7185', text: '#FDA4AF' },
      planner: { soft: '#2D2314', strong: '#EAB308', text: '#FDE68A' },
      account: { soft: '#1D2830', strong: '#38BDF8', text: '#93C5FD' },
    },
  },
  ocean: {
    name: 'ocean',
    label: 'Ocean Slate',
    description: 'Cool blue workout accents with coral meal cards.',
    colors: {
      background: '#0B1220',
      surface: '#131D31',
      surfaceRaised: '#1B2840',
      border: '#2A3A58',
      primary: '#38BDF8',
      primaryDark: '#0284C7',
      primaryLight: '#7DD3FC',
      accent: '#34D399',
      textPrimary: '#EFF6FF',
      textSecondary: '#A9BAD5',
      textMuted: '#6B7C99',
      error: '#FF6B6B',
      warning: '#FBBF24',
      success: '#4ADE80',
    },
    sections: {
      workout: { soft: '#132B45', strong: '#38BDF8', text: '#BAE6FD' },
      meals: { soft: '#3B1D1C', strong: '#F97360', text: '#FDB4AB' },
      planner: { soft: '#1F2447', strong: '#818CF8', text: '#C7D2FE' },
      account: { soft: '#1C2D22', strong: '#34D399', text: '#A7F3D0' },
    },
  },
  forest: {
    name: 'forest',
    label: 'Forest Run',
    description: 'Deep green backgrounds with moss workouts and clay meals.',
    colors: {
      background: '#0E1712',
      surface: '#162219',
      surfaceRaised: '#1D2C21',
      border: '#304337',
      primary: '#4CAF6A',
      primaryDark: '#2E7D4A',
      primaryLight: '#9FD9AE',
      accent: '#D7A86E',
      textPrimary: '#F2F7F1',
      textSecondary: '#B5C6B5',
      textMuted: '#788B78',
      error: '#FF6B6B',
      warning: '#F6C453',
      success: '#57D38C',
    },
    sections: {
      workout: { soft: '#203528', strong: '#4CAF6A', text: '#B8E4C2' },
      meals: { soft: '#37241D', strong: '#D78752', text: '#F1C6A7' },
      planner: { soft: '#1E2B38', strong: '#6CB6FF', text: '#B8D9FF' },
      account: { soft: '#312C1A', strong: '#E1B955', text: '#F5E2A8' },
    },
  },
  sunrise: {
    name: 'sunrise',
    label: 'Sunrise Bloom',
    description: 'Soft dawn backgrounds with citrus workouts and rose meal accents.',
    colors: {
      background: '#FFF5EC',
      surface: '#FFFDF9',
      surfaceRaised: '#FDEDDC',
      border: '#E8CDB5',
      primary: '#F28C28',
      primaryDark: '#D46F0A',
      primaryLight: '#FBC98C',
      accent: '#D96C8B',
      textPrimary: '#402A1E',
      textSecondary: '#75584A',
      textMuted: '#A2806D',
      error: '#D64545',
      warning: '#D99A00',
      success: '#2F9E66',
    },
    sections: {
      workout: { soft: '#FFE5C8', strong: '#F28C28', text: '#8C4C08' },
      meals: { soft: '#FAD8E2', strong: '#D96C8B', text: '#862C45' },
      planner: { soft: '#E2ECFF', strong: '#6794FF', text: '#294A99' },
      account: { soft: '#F5E8C9', strong: '#B98A22', text: '#6F5211' },
    },
  },
  graphite: {
    name: 'graphite',
    label: 'Graphite Volt',
    description: 'Steel surfaces with electric workout blues and acid green accents.',
    colors: {
      background: '#111317',
      surface: '#1A1D23',
      surfaceRaised: '#232731',
      border: '#363C4B',
      primary: '#7C9BFF',
      primaryDark: '#4E6EE0',
      primaryLight: '#B5C5FF',
      accent: '#B9F227',
      textPrimary: '#F3F5F9',
      textSecondary: '#B8C0CF',
      textMuted: '#7D8698',
      error: '#FF6B6B',
      warning: '#FFC857',
      success: '#59D98E',
    },
    sections: {
      workout: { soft: '#1D2742', strong: '#7C9BFF', text: '#D7E1FF' },
      meals: { soft: '#302538', strong: '#F27BB2', text: '#FAC3DB' },
      planner: { soft: '#253126', strong: '#B9F227', text: '#E5FF9A' },
      account: { soft: '#332920', strong: '#F59E0B', text: '#FCD38D' },
    },
  },
};

export const colors = APP_THEMES.midnight.colors;

export function getTheme(themeName?: AppThemeName): AppTheme {
  return APP_THEMES[themeName ?? 'midnight'] ?? APP_THEMES.midnight;
}

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  full: 999,
} as const;
