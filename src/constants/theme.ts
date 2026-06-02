import { Platform, TextStyle, ViewStyle } from 'react-native';

export type AppThemeName =
  | 'midnight' | 'ocean'    | 'amethyst'
  | 'ember'    | 'infrared' | 'wine'     | 'obsidian' | 'carbon'
  | 'blossom'  | 'orchid'   | 'void'     | 'dusk'     | 'lavender' | 'aurora' | 'alpine'
  | 'sunrise'  | 'cardinal' | 'parchment'| 'linen'
  // Light green-on-white companion to obsidian (Black Gold) — same
  // minimal-luxury feel on a clean white surface.
  | 'clover'
  | 'butter'   | 'summer'   | 'lilac'    | 'sky'      | 'glacier'
  | 'citrus'   | 'terra'
  | 'slate'    | 'graphite' | 'ash'      | 'cosmos'
  | 'cinder'   | 'smoke'    | 'maroon'
  | 'rose'
  // Minimalist monochrome — no color identity, just grayscale tiers.
  | 'onyx'     | 'paper';

export interface ThemeColors {
  background: string;
  surface: string;
  surfaceRaised: string;
  /** Floating app chrome (bottom nav, future persistent toolbars). */
  chrome?: string;
  chromeMuted?: string;
  chromeBorder?: string;
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
    ai: SectionPalette;
    planner: SectionPalette;
    account: SectionPalette;
  };
}

export const DEFAULT_THEME_NAME: AppThemeName = 'aurora';

