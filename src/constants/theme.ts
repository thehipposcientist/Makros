export type AppThemeName = 'midnight' | 'cocoa' | 'neon' | 'forest' | 'slate' | 'sunrise' | 'arctic' | 'rose' | 'wine' | 'ocean' | 'ember' | 'amethyst' | 'copper';

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

  // ── New themes ────────────────────────────────────────────────────────────────
  wine: {
    name: 'wine',
    label: 'Burgundy Wine',
    description: 'Deep crimson darkness with gold highlights and dusty rose meals.',
    colors: {
      background: '#160A0E',
      surface: '#200D12',
      surfaceRaised: '#2E1219',
      border: '#4A1E28',
      primary: '#C0394E',
      primaryDark: '#8C2035',
      primaryLight: '#E8849A',
      accent: '#D4A843',
      textPrimary: '#F5EEF0',
      textSecondary: '#C4A0A8',
      textMuted: '#8A6068',
      error: '#FF4455',
      warning: '#D4A020',
      success: '#4AB870',
    },
    sections: {
      workout: { soft: '#3A1020', strong: '#C0394E', text: '#E8849A' },
      meals:   { soft: '#2E200A', strong: '#D4A843', text: '#F0D08A' },
      planner: { soft: '#1A1030', strong: '#9060D0', text: '#C8A8F8' },
      account: { soft: '#0E2018', strong: '#3AAA68', text: '#90DDB0' },
    },
  },
  ocean: {
    name: 'ocean',
    label: 'Deep Ocean',
    description: 'Inky navy depths with electric cyan workouts and coral meal accents.',
    colors: {
      background: '#060E1A',
      surface: '#0C1828',
      surfaceRaised: '#122030',
      border: '#1C3248',
      primary: '#00C8E0',
      primaryDark: '#0098AC',
      primaryLight: '#70E4F0',
      accent: '#FF7060',
      textPrimary: '#E8F4FF',
      textSecondary: '#90B8D8',
      textMuted: '#507090',
      error: '#FF5060',
      warning: '#F0A820',
      success: '#30C870',
    },
    sections: {
      workout: { soft: '#082030', strong: '#00C8E0', text: '#70E4F0' },
      meals:   { soft: '#30100C', strong: '#FF7060', text: '#FFC0B8' },
      planner: { soft: '#101830', strong: '#6080FF', text: '#B0C0FF' },
      account: { soft: '#102818', strong: '#30C870', text: '#90F0B8' },
    },
  },
  ember: {
    name: 'ember',
    label: 'Ember Forge',
    description: 'Scorched charcoal with molten orange workouts and ashen gold meals.',
    colors: {
      background: '#100A06',
      surface: '#1A1008',
      surfaceRaised: '#241608',
      border: '#3C2410',
      primary: '#E86820',
      primaryDark: '#B04010',
      primaryLight: '#F0A870',
      accent: '#F0C840',
      textPrimary: '#F8F0E8',
      textSecondary: '#C8A888',
      textMuted: '#887060',
      error: '#FF4040',
      warning: '#F0C020',
      success: '#50B870',
    },
    sections: {
      workout: { soft: '#301408', strong: '#E86820', text: '#F0A870' },
      meals:   { soft: '#28200A', strong: '#F0C840', text: '#F8E090' },
      planner: { soft: '#100820', strong: '#A060E0', text: '#D0A8F8' },
      account: { soft: '#0A2010', strong: '#40A860', text: '#90D8A8' },
    },
  },
  amethyst: {
    name: 'amethyst',
    label: 'Amethyst Dusk',
    description: 'Velvet-dark purple with lavender glows and teal meal highlights.',
    colors: {
      background: '#0C0818',
      surface: '#140E22',
      surfaceRaised: '#1C1430',
      border: '#302050',
      primary: '#A070E8',
      primaryDark: '#7040B8',
      primaryLight: '#C8A8F8',
      accent: '#40D8C0',
      textPrimary: '#F0EAFF',
      textSecondary: '#B8A8D8',
      textMuted: '#7868A0',
      error: '#FF5060',
      warning: '#E0A030',
      success: '#40C880',
    },
    sections: {
      workout: { soft: '#20103A', strong: '#A070E8', text: '#C8A8F8' },
      meals:   { soft: '#083028', strong: '#40D8C0', text: '#A0F0E0' },
      planner: { soft: '#201028', strong: '#E060A0', text: '#F8A8D0' },
      account: { soft: '#201808', strong: '#D0A030', text: '#F0D080' },
    },
  },
  copper: {
    name: 'copper',
    label: 'Copper & Ash',
    description: 'Warm ash-grey with burnished copper workouts and sage green meals.',
    colors: {
      background: '#111210',
      surface: '#1A1C18',
      surfaceRaised: '#242620',
      border: '#383C30',
      primary: '#C07840',
      primaryDark: '#905828',
      primaryLight: '#E0B080',
      accent: '#70A860',
      textPrimary: '#F4F2EC',
      textSecondary: '#B8B0A0',
      textMuted: '#787060',
      error: '#D05040',
      warning: '#C89030',
      success: '#50A868',
    },
    sections: {
      workout: { soft: '#281808', strong: '#C07840', text: '#E0B080' },
      meals:   { soft: '#102010', strong: '#70A860', text: '#B8D8A8' },
      planner: { soft: '#101828', strong: '#5888C0', text: '#A8C8F0' },
      account: { soft: '#201008', strong: '#B06030', text: '#E0A870' },
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
