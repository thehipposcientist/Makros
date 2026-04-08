export type AppThemeName = 'midnight' | 'cocoa' | 'neon' | 'forest' | 'slate' | 'sunrise' | 'arctic' | 'rose';

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
  // ── Dark backgrounds ──────────────────────────────────────────────────────────
  midnight: {
    name: 'midnight',
    label: 'Midnight Pulse',
    description: 'Classic pitch-black with teal workouts and ember meals.',
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
      meals:   { soft: '#35191D', strong: '#FF6B6B', text: '#FFB1B1' },
      planner: { soft: '#231B37', strong: '#A78BFA', text: '#D2C5FF' },
      account: { soft: '#2B2317', strong: '#F59E0B', text: '#F8C978' },
    },
  },
  cocoa: {
    name: 'cocoa',
    label: 'Cocoa Depths',
    description: 'Dark espresso brown with steel blue accents and warm cream text.',
    colors: {
      background: '#170E08',
      surface: '#21140C',
      surfaceRaised: '#2E1C10',
      border: '#4A2E1A',
      primary: '#6BA8E8',
      primaryDark: '#4A7CC4',
      primaryLight: '#A8C8F0',
      accent: '#7CDFC8',
      textPrimary: '#F5E6D0',
      textSecondary: '#C4A882',
      textMuted: '#8A6E52',
      error: '#FF6B6B',
      warning: '#E8A830',
      success: '#5ABF8A',
    },
    sections: {
      workout: { soft: '#1A263A', strong: '#6BA8E8', text: '#A8C8F0' },
      meals:   { soft: '#3A2214', strong: '#D4874A', text: '#F0B580' },
      planner: { soft: '#2A3818', strong: '#8FCC6A', text: '#C4F0A0' },
      account: { soft: '#2E1F0E', strong: '#D4A83A', text: '#F0CC7A' },
    },
  },
  neon: {
    name: 'neon',
    label: 'Neon Noir',
    description: 'Pitch-black purple with hot pink workouts and neon green meals.',
    colors: {
      background: '#0D0818',
      surface: '#130E22',
      surfaceRaised: '#1C1530',
      border: '#2E2445',
      primary: '#F060C0',
      primaryDark: '#C0408A',
      primaryLight: '#F8A0D8',
      accent: '#20F0A0',
      textPrimary: '#F5F0FF',
      textSecondary: '#B8ABCC',
      textMuted: '#78688A',
      error: '#FF4060',
      warning: '#F0C020',
      success: '#20F060',
    },
    sections: {
      workout: { soft: '#2A0C28', strong: '#F060C0', text: '#F8A0D8' },
      meals:   { soft: '#062C1E', strong: '#20F0A0', text: '#90FFD8' },
      planner: { soft: '#0E1A30', strong: '#60A0FF', text: '#A0C8FF' },
      account: { soft: '#22180A', strong: '#F0C020', text: '#F8E060' },
    },
  },
  forest: {
    name: 'forest',
    label: 'Forest Run',
    description: 'Deep woodland green with moss workouts and clay meal accents.',
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
      meals:   { soft: '#37241D', strong: '#D78752', text: '#F1C6A7' },
      planner: { soft: '#1E2B38', strong: '#6CB6FF', text: '#B8D9FF' },
      account: { soft: '#312C1A', strong: '#E1B955', text: '#F5E2A8' },
    },
  },
  // ── Medium background (not pitch black, not light) ────────────────────────────
  slate: {
    name: 'slate',
    label: 'Slate Storm',
    description: 'Cool steel-blue panels — darker than daylight but never pitch black.',
    colors: {
      background: '#1A2535',
      surface: '#243040',
      surfaceRaised: '#2E3C50',
      border: '#3A4C62',
      primary: '#4FB8D0',
      primaryDark: '#2A8CA8',
      primaryLight: '#90D8E8',
      accent: '#F07850',
      textPrimary: '#E8F4FF',
      textSecondary: '#A8C0D8',
      textMuted: '#6A88A8',
      error: '#FF6870',
      warning: '#F0A030',
      success: '#50C880',
    },
    sections: {
      workout: { soft: '#1A3048', strong: '#4FB8D0', text: '#A0D8E8' },
      meals:   { soft: '#3C2010', strong: '#F07850', text: '#F8B098' },
      planner: { soft: '#2A2040', strong: '#9878F8', text: '#C8B8FF' },
      account: { soft: '#182A18', strong: '#50C868', text: '#A0E8A8' },
    },
  },
  // ── Light backgrounds ─────────────────────────────────────────────────────────
  sunrise: {
    name: 'sunrise',
    label: 'Sunrise Bloom',
    description: 'Warm cream background with citrus workouts and rose meal accents.',
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
      meals:   { soft: '#FAD8E2', strong: '#D96C8B', text: '#862C45' },
      planner: { soft: '#E2ECFF', strong: '#6794FF', text: '#294A99' },
      account: { soft: '#F5E8C9', strong: '#B98A22', text: '#6F5211' },
    },
  },
  arctic: {
    name: 'arctic',
    label: 'Arctic Ice',
    description: 'Crisp white-blue surface with cool teal workouts and coral meals.',
    colors: {
      background: '#F0F7FF',
      surface: '#FFFFFF',
      surfaceRaised: '#E4F0FC',
      border: '#C0D8EE',
      primary: '#2878C8',
      primaryDark: '#1A5898',
      primaryLight: '#78B8F0',
      accent: '#20A8A0',
      textPrimary: '#0A1E2E',
      textSecondary: '#304E6A',
      textMuted: '#5A7E9A',
      error: '#CC3344',
      warning: '#C87800',
      success: '#1E8A58',
    },
    sections: {
      workout: { soft: '#D0E8FF', strong: '#2878C8', text: '#0A3468' },
      meals:   { soft: '#CCEFED', strong: '#20A8A0', text: '#0A4845' },
      planner: { soft: '#E4D8FF', strong: '#7040D8', text: '#2A0870' },
      account: { soft: '#FFF8CC', strong: '#C08800', text: '#604400' },
    },
  },
  rose: {
    name: 'rose',
    label: 'Rose Quartz',
    description: 'Soft blush white with mauve workouts and terracotta meal accents.',
    colors: {
      background: '#FFF5F8',
      surface: '#FFFFFF',
      surfaceRaised: '#FFEBF0',
      border: '#F0C8D8',
      primary: '#C44478',
      primaryDark: '#9A2A55',
      primaryLight: '#F0A0C4',
      accent: '#D06030',
      textPrimary: '#2E0A18',
      textSecondary: '#7A3050',
      textMuted: '#B07090',
      error: '#CC2244',
      warning: '#C07800',
      success: '#288A40',
    },
    sections: {
      workout: { soft: '#FFD8E8', strong: '#C44478', text: '#7A0030' },
      meals:   { soft: '#FFE8D8', strong: '#D06030', text: '#7A2800' },
      planner: { soft: '#E8D8FF', strong: '#7840D0', text: '#2A0080' },
      account: { soft: '#D8F0E0', strong: '#389848', text: '#0A4820' },
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