// ─────────────────────────────────────────────────────────────────────────────
// Section color philosophy:
//   Each theme's workout / meals / ai section palette reflects that theme's
//   actual color identity — not a shared blue/green/purple across all themes.
//   This makes each theme's swatch strip look visually unique.
// ─────────────────────────────────────────────────────────────────────────────
export const APP_THEMES: Record<AppThemeName, AppTheme> = {

  // ── DARK / COOL ──────────────────────────────────────────────────────────────

  midnight: {
    name: 'midnight',
    label: 'Midnight Pulse',
    description: 'Pitch-black with teal primary — clean, dark, and focused.',
    colors: {
      background:    '#0D0F14',
      surface:       '#161A22',
      surfaceRaised: '#1E2430',
      border:        '#2A3242',
      primary:       '#15C7B8',
      primaryDark:   '#0D9488',
      primaryLight:  '#6EE7DC',
      accent:        '#7CFCB2',
      textPrimary:   '#F5F7FB',
      textSecondary: '#A8B3C7',
      textMuted:     '#828B9C',
      error:         '#FF5D73',
      warning:       '#FFB454',
      success:       '#59D98E',
    },
    sections: {
      workout: { soft: '#0F1F38', strong: '#4A9EE8', text: '#9DC8F8' },
      meals:   { soft: '#0C2018', strong: '#35C46A', text: '#90E0B0' },
      ai:      { soft: '#1A1030', strong: '#8858E0', text: '#C0A0F8' },
      planner: { soft: '#231B37', strong: '#A78BFA', text: '#D2C5FF' },
      account: { soft: '#2B2317', strong: '#F59E0B', text: '#F8C978' },
    },
  },

  ocean: {
    name: 'ocean',
    label: 'Deep Ocean',
    description: 'Inky navy with electric cyan — the entire palette lives underwater.',
    colors: {
      background:    '#040C18',
      surface:       '#081624',
      surfaceRaised: '#0E2030',
      border:        '#183248',
      primary:       '#00CCE8',
      primaryDark:   '#0098B0',
      primaryLight:  '#68E4F4',
      accent:        '#FF6858',
      textPrimary:   '#E4F4FF',
      textSecondary: '#88B4D4',
      textMuted:     '#6C8AA4',
      error:         '#FF5060',
      warning:       '#F0A820',
      success:       '#28C870',
    },
    sections: {
      workout: { soft: '#061830', strong: '#00CCE8', text: '#70E8F8' },
      meals:   { soft: '#042818', strong: '#28C878', text: '#88F0B8' },
      ai:      { soft: '#080A30', strong: '#4050F8', text: '#90A8FF' },
      planner: { soft: '#0A1430', strong: '#5870FF', text: '#A8B8FF' },
      account: { soft: '#162808', strong: '#80CC28', text: '#C8F070' },
    },
  },

  amethyst: {
    name: 'amethyst',
    label: 'Amethyst Galaxy',
    description: 'Velvet-dark violet with vivid grape primary and electric teal contrast.',
    colors: {
      background:    '#09060F',
      surface:       '#12091E',
      surfaceRaised: '#1C1030',
      border:        '#2E1850',
      primary:       '#A654F9',
      primaryDark:   '#7020C8',
      primaryLight:  '#C888FF',
      accent:        '#28E8C0',
      textPrimary:   '#F0E8FF',
      textSecondary: '#B098D8',
      textMuted:     '#837C9E',
      error:         '#FF4868',
      warning:       '#E0A030',
      success:       '#38C888',
    },
    sections: {
      workout: { soft: '#101840', strong: '#4848F0', text: '#A0A8FF' },
      meals:   { soft: '#062C28', strong: '#28E8C0', text: '#88FFE8' },
      ai:      { soft: '#1E0840', strong: '#9838F8', text: '#CC88FF' },
      planner: { soft: '#1E0830', strong: '#D040A0', text: '#F490D8' },
      account: { soft: '#201808', strong: '#D8A028', text: '#F0D070' },
    },
  },

  // ── DARK / WARM ──────────────────────────────────────────────────────────────

  ember: {
    name: 'ember',
    label: 'Ember Forge',
    description: 'Scorched warm-black with flame orange and sun-amber — intense heat energy.',
    colors: {
      background:    '#0C0704',
      surface:       '#180C06',
      surfaceRaised: '#241308',
      border:        '#3C1E08',
      primary:       '#FF6018',
      primaryDark:   '#C04010',
      primaryLight:  '#FFA060',
      accent:        '#FFD020',
      textPrimary:   '#FFF8F0',
      textSecondary: '#D0A888',
      textMuted:     '#987A6B',
      error:         '#FF3030',
      warning:       '#FFD020',
      success:       '#50C060',
    },
    sections: {
      workout: { soft: '#281408', strong: '#FF6018', text: '#FFA870' },
      meals:   { soft: '#281800', strong: '#FFB800', text: '#FFE078' },
      ai:      { soft: '#100820', strong: '#9050E8', text: '#C898F8' },
      planner: { soft: '#201008', strong: '#FFD020', text: '#FFF080' },
      account: { soft: '#180E04', strong: '#E88018', text: '#F8C068' },
    },
  },

  infrared: {
    name: 'infrared',
    label: 'Infrared Night',
    description: 'Near-black charcoal with hot red-orange primary and icy cyan contrast — high-energy without the full flame palette.',
    colors: {
      background:    '#08090B',
      surface:       '#111418',
      surfaceRaised: '#1B2026',
      border:        '#2D3740',
      primary:       '#FF3D2E',
      primaryDark:   '#C51C14',
      primaryLight:  '#FF8A72',
      accent:        '#38D8F0',
      textPrimary:   '#F7F3F0',
      textSecondary: '#B7A9A2',
      textMuted:     '#8F8582',
      error:         '#FF4A5A',
      warning:       '#F2A93B',
      success:       '#45C878',
    },
    sections: {
      workout: { soft: '#2C100C', strong: '#FF3D2E', text: '#FFA090' },
      meals:   { soft: '#0A2022', strong: '#38D8F0', text: '#98EEF8' },
      ai:      { soft: '#18122A', strong: '#8C78F0', text: '#C8BFFF' },
      planner: { soft: '#271A08', strong: '#F2A93B', text: '#F8D590' },
      account: { soft: '#241018', strong: '#FF5C86', text: '#FFB0C8' },
    },
  },

  wine: {
    name: 'wine',
    label: 'Merlot Dark',
    description: 'Blood-red background with crimson primary and dusty gold — brooding and mature.',
    colors: {
      background:    '#100608',
      surface:       '#1C0B10',
      surfaceRaised: '#2A1018',
      border:        '#461828',
      primary:       '#D45770',
      primaryDark:   '#9A1830',
      primaryLight:  '#E87898',
      accent:        '#D0A040',
      textPrimary:   '#F8EEF0',
      textSecondary: '#C898A8',
      textMuted:     '#9A7885',
      error:         '#FF3848',
      warning:       '#D4A020',
      success:       '#3AB870',
    },
    sections: {
      workout: { soft: '#280C14', strong: '#C82848', text: '#F098B0' },
      meals:   { soft: '#0C2010', strong: '#38AA70', text: '#88DDB0' },
      ai:      { soft: '#1A0830', strong: '#8848D8', text: '#C898FF' },
      planner: { soft: '#200A08', strong: '#D0A040', text: '#F0CC78' },
      account: { soft: '#1A1006', strong: '#C89830', text: '#F0D068' },
    },
  },

  obsidian: {
    name: 'obsidian',
    label: 'Black Gold',
    description: 'Ultra-black background with antique gold as the only accent — minimal and powerful.',
    colors: {
      background:    '#060708',
      surface:       '#0E1012',
      surfaceRaised: '#161820',
      border:        '#24282E',
      primary:       '#C09428',
      primaryDark:   '#906C10',
      primaryLight:  '#E0C060',
      accent:        '#7898C8',
      textPrimary:   '#F0EAD8',
      textSecondary: '#B0A888',
      textMuted:     '#88826E',
      error:         '#D45858',
      warning:       '#C09020',
      success:       '#3EA858',
    },
    sections: {
      workout: { soft: '#1A1408', strong: '#C09428', text: '#E8CC70' },
      meals:   { soft: '#081E10', strong: '#3AA860', text: '#88D8A8' },
      ai:      { soft: '#0C1428', strong: '#4878C8', text: '#98B8EE' },
      planner: { soft: '#181408', strong: '#E0B840', text: '#F8E080' },
      account: { soft: '#181408', strong: '#A88020', text: '#DCC060' },
    },
  },

  carbon: {
    name: 'carbon',
    label: 'Carbon Ruby',
    description: 'Matte carbon black with ruby primary and cool steel-blue contrast — sharp, modern, and controlled.',
    colors: {
      background:    '#080A0D',
      surface:       '#11151A',
      surfaceRaised: '#1B222A',
      border:        '#2A3440',
      primary:       '#E35684',
      primaryDark:   '#9F123F',
      primaryLight:  '#FF6F9A',
      accent:        '#5DA9E9',
      textPrimary:   '#F4F7FA',
      textSecondary: '#A9B5C0',
      textMuted:     '#7F8B95',
      error:         '#FF4A64',
      warning:       '#E8A83A',
      success:       '#48C878',
    },
    sections: {
      workout: { soft: '#24101A', strong: '#D91E5B', text: '#FF8CAE' },
      meals:   { soft: '#0E241B', strong: '#48C878', text: '#9BE8B8' },
      ai:      { soft: '#0E1A2A', strong: '#5DA9E9', text: '#A6D4FF' },
      planner: { soft: '#201828', strong: '#9B72E8', text: '#CAB0FF' },
      account: { soft: '#241A0C', strong: '#E8A83A', text: '#F6D184' },
    },
  },

  // ── MEDIUM DARK ──────────────────────────────────────────────────────────────

  slate: {
    name: 'slate',
    label: 'Slate & Coral',
    description: 'Cool steel blue-grey panels with warm coral-orange primary — clean professional contrast.',
    colors: {
      background:    '#182030',
      surface:       '#222C3E',
      surfaceRaised: '#2C3850',
      border:        '#3A4C66',
      primary:       '#F18357',
      primaryDark:   '#C05828',
      primaryLight:  '#F8A880',
      accent:        '#40C8D0',
      textPrimary:   '#E8F4FF',
      textSecondary: '#A8C0D8',
      textMuted:     '#8BA3BC',
      error:         '#FF757B',
      warning:       '#F0A030',
      success:       '#40C878',
    },
    sections: {
      workout: { soft: '#142840', strong: '#40C8D0', text: '#A0E8F0' },
      meals:   { soft: '#142A20', strong: '#40C878', text: '#98E8B0' },
      ai:      { soft: '#201408', strong: '#F07848', text: '#F8C0A0' },
      planner: { soft: '#1E1840', strong: '#7870E8', text: '#C0B8FF' },
      account: { soft: '#0E2010', strong: '#40C878', text: '#98E8B0' },
    },
  },

  graphite: {
    name: 'graphite',
    label: 'Graphite Volt',
    description: 'Dark graphite panels with lime-yellow primary and cobalt contrast — sporty, sharp, and kinetic.',
    colors: {
      background:    '#111315',
      surface:       '#1A1D20',
      surfaceRaised: '#242A2E',
      border:        '#384047',
      primary:       '#D6F23A',
      primaryDark:   '#A6C20F',
      primaryLight:  '#EBFF7A',
      accent:        '#4C7DFF',
      textPrimary:   '#F3F6F0',
      textSecondary: '#AEB8B0',
      textMuted:     '#89928D',
      error:         '#F15F5F',
      warning:       '#E8B840',
      success:       '#55C878',
    },
    sections: {
      workout: { soft: '#1D240A', strong: '#D6F23A', text: '#ECFF8A' },
      meals:   { soft: '#0E2318', strong: '#55C878', text: '#A0E8B8' },
      ai:      { soft: '#101832', strong: '#4C7DFF', text: '#A8C0FF' },
      planner: { soft: '#241C08', strong: '#E8B840', text: '#F4D780' },
      account: { soft: '#231014', strong: '#E85C78', text: '#F8A8B8' },
    },
  },

  // ── DARK / PINK ──────────────────────────────────────────────────────────────

  blossom: {
    name: 'blossom',
    label: 'Blossom Noir',
    description: 'Dark fuchsia-black with vivid hot pink and plum — bold, dramatic, unapologetically pink.',
    colors: {
      background:    '#150810',
      surface:       '#20121C',
      surfaceRaised: '#2E1828',
      border:        '#501838',
      primary:       '#FF1890',
      primaryDark:   '#CC0070',
      primaryLight:  '#FF88C8',
      accent:        '#FFD020',
      textPrimary:   '#FFF0F8',
      textSecondary: '#D098B8',
      textMuted:     '#A07D92',
      error:         '#FF3048',
      warning:       '#FFD020',
      success:       '#40C870',
    },
    sections: {
      workout: { soft: '#280840', strong: '#B040E0', text: '#E090FF' },
      meals:   { soft: '#2C1400', strong: '#FF8820', text: '#FFD090' },
      ai:      { soft: '#300830', strong: '#FF1890', text: '#FF90D0' },
      planner: { soft: '#281808', strong: '#FFD020', text: '#FFF080' },
      account: { soft: '#300828', strong: '#FF40A0', text: '#FFA8D8' },
    },
  },

  orchid: {
    name: 'orchid',
    label: 'Orchid Dusk',
    description: 'Medium-dark plum with rose-pink primary and cool aqua contrast — pink, soft, and still evening-weight.',
    colors: {
      background:    '#241724',
      surface:       '#302230',
      surfaceRaised: '#3D2B3B',
      border:        '#5B3A55',
      primary:       '#F169A7',
      primaryDark:   '#BC2F70',
      primaryLight:  '#FF9BC8',
      accent:        '#4FD0C8',
      textPrimary:   '#FFF1F8',
      textSecondary: '#D2A8BE',
      textMuted:     '#AA92A0',
      error:         '#F26E77',
      warning:       '#D9A441',
      success:       '#4BC47A',
    },
    sections: {
      workout: { soft: '#231D36', strong: '#8E78E8', text: '#CDBFFF' },
      meals:   { soft: '#1B302D', strong: '#4FD0C8', text: '#A8F1EA' },
      ai:      { soft: '#361A2B', strong: '#F05A9E', text: '#FFADCF' },
      planner: { soft: '#34270E', strong: '#D9A441', text: '#F0CF78' },
      account: { soft: '#2E1B28', strong: '#C87AB8', text: '#F2B9DF' },
    },
  },

  // ── DARK / PURE ──────────────────────────────────────────────────────────────

  void: {
    name: 'void',
    label: 'Void',
    description: 'Pure OLED black with ice-white text and minimal blue — maximum contrast, zero distraction.',
    colors: {
      background:    '#000000',
      surface:       '#0A0A0A',
      surfaceRaised: '#141414',
      border:        '#222222',
      primary:       '#4C9EFF',
      primaryDark:   '#2A74CC',
      primaryLight:  '#88C4FF',
      accent:        '#FF6B6B',
      textPrimary:   '#FFFFFF',
      textSecondary: '#B0B0B0',
      textMuted:     '#7E7E7E',
      error:         '#FF4444',
      warning:       '#FFB020',
      success:       '#44CC66',
    },
    sections: {
      workout: { soft: '#0A1428', strong: '#4C9EFF', text: '#A0CCFF' },
      meals:   { soft: '#0A1E10', strong: '#44CC66', text: '#88EEAA' },
      ai:      { soft: '#140A1E', strong: '#9060E8', text: '#C8A0FF' },
      planner: { soft: '#1A1400', strong: '#FFB020', text: '#FFD880' },
      account: { soft: '#1A0A0A', strong: '#FF6B6B', text: '#FFB0B0' },
    },
  },

  dusk: {
    name: 'dusk',
    label: 'Twilight Dusk',
    description: 'Soft muted navy with warm peach and lavender — a gentle, calming dark theme.',
    colors: {
      background:    '#0E0E1A',
      surface:       '#161628',
      surfaceRaised: '#1E1E38',
      border:        '#2E2E50',
      primary:       '#E8A878',
      primaryDark:   '#C08050',
      primaryLight:  '#F8D0B0',
      accent:        '#A088D8',
      textPrimary:   '#EAE6F0',
      textSecondary: '#A8A0C0',
      textMuted:     '#8B859D',
      error:         '#E95555',
      warning:       '#D8A040',
      success:       '#48B878',
    },
    sections: {
      workout: { soft: '#1A1230', strong: '#A088D8', text: '#D0C0F0' },
      meals:   { soft: '#201810', strong: '#E8A878', text: '#F8D0B0' },
      ai:      { soft: '#0E1428', strong: '#5878C8', text: '#A0B8F0' },
      planner: { soft: '#1C1830', strong: '#C090E0', text: '#E8C8FF' },
      account: { soft: '#201018', strong: '#D06888', text: '#F0A8C8' },
    },
  },

  lavender: {
    name: 'lavender',
    label: 'Lavender Dream',
    description: 'Soft dark purple with muted lavender, mint, and rose — cozy, pastel, dreamy.',
    colors: {
      background:    '#121018',
      surface:       '#1A1624',
      surfaceRaised: '#242032',
      border:        '#382E4C',
      primary:       '#B898E0',
      primaryDark:   '#8868B8',
      primaryLight:  '#D8C0F8',
      accent:        '#78D8B0',
      textPrimary:   '#EEE8F8',
      textSecondary: '#B0A0C8',
      textMuted:     '#8E85A1',
      error:         '#E86070',
      warning:       '#D8A848',
      success:       '#58C888',
    },
    sections: {
      workout: { soft: '#1A1430', strong: '#B898E0', text: '#D8C0F8' },
      meals:   { soft: '#0C2420', strong: '#78D8B0', text: '#B0F0D8' },
      ai:      { soft: '#201028', strong: '#D878A8', text: '#F0A8D0' },
      planner: { soft: '#201828', strong: '#A880D0', text: '#D0B0F0' },
      account: { soft: '#1C1018', strong: '#E07090', text: '#F8B0C8' },
    },
  },

  aurora: {
    name: 'aurora',
    label: 'Aurora Borealis',
    description: 'Deep arctic night with shimmering green, teal, and violet — like the northern lights.',
    colors: {
      background:    '#060B14',
      surface:       '#0C1420',
      surfaceRaised: '#14202E',
      border:        '#1C2C3E',
      primary:       '#40E8A0',
      primaryDark:   '#28B878',
      primaryLight:  '#80F8C8',
      accent:        '#60B8F0',
      textPrimary:   '#E8F0F8',
      textSecondary: '#90A8C0',
      textMuted:     '#778996',
      error:         '#F06070',
      warning:       '#E8B040',
      success:       '#40D888',
    },
    sections: {
      workout: { soft: '#081820', strong: '#40E8A0', text: '#90F8D0' },
      meals:   { soft: '#081420', strong: '#60B8F0', text: '#A0D8F8' },
      ai:      { soft: '#140C28', strong: '#A070E8', text: '#C8A8F8' },
      planner: { soft: '#0C1C28', strong: '#48C8D8', text: '#90E0E8' },
      account: { soft: '#181020', strong: '#B868D8', text: '#D8A0F0' },
    },
  },

  alpine: {
    name: 'alpine',
    label: 'Alpine Copper',
    description: 'Deep green-black with alpine green primary and burnished copper contrast — natural, strong, and premium.',
    colors: {
      background:    '#07110E',
      surface:       '#0E1C17',
      surfaceRaised: '#162720',
      border:        '#264236',
      primary:       '#3EBC78',
      primaryDark:   '#20824F',
      primaryLight:  '#8BE0AF',
      accent:        '#C77A3C',
      textPrimary:   '#EAF7F0',
      textSecondary: '#9AB8A8',
      textMuted:     '#799084',
      error:         '#E55D5D',
      warning:       '#D99A38',
      success:       '#46C27D',
    },
    sections: {
      workout: { soft: '#0C2418', strong: '#3EBC78', text: '#98E8B8' },
      meals:   { soft: '#271608', strong: '#C77A3C', text: '#E8B07C' },
      ai:      { soft: '#0A1C24', strong: '#48B8D8', text: '#9ADCF0' },
      planner: { soft: '#1A240A', strong: '#9BC44A', text: '#CFE88A' },
      account: { soft: '#241408', strong: '#D69048', text: '#F0C088' },
    },
  },

  // ── LIGHT / WARM ─────────────────────────────────────────────────────────────

  sunrise: {
    name: 'sunrise',
    label: 'Sunrise Bloom',
    description: 'Warm cream background with tangerine orange primary — a bright, cozy morning feel.',
    colors: {
      background:    '#FFF5EC',
      surface:       '#FFFDF9',
      surfaceRaised: '#FDEDDC',
      border:        '#E8CDB5',
      primary:       '#A05C1A',
      primaryDark:   '#D46F0A',
      primaryLight:  '#FBC98C',
      accent:        '#D96C8B',
      textPrimary:   '#402A1E',
      textSecondary: '#75584A',
      textMuted:     '#826657',
      error:         '#C13E3E',
      warning:       '#8F6600',
      success:       '#257B50',
    },
    sections: {
      workout: { soft: '#DDEEFF', strong: '#3A82CC', text: '#1A4A88' },
      meals:   { soft: '#D8F0E0', strong: '#2A9E58', text: '#0E5028' },
      ai:      { soft: '#EAE0FF', strong: '#6848C8', text: '#2A1080' },
      planner: { soft: '#F5E8C9', strong: '#B98A22', text: '#6F5211' },
      account: { soft: '#FFE8EC', strong: '#D96C8B', text: '#8A1E38' },
    },
  },

  cardinal: {
    name: 'cardinal',
    label: 'Cardinal Studio',
    description: 'Clean white-ivory surfaces with cardinal red primary and deep navy contrast — premium, crisp, and assertive.',
    colors: {
      background:    '#FFF9F6',
      surface:       '#FFFFFF',
      surfaceRaised: '#F7EAE6',
      border:        '#E4C6C0',
      primary:       '#B51F34',
      primaryDark:   '#841122',
      primaryLight:  '#E36478',
      accent:        '#153A66',
      textPrimary:   '#251015',
      textSecondary: '#63424A',
      textMuted:     '#7F646A',
      error:         '#C52232',
      warning:       '#955F0F',
      success:       '#28794A',
    },
    sections: {
      workout: { soft: '#DDE8F6', strong: '#153A66', text: '#0C2542' },
      meals:   { soft: '#DCEFE3', strong: '#287A4B', text: '#0C3A20' },
      ai:      { soft: '#F7DCE2', strong: '#B51F34', text: '#5A0E1A' },
      planner: { soft: '#F8E9CA', strong: '#B87512', text: '#553300' },
      account: { soft: '#E9E0F4', strong: '#6E4AA8', text: '#2C1858' },
    },
  },

  // ── LIGHT / NEUTRAL ──────────────────────────────────────────────────────────

  parchment: {
    name: 'parchment',
    label: 'Parchment & Bark',
    description: 'Warm parchment-tan background with coffee-brown primary — natural, calm, and earthy.',
    colors: {
      background:    '#F1E8D6',
      surface:       '#FBF5E8',
      surfaceRaised: '#E5D7C0',
      border:        '#C9B594',
      primary:       '#7C4F2A',
      primaryDark:   '#5A3418',
      primaryLight:  '#B08A60',
      accent:        '#C07830',
      textPrimary:   '#2A1E14',
      textSecondary: '#6A4E38',
      textMuted:     '#6D5C4C',
      error:         '#B22C2C',
      warning:       '#835500',
      success:       '#2B6B40',
    },
    sections: {
      workout: { soft: '#E8E0D8', strong: '#7C4F2A', text: '#3A200C' },
      meals:   { soft: '#D8EDDC', strong: '#307848', text: '#0E4020' },
      ai:      { soft: '#E8E4F4', strong: '#5848A8', text: '#201060' },
      planner: { soft: '#F4EAD8', strong: '#C07830', text: '#6A3E08' },
      account: { soft: '#F0E8E0', strong: '#8A5030', text: '#3A1808' },
    },
  },

  linen: {
    name: 'linen',
    label: 'Linen & Olive',
    description: 'Soft cream background with earthy olive primary and muted clay — minimal, grown-up, serene.',
    colors: {
      background:    '#F8F4EC',
      surface:       '#FFFDF6',
      surfaceRaised: '#EFE8D8',
      border:        '#D4CAB4',
      primary:       '#5C6F2A',
      primaryDark:   '#4A5A1A',
      primaryLight:  '#9CB058',
      accent:        '#B85830',
      textPrimary:   '#1E2410',
      textSecondary: '#4C5A34',
      textMuted:     '#656C4C',
      error:         '#B8342C',
      warning:       '#925D1B',
      success:       '#387545',
    },
    sections: {
      workout: { soft: '#E8F0D4', strong: '#6A8030', text: '#2A4010' },
      meals:   { soft: '#F5E4D4', strong: '#B85830', text: '#5A2010' },
      ai:      { soft: '#E4E8F0', strong: '#4868A8', text: '#18306E' },
      planner: { soft: '#F4ECD4', strong: '#A88434', text: '#5E4414' },
      account: { soft: '#EDE4F4', strong: '#6A508C', text: '#30205E' },
    },
  },

  // Crisp white background with deep clover green as the only accent.
  // Light minimal-luxury counterpart to `obsidian` (Black Gold) — same
  // clean single-accent identity, just green-on-white instead of
  // gold-on-black.
  clover: {
    name: 'clover',
    label: 'Clover White',
    description: 'Crisp white background with deep clover green as the only accent — clean, fresh, the green-and-white counterpart to Ivory Gold.',
    colors: {
      background:    '#F6FBF4',
      surface:       '#FFFFFF',
      surfaceRaised: '#E8F2E4',
      border:        '#BFD8B8',
      primary:       '#2A7A3E',
      primaryDark:   '#175420',
      primaryLight:  '#5BB572',
      accent:        '#A87E18',
      textPrimary:   '#0E2014',
      textSecondary: '#36523C',
      textMuted:     '#5F7064',
      error:         '#B82828',
      warning:       '#8A670E',
      success:       '#1F7A38',
    },
    sections: {
      workout: { soft: '#D6ECD2', strong: '#2A7A3E', text: '#0E3818' },
      meals:   { soft: '#D6ECD2', strong: '#2A7A3E', text: '#0E3818' },
      ai:      { soft: '#DEE4F4', strong: '#3858A0', text: '#18285A' },
      planner: { soft: '#F4EAC8', strong: '#A87E18', text: '#5A4108' },
      account: { soft: '#E2EDDA', strong: '#3E8A50', text: '#163C1E' },
    },
  },

  butter: {
    name: 'butter',
    label: 'Butter & Honey',
    description: 'Soft buttery background with deep amber — warm, inviting, morning light.',
    colors: {
      background:    '#FFF9E6',
      surface:       '#FFFFFF',
      surfaceRaised: '#FBEFC7',
      border:        '#E8D18A',
      primary:       '#9A5E06',
      primaryDark:   '#8A5404',
      primaryLight:  '#E8A840',
      accent:        '#2A5E8C',
      textPrimary:   '#2A1F04',
      textSecondary: '#5A4218',
      textMuted:     '#7E6A40',
      error:         '#C42030',
      warning:       '#946300',
      success:       '#287B45',
    },
    sections: {
      workout: { soft: '#FBE8A8', strong: '#C07608', text: '#4A2C04' },
      meals:   { soft: '#DCEEF8', strong: '#2A5E8C', text: '#0A2438' },
      ai:      { soft: '#F0E0F8', strong: '#8A3AC0', text: '#2E0A4A' },
      planner: { soft: '#FFE8D0', strong: '#C25818', text: '#4A1C04' },
      account: { soft: '#FAE4CC', strong: '#A04818', text: '#3C1806' },
    },
  },

  summer: {
    name: 'summer',
    label: 'Summer Tide',
    description: 'Sunlit aqua with leaf-green primary and clear pool-blue accents - fresh, bright, and active.',
    colors: {
      background:    '#E9F8F4',
      surface:       '#FFFFFF',
      surfaceRaised: '#D7F0EA',
      border:        '#9CCFC4',
      primary:       '#18784C',
      primaryDark:   '#11673F',
      primaryLight:  '#65C98F',
      accent:        '#1687C5',
      textPrimary:   '#06251E',
      textSecondary: '#285B55',
      textMuted:     '#4F706C',
      error:         '#BE3944',
      warning:       '#905F0E',
      success:       '#18784C',
    },
    sections: {
      workout: { soft: '#D5EBFF', strong: '#1687C5', text: '#0B4568' },
      meals:   { soft: '#D7F2DF', strong: '#1F9A61', text: '#0E4A2D' },
      ai:      { soft: '#DCECF8', strong: '#2A75B8', text: '#123E66' },
      planner: { soft: '#D6F1EA', strong: '#20A9A0', text: '#07514B' },
      account: { soft: '#E2F3D8', strong: '#5CA43A', text: '#244F16' },
    },
  },

  lilac: {
    name: 'lilac',
    label: 'Lilac Morning',
    description: 'Pale lilac background with royal purple and peach — soft, floral, distinct.',
    colors: {
      background:    '#F5F0FB',
      surface:       '#FFFFFF',
      surfaceRaised: '#EADFF6',
      border:        '#C4B0E4',
      primary:       '#6B3AA8',
      primaryDark:   '#471C80',
      primaryLight:  '#9A74D0',
      accent:        '#E89470',
      textPrimary:   '#1F1030',
      textSecondary: '#4A3664',
      textMuted:     '#715D86',
      error:         '#C02747',
      warning:       '#915800',
      success:       '#267341',
    },
    sections: {
      workout: { soft: '#DCCCF0', strong: '#6B3AA8', text: '#2A0E58' },
      meals:   { soft: '#F8DFCC', strong: '#D0702A', text: '#4A2008' },
      ai:      { soft: '#FFD8E8', strong: '#C83080', text: '#4A0A30' },
      planner: { soft: '#E0F0F8', strong: '#3468A8', text: '#0A2848' },
      account: { soft: '#D8F0E0', strong: '#1C7850', text: '#042A20' },
    },
  },

  sky: {
    name: 'sky',
    label: 'Open Sky',
    description: 'Pale sky-cyan background with bright sky-blue primary and warm coral accent — airy, optimistic, light.',
    colors: {
      background:    '#EAF6FB',
      surface:       '#FFFFFF',
      surfaceRaised: '#D4ECF6',
      border:        '#A8D0E0',
      primary:       '#0D6EA6',
      primaryDark:   '#075280',
      primaryLight:  '#4FB0E0',
      accent:        '#E06840',
      textPrimary:   '#08202C',
      textSecondary: '#285468',
      textMuted:     '#4E6D7A',
      error:         '#C42C3A',
      warning:       '#905E00',
      success:       '#167748',
    },
    sections: {
      workout: { soft: '#CCE6F2', strong: '#0E7AB8', text: '#08303C' },
      meals:   { soft: '#F8DCD0', strong: '#E06840', text: '#5A1808' },
      ai:      { soft: '#E0E0F8', strong: '#4040C8', text: '#101058' },
      planner: { soft: '#F8ECC8', strong: '#B07820', text: '#503808' },
      account: { soft: '#D0EDE8', strong: '#1A8888', text: '#063030' },
    },
  },

  glacier: {
    name: 'glacier',
    label: 'Glacier Lab',
    description: 'Cool white-blue surfaces with cobalt primary and clean cyan contrast — bright, precise, and technical.',
    colors: {
      background:    '#F4FAFF',
      surface:       '#FFFFFF',
      surfaceRaised: '#E4F0FA',
      border:        '#B8CCDD',
      primary:       '#1967DC',
      primaryDark:   '#124A9C',
      primaryLight:  '#6EA8FF',
      accent:        '#00AFC7',
      textPrimary:   '#061525',
      textSecondary: '#35516A',
      textMuted:     '#5C6E80',
      error:         '#C23949',
      warning:       '#975F10',
      success:       '#1D7A5B',
    },
    sections: {
      workout: { soft: '#DCEBFF', strong: '#1B6EEA', text: '#082C66' },
      meals:   { soft: '#DDF3EC', strong: '#1E8060', text: '#073A2A' },
      ai:      { soft: '#E7E2FA', strong: '#6950C8', text: '#24146E' },
      planner: { soft: '#D8F1F6', strong: '#00AFC7', text: '#06424A' },
      account: { soft: '#F4E2E8', strong: '#B94A68', text: '#5A1028' },
    },
  },

  citrus: {
    name: 'citrus',
    label: 'Citrus Studio',
    description: 'Pale citrus background with leafy green primary and orange studio accents.',
    colors: {
      background:    '#FBFDEB',
      surface:       '#FFFFFF',
      surfaceRaised: '#EEF4C8',
      border:        '#CBDC8A',
      primary:       '#517815',
      primaryDark:   '#3D5F0B',
      primaryLight:  '#9CCB43',
      accent:        '#E36F35',
      textPrimary:   '#17220A',
      textSecondary: '#43562A',
      textMuted:     '#64724C',
      error:         '#C33A34',
      warning:       '#956200',
      success:       '#297B4B',
    },
    sections: {
      workout: { soft: '#E4F3C4', strong: '#5D8A18', text: '#243E08' },
      meals:   { soft: '#FBE0CE', strong: '#E36F35', text: '#642208' },
      ai:      { soft: '#DDE7F8', strong: '#386FB4', text: '#123760' },
      planner: { soft: '#FFF0BD', strong: '#B87900', text: '#513600' },
      account: { soft: '#F4DCEB', strong: '#B73A7E', text: '#551238' },
    },
  },

  terra: {
    name: 'terra',
    label: 'Terra Clay',
    description: 'Soft stone-sage surfaces with clay red primary and deep olive contrast — grounded without feeling heavy.',
    colors: {
      background:    '#F3F6F1',
      surface:       '#FFFFFF',
      surfaceRaised: '#E4EBDD',
      border:        '#C3D0BF',
      primary:       '#A2523E',
      primaryDark:   '#843B2E',
      primaryLight:  '#DF8C75',
      accent:        '#386F5A',
      textPrimary:   '#17221D',
      textSecondary: '#485A51',
      textMuted:     '#5F6C64',
      error:         '#B93642',
      warning:       '#846415',
      success:       '#30754D',
    },
    sections: {
      workout: { soft: '#E8DDD8', strong: '#B85D46', text: '#552014' },
      meals:   { soft: '#DDEBE1', strong: '#386F5A', text: '#123826' },
      ai:      { soft: '#E6E1F2', strong: '#6E58A8', text: '#261A5A' },
      planner: { soft: '#EEF0D8', strong: '#8A8F2A', text: '#343A0A' },
      account: { soft: '#DCE8ED', strong: '#2E7288', text: '#0D3844' },
    },
  },

  // ── LIGHT / PINK ─────────────────────────────────────────────────────────────

  rose: {
    name: 'rose',
    label: 'Rose Quartz',
    description: 'Soft blush-pink background with dusty rose primary and champagne gold accent — romantic and light.',
    colors: {
      background:    '#FDF0F4',
      surface:       '#FFFFFF',
      surfaceRaised: '#F8E0E8',
      border:        '#E0B8C4',
      primary:       '#AD4165',
      primaryDark:   '#903050',
      primaryLight:  '#E888A8',
      accent:        '#C89040',
      textPrimary:   '#1E0A10',
      textSecondary: '#5A2838',
      textMuted:     '#865A68',
      error:         '#C42030',
      warning:       '#8B5F00',
      success:       '#167547',
    },
    sections: {
      workout: { soft: '#F8D8E4', strong: '#C04870', text: '#3A0A18' },
      meals:   { soft: '#FEF0D0', strong: '#C89040', text: '#5A3810' },
      ai:      { soft: '#E8E4F4', strong: '#7040A8', text: '#2A0A58' },
      planner: { soft: '#F0F4FF', strong: '#4060B8', text: '#101848' },
      account: { soft: '#D8F0E4', strong: '#1A7848', text: '#063028' },
    },
  },

  // ── SLATE-STYLE (medium-dark tinted bg × cross-hue primary) ──────────────────

  ash: {
    name: 'ash',
    label: 'Ash & Sky',
    description: 'Warm charcoal panels with electric sky-blue primary — clean, modern, two-color contrast.',
    colors: {
      background:    '#1C1916',
      surface:       '#252018',
      surfaceRaised: '#302C24',
      border:        '#453E34',
      primary:       '#48A8FF',
      primaryDark:   '#2880D8',
      primaryLight:  '#88C8FF',
      accent:        '#FF9840',
      textPrimary:   '#F4F0E8',
      textSecondary: '#B8A890',
      textMuted:     '#9C9185',
      error:         '#FF5A5A',
      warning:       '#F0A820',
      success:       '#50C070',
    },
    sections: {
      workout: { soft: '#141C2A', strong: '#48A8FF', text: '#A0CCFF' },
      meals:   { soft: '#1C2C18', strong: '#60B858', text: '#98D888' },
      ai:      { soft: '#181228', strong: '#9870E8', text: '#C8A8FF' },
      planner: { soft: '#241C08', strong: '#F0A820', text: '#F8CE78' },
      account: { soft: '#1C1410', strong: '#D07840', text: '#F0A878' },
    },
  },

  cosmos: {
    name: 'cosmos',
    label: 'Cosmos',
    description: 'Deep indigo panels with warm amber primary — complementary contrast, space-depth atmosphere.',
    colors: {
      background:    '#0E1228',
      surface:       '#141A38',
      surfaceRaised: '#1E2448',
      border:        '#2C3860',
      primary:       '#FF8C30',
      primaryDark:   '#CC6010',
      primaryLight:  '#FFB870',
      accent:        '#90B8FF',
      textPrimary:   '#E8ECFF',
      textSecondary: '#98A8D0',
      textMuted:     '#818DBB',
      error:         '#F05870',
      warning:       '#E8B040',
      success:       '#48C878',
    },
    sections: {
      workout: { soft: '#101828', strong: '#70A0F8', text: '#A8C8FF' },
      meals:   { soft: '#1A1408', strong: '#FF8C30', text: '#FFB870' },
      ai:      { soft: '#160C30', strong: '#A070E8', text: '#D0A8FF' },
      planner: { soft: '#141828', strong: '#90B8FF', text: '#C8D8FF' },
      account: { soft: '#181028', strong: '#C880FF', text: '#E8B8FF' },
    },
  },

  // ── DARK COMBO (tinted medium-dark bg × cross-hue primary) ───────────────────

  cinder: {
    name: 'cinder',
    label: 'Cinder & Fuchsia',
    description: 'Cool dark neutral grey with vivid hot-pink primary — crisp modern base, electric header.',
    colors: {
      background:    '#181C20',
      surface:       '#20262E',
      surfaceRaised: '#2A323C',
      border:        '#3A4450',
      primary:       '#FF59B0',
      primaryDark:   '#C80070',
      primaryLight:  '#FF80CC',
      accent:        '#20E890',
      textPrimary:   '#F2F4F8',
      textSecondary: '#A0AABB',
      textMuted:     '#949AA5',
      error:         '#F36E7B',
      warning:       '#F0A828',
      success:       '#48C870',
    },
    sections: {
      workout: { soft: '#1A1028', strong: '#FF2898', text: '#FF90D0' },
      meals:   { soft: '#0C2018', strong: '#20E890', text: '#80FFCC' },
      ai:      { soft: '#101830', strong: '#6080F0', text: '#A8C0FF' },
      planner: { soft: '#201418', strong: '#FF5888', text: '#FFB0D0' },
      account: { soft: '#182028', strong: '#20C0E8', text: '#80E8FF' },
    },
  },

  smoke: {
    name: 'smoke',
    label: 'Smoke & Lime',
    description: 'Steel-blue smoke panels with electric acid-lime primary — industrial cool, neon pop.',
    colors: {
      background:    '#141E28',
      surface:       '#1E2C38',
      surfaceRaised: '#283848',
      border:        '#384E60',
      primary:       '#A0D820',
      primaryDark:   '#78A808',
      primaryLight:  '#C8F060',
      accent:        '#FF8040',
      textPrimary:   '#EEF4FF',
      textSecondary: '#90A8C0',
      textMuted:     '#8DA2AC',
      error:         '#F3798D',
      warning:       '#F0A830',
      success:       '#40C870',
    },
    sections: {
      workout: { soft: '#101828', strong: '#A0D820', text: '#D0F870' },
      meals:   { soft: '#281808', strong: '#FF8040', text: '#FFBA80' },
      ai:      { soft: '#141430', strong: '#7060E8', text: '#C0B0FF' },
      planner: { soft: '#181E28', strong: '#60A8E8', text: '#A8D0FF' },
      account: { soft: '#102018', strong: '#30B858', text: '#80E0A0' },
    },
  },

  maroon: {
    name: 'maroon',
    label: 'Maroon & Cyan',
    description: 'Deep burgundy-red panels with electric cyan primary — blood-warm base, arctic header pop.',
    colors: {
      background:    '#201018',
      surface:       '#2C1620',
      surfaceRaised: '#38202C',
      border:        '#583040',
      primary:       '#20D8E8',
      primaryDark:   '#10A8C0',
      primaryLight:  '#70E8F8',
      accent:        '#FF6840',
      textPrimary:   '#FFF0F4',
      textSecondary: '#C098A8',
      textMuted:     '#A08894',
      error:         '#F25A62',
      warning:       '#F0A828',
      success:       '#40C870',
    },
    sections: {
      workout: { soft: '#101828', strong: '#20D8E8', text: '#80F0F8' },
      meals:   { soft: '#281010', strong: '#FF6840', text: '#FFAB80' },
      ai:      { soft: '#180828', strong: '#A060E8', text: '#D0A8FF' },
      planner: { soft: '#182028', strong: '#50B8F0', text: '#A0D8FF' },
      account: { soft: '#281018', strong: '#E05870', text: '#F8A0B0' },
    },
  },

  // ── MONOCHROME / MINIMALIST ──────────────────────────────────────────────────
  // Two intentionally colorless themes. Section palettes use neutral grays
  // with an accent intensity ladder instead of hues — that's the whole
  // point of "minimalist" so we keep it consistent across surfaces.

  onyx: {
    name: 'onyx',
    label: 'Onyx',
    description: 'Pure black with crisp white text. No color, just grayscale tiers.',
    colors: {
      background:    '#000000',
      surface:       '#0E0E0E',
      surfaceRaised: '#1A1A1A',
      chrome:        '#050505',
      chromeMuted:   '#101010',
      chromeBorder:  '#3A3A3A',
      border:        '#2A2A2A',
      // Primary is intentionally white in onyx — it's the brand color
      // when stripped of all hue. Buttons read as solid blocks.
      primary:       '#FFFFFF',
      primaryDark:   '#D4D4D4',
      primaryLight:  '#FAFAFA',
      accent:        '#E5E5E5',
      textPrimary:   '#FFFFFF',
      textSecondary: '#B8B8B8',
      textMuted:     '#828282',
      // Tiny touches of color reserved for true semantic states only —
      // the full spectrum of gray would erase the affordance of "this
      // is bad" vs "this is good".
      error:         '#FF5555',
      warning:       '#E0A040',
      success:       '#7AC07A',
    },
    sections: {
      workout: { soft: '#1A1A1A', strong: '#FFFFFF', text: '#FFFFFF' },
      meals:   { soft: '#161616', strong: '#E0E0E0', text: '#FFFFFF' },
      ai:      { soft: '#1F1F1F', strong: '#CCCCCC', text: '#FFFFFF' },
      planner: { soft: '#181818', strong: '#D8D8D8', text: '#FFFFFF' },
      account: { soft: '#222222', strong: '#B0B0B0', text: '#FFFFFF' },
    },
  },

  paper: {
    name: 'paper',
    label: 'Paper',
    description: 'Pure white with deep black ink. Nothing but type, lines, and space.',
    colors: {
      background:    '#FFFFFF',
      surface:       '#F7F7F7',
      surfaceRaised: '#EFEFEF',
      chrome:        '#E7E7E7',
      chromeMuted:   '#F0F0F0',
      chromeBorder:  '#AFAFAF',
      border:        '#D8D8D8',
      // Primary is black — the ink. Bright color buttons would clash
      // with the minimalist intent.
      primary:       '#000000',
      primaryDark:   '#000000',
      primaryLight:  '#3A3A3A',
      accent:        '#1A1A1A',
      textPrimary:   '#000000',
      textSecondary: '#3A3A3A',
      textMuted:     '#6B6B6B',
      error:         '#C03030',
      warning:       '#97601C',
      success:       '#3A7A3A',
    },
    sections: {
      workout: { soft: '#EFEFEF', strong: '#000000', text: '#000000' },
      meals:   { soft: '#F0F0F0', strong: '#1A1A1A', text: '#000000' },
      ai:      { soft: '#EBEBEB', strong: '#2A2A2A', text: '#000000' },
      planner: { soft: '#EDEDED', strong: '#222222', text: '#000000' },
      account: { soft: '#E8E8E8', strong: '#3A3A3A', text: '#000000' },
    },
  },

};

export const THEME_PICKER_ORDER = [
  // Surface the minimalist pair near the top — they're a distinct
  // aesthetic and easy to miss buried under colored options.
  'onyx', 'paper',
  'midnight', 'ocean', 'amethyst',
  'ember', 'infrared', 'wine', 'obsidian', 'carbon',
  'slate', 'graphite', 'blossom', 'orchid', 'void', 'dusk', 'lavender', 'aurora', 'alpine',
  'sunrise', 'cardinal', 'parchment', 'linen',
  // Light green-on-white counterpart to obsidian — placed next to the
  // other warm/clean lights so it groups naturally in the picker.
  'clover',
  'butter', 'summer', 'lilac', 'sky', 'glacier',
  'citrus', 'terra', 'rose', 'ash', 'cosmos',
  'cinder', 'smoke', 'maroon',
] as const satisfies readonly AppThemeName[];

export const LIGHT_THEME_NAMES = [
  'sunrise', 'cardinal', 'parchment', 'linen',
  'clover',
  'butter', 'summer', 'lilac', 'sky', 'glacier', 'citrus', 'terra', 'rose',
  // Paper is a light theme — drives status-bar style + "is light"
  // branching in HomeScreen so the dark statusbar text shows up
  // correctly against the white background.
  'paper',
] as const satisfies readonly AppThemeName[];

const LEGACY_THEME_ALIASES: Record<string, AppThemeName> = {
  scarlet: 'wine',
  mint: 'summer',
  seaglass: 'summer',
  porcelain: 'sky',
  evergreen: 'alpine',
};

export function resolveThemeName(themeName?: AppThemeName | string): AppThemeName {
  const candidate = themeName ?? DEFAULT_THEME_NAME;
  if ((APP_THEMES as Record<string, AppTheme | undefined>)[candidate]) {
    return candidate as AppThemeName;
  }
  return LEGACY_THEME_ALIASES[candidate] ?? DEFAULT_THEME_NAME;
}

export function isLightThemeName(themeName?: AppThemeName | string): boolean {
  return (LIGHT_THEME_NAMES as readonly string[]).includes(resolveThemeName(themeName));
}

export function getChromeColors(themeName?: AppThemeName | string): {
  surface: string;
  muted: string;
  border: string;
} {
  const theme = APP_THEMES[resolveThemeName(themeName)];
  const c = theme.colors;
  const light = isLightThemeName(theme.name);
  return {
    surface: c.chrome ?? (light ? c.surfaceRaised : c.background),
    muted: c.chromeMuted ?? (light ? c.surfaceRaised : c.surface),
    border: c.chromeBorder ?? (light ? c.textMuted + '55' : c.border + 'F0'),
  };
}

// Pick black or white text for readability on the given background color.
// Used by primary CTAs (Start Workout, big save buttons, etc.) where the
// background is theme-driven and a hardcoded '#FFFFFF' text breaks on the
// monochrome themes (onyx has white primary → invisible white-on-white).
export function getContrastingTextColor(hex: string): string {
  if (!hex) return '#FFFFFF';
  const h = hex.replace('#', '');
  if (h.length !== 6 && h.length !== 3) return '#FFFFFF';
  const expand = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const r = parseInt(expand.substring(0, 2), 16);
  const g = parseInt(expand.substring(2, 4), 16);
  const b = parseInt(expand.substring(4, 6), 16);
  // Perceived luminance; > 0.6 means the bg is light enough that black reads
  // better than white.
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#000000' : '#FFFFFF';
}

/** Off-state track color for a `Switch`. The default RN off-track is a
 *  faint border tone — on light themes that reads as a near-invisible
 *  light-tan track + white thumb on a near-white surface, so you can't
 *  tell the toggle is off (or there at all). `textMuted` is a mid-tone
 *  that contrasts with both the surface and the white thumb on every
 *  theme, light or dark. Pair with the default (white) thumb. */
export function toggleOffTrack(colors: ThemeColors): string {
  return colors.textMuted;
}

export const colors = APP_THEMES[DEFAULT_THEME_NAME].colors;

export function getTheme(themeName?: AppThemeName | string): AppTheme {
  return APP_THEMES[resolveThemeName(themeName)];
}

// ─── Layout tokens ─────────────────────────────────────────────────────────
//
// Use these for every padding / margin / borderRadius value. Inline magic
// numbers (`padding: 14`, `borderRadius: 7`) are the reason themes and
// dynamic-type sizing look inconsistent across the app — they don't scale
// with the design system. When you genuinely need an in-between value,
// add a token here rather than inline.
//
// `pill` is the canonical "fully rounded" value for chips, badges, and
// progress bars; using `full` (999) on small components renders the same
// but `pill` reads more intentional in code review.

export const radius = {
  none: 0,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  pill: 999,
  full: 999,
} as const;

export const spacing = {
  none: 0,
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

/** Hit-slop preset — meets Apple's 44pt touch target on chips/icons that
 *  render smaller than 44pt visually. Spread onto any TouchableOpacity
 *  whose visible area is under 32pt. */
export const hitSlop = {
  // Use for icon-only buttons (close X, swap arrows, info ⓘ).
  icon: { top: 12, bottom: 12, left: 12, right: 12 },
  // Use for compact chips / inline links.
  chip: { top: 8, bottom: 8, left: 8, right: 8 },
} as const;

const FONT_SANS = Platform.select({
  ios: 'Avenir Next',
  android: 'sans-serif',
  default: 'System',
});

const FONT_SANS_MEDIUM = Platform.select({
  ios: 'Avenir Next',
  android: 'sans-serif-medium',
  default: 'System',
});

const FONT_SANS_BOLD = Platform.select({
  ios: 'Avenir Next',
  android: 'sans-serif-bold',
  default: 'System',
});

export const typography = {
  hero: {
    fontFamily: FONT_SANS_BOLD,
    fontSize: 28,
    lineHeight: 32,
    letterSpacing: -0.7,
  } satisfies TextStyle,
  screenTitle: {
    fontFamily: FONT_SANS_BOLD,
    fontSize: 20,
    lineHeight: 24,
    letterSpacing: -0.35,
  } satisfies TextStyle,
  sectionTitle: {
    fontFamily: FONT_SANS_BOLD,
    fontSize: 17,
    lineHeight: 22,
    letterSpacing: -0.25,
  } satisfies TextStyle,
  cardTitle: {
    fontFamily: FONT_SANS_BOLD,
    fontSize: 15,
    lineHeight: 20,
    letterSpacing: -0.15,
  } satisfies TextStyle,
  body: {
    fontFamily: FONT_SANS,
    fontSize: 13,
    lineHeight: 19,
    letterSpacing: 0.05,
  } satisfies TextStyle,
  bodyStrong: {
    fontFamily: FONT_SANS_MEDIUM,
    fontSize: 13,
    lineHeight: 19,
    letterSpacing: 0.05,
  } satisfies TextStyle,
  label: {
    fontFamily: FONT_SANS_MEDIUM,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  } satisfies TextStyle,
  micro: {
    fontFamily: FONT_SANS_MEDIUM,
    fontSize: 10,
    lineHeight: 13,
    letterSpacing: 0.35,
  } satisfies TextStyle,
};

export const elevations = {
  card: {
    shadowColor: '#020617',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.18,
    shadowRadius: 24,
    elevation: 10,
  } satisfies ViewStyle,
  floating: {
    shadowColor: '#020617',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.24,
    shadowRadius: 28,
    elevation: 14,
  } satisfies ViewStyle,
  subtle: {
    shadowColor: '#020617',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.12,
    shadowRadius: 14,
    elevation: 6,
  } satisfies ViewStyle,
};
