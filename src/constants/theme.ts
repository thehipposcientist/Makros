export type AppThemeName =
  | 'midnight' | 'ocean'    | 'amethyst' | 'scarlet'
  | 'ember'    | 'wine'     | 'obsidian'
  | 'blossom'  | 'void'     | 'dusk'     | 'lavender' | 'aurora'
  | 'sunrise'  | 'parchment'| 'linen'    | 'mint'
  | 'butter'   | 'seaglass' | 'lilac'    | 'sky'
  | 'slate'    | 'ash'      | 'cosmos'
  | 'cinder'   | 'smoke'    | 'maroon'
  | 'rose';

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
    ai: SectionPalette;
    planner: SectionPalette;
    account: SectionPalette;
  };
}

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
    description: 'Pitch-black with teal primary — the clean dark default.',
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
      textMuted:     '#687388',
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
      textMuted:     '#4C7090',
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
      primary:       '#9838F8',
      primaryDark:   '#7020C8',
      primaryLight:  '#C888FF',
      accent:        '#28E8C0',
      textPrimary:   '#F0E8FF',
      textSecondary: '#B098D8',
      textMuted:     '#706890',
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
      textMuted:     '#907060',
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

  wine: {
    name: 'wine',
    label: 'Merlot Dark',
    description: 'Blood-red background with crimson primary and dusty gold — brooding and mature.',
    colors: {
      background:    '#100608',
      surface:       '#1C0B10',
      surfaceRaised: '#2A1018',
      border:        '#461828',
      primary:       '#C82848',
      primaryDark:   '#9A1830',
      primaryLight:  '#E87898',
      accent:        '#D0A040',
      textPrimary:   '#F8EEF0',
      textSecondary: '#C898A8',
      textMuted:     '#886070',
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
      textMuted:     '#706850',
      error:         '#CC3838',
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

  // ── DARK / VIVID ─────────────────────────────────────────────────────────────

  scarlet: {
    name: 'scarlet',
    label: 'Scarlet Rush',
    description: 'Vivid performance red on neutral dark — bold, sporty, nothing subtle about it.',
    colors: {
      background:    '#0A0808',
      surface:       '#141010',
      surfaceRaised: '#1E1414',
      border:        '#3C1818',
      primary:       '#FF2020',
      primaryDark:   '#CC0000',
      primaryLight:  '#FF8888',
      accent:        '#0088FF',
      textPrimary:   '#FFF8F8',
      textSecondary: '#CCA8A8',
      textMuted:     '#886868',
      error:         '#FF4444',
      warning:       '#FFCC00',
      success:       '#40CC60',
    },
    sections: {
      workout: { soft: '#2C0808', strong: '#FF2020', text: '#FF9898' },
      meals:   { soft: '#082038', strong: '#0088FF', text: '#88C8FF' },
      ai:      { soft: '#0C0C1E', strong: '#6060C0', text: '#A8A8F0' },
      planner: { soft: '#1E1808', strong: '#FFCC00', text: '#FFF080' },
      account: { soft: '#220808', strong: '#FF4040', text: '#FFA0A0' },
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
      primary:       '#F07848',
      primaryDark:   '#C05828',
      primaryLight:  '#F8A880',
      accent:        '#40C8D0',
      textPrimary:   '#E8F4FF',
      textSecondary: '#A8C0D8',
      textMuted:     '#6888A8',
      error:         '#FF5058',
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
      textMuted:     '#906880',
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
      textMuted:     '#666666',
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
      textMuted:     '#686080',
      error:         '#E85050',
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
      textMuted:     '#706488',
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
      textMuted:     '#506878',
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
      primary:       '#F28C28',
      primaryDark:   '#D46F0A',
      primaryLight:  '#FBC98C',
      accent:        '#D96C8B',
      textPrimary:   '#402A1E',
      textSecondary: '#75584A',
      textMuted:     '#A2806D',
      error:         '#D64545',
      warning:       '#D99A00',
      success:       '#2F9E66',
    },
    sections: {
      workout: { soft: '#DDEEFF', strong: '#3A82CC', text: '#1A4A88' },
      meals:   { soft: '#D8F0E0', strong: '#2A9E58', text: '#0E5028' },
      ai:      { soft: '#EAE0FF', strong: '#6848C8', text: '#2A1080' },
      planner: { soft: '#F5E8C9', strong: '#B98A22', text: '#6F5211' },
      account: { soft: '#FFE8EC', strong: '#D96C8B', text: '#8A1E38' },
    },
  },

  // ── LIGHT / NEUTRAL ──────────────────────────────────────────────────────────

  parchment: {
    name: 'parchment',
    label: 'Parchment & Bark',
    description: 'Clean white background with warm coffee-brown primary — natural, calm, and earthy.',
    colors: {
      background:    '#FAF7F4',
      surface:       '#FFFFFF',
      surfaceRaised: '#F0EAE2',
      border:        '#D8C8B8',
      primary:       '#7C4F2A',
      primaryDark:   '#5A3418',
      primaryLight:  '#B08A60',
      accent:        '#C07830',
      textPrimary:   '#2A1E14',
      textSecondary: '#6A4E38',
      textMuted:     '#A08870',
      error:         '#C43030',
      warning:       '#B87800',
      success:       '#307848',
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
      primary:       '#6A8030',
      primaryDark:   '#4A5A1A',
      primaryLight:  '#9CB058',
      accent:        '#B85830',
      textPrimary:   '#1E2410',
      textSecondary: '#4C5A34',
      textMuted:     '#8A9468',
      error:         '#B8342C',
      warning:       '#B07020',
      success:       '#3A7A48',
    },
    sections: {
      workout: { soft: '#E8F0D4', strong: '#6A8030', text: '#2A4010' },
      meals:   { soft: '#F5E4D4', strong: '#B85830', text: '#5A2010' },
      ai:      { soft: '#E4E8F0', strong: '#4868A8', text: '#18306E' },
      planner: { soft: '#F4ECD4', strong: '#A88434', text: '#5E4414' },
      account: { soft: '#EDE4F4', strong: '#6A508C', text: '#30205E' },
    },
  },

  mint: {
    name: 'mint',
    label: 'Mint Fresh',
    description: 'Pale mint background with deep teal primary and coral accent — clean, cool, refreshing.',
    colors: {
      background:    '#EDF8F2',
      surface:       '#FFFFFF',
      surfaceRaised: '#DCEFE4',
      border:        '#B4D8C4',
      primary:       '#0E8078',
      primaryDark:   '#065850',
      primaryLight:  '#48B8A8',
      accent:        '#E06848',
      textPrimary:   '#082418',
      textSecondary: '#2C5244',
      textMuted:     '#5A7868',
      error:         '#CC2E3C',
      warning:       '#B87800',
      success:       '#1A8A54',
    },
    sections: {
      workout: { soft: '#C8ECE0', strong: '#0E8078', text: '#033630' },
      meals:   { soft: '#FFE4D8', strong: '#E06848', text: '#6A1C08' },
      ai:      { soft: '#E4E4F8', strong: '#5848CC', text: '#1C0C6A' },
      planner: { soft: '#FFF0C8', strong: '#B87800', text: '#5A3C00' },
      account: { soft: '#F8E0EC', strong: '#C0347C', text: '#5A0838' },
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
      primary:       '#C07608',
      primaryDark:   '#8A5404',
      primaryLight:  '#E8A840',
      accent:        '#2A5E8C',
      textPrimary:   '#2A1F04',
      textSecondary: '#5A4218',
      textMuted:     '#8A7446',
      error:         '#C42030',
      warning:       '#AE7400',
      success:       '#2A8048',
    },
    sections: {
      workout: { soft: '#FBE8A8', strong: '#C07608', text: '#4A2C04' },
      meals:   { soft: '#DCEEF8', strong: '#2A5E8C', text: '#0A2438' },
      ai:      { soft: '#F0E0F8', strong: '#8A3AC0', text: '#2E0A4A' },
      planner: { soft: '#FFE8D0', strong: '#C25818', text: '#4A1C04' },
      account: { soft: '#FAE4CC', strong: '#A04818', text: '#3C1806' },
    },
  },

  seaglass: {
    name: 'seaglass',
    label: 'Crimson',
    description: 'Pale rose background with deep crimson primary and warm gold accent — bold, energetic, light.',
    colors: {
      background:    '#FCEEEC',
      surface:       '#FFFFFF',
      surfaceRaised: '#F7DCD8',
      border:        '#E0A8A0',
      primary:       '#B5202A',
      primaryDark:   '#8A0A1A',
      primaryLight:  '#E26068',
      accent:        '#C68A18',
      textPrimary:   '#2A0606',
      textSecondary: '#5C1818',
      textMuted:     '#8A5050',
      error:         '#9A2820',
      warning:       '#B07820',
      success:       '#1A8058',
    },
    sections: {
      workout: { soft: '#F4D0CC', strong: '#B5202A', text: '#2A0606' },
      meals:   { soft: '#F8E2BC', strong: '#C68A18', text: '#4A2E04' },
      ai:      { soft: '#DFE0FA', strong: '#4A4ACC', text: '#0E0E58' },
      planner: { soft: '#F9DCD2', strong: '#D04830', text: '#4A0A0A' },
      account: { soft: '#F4E0E4', strong: '#B5202A', text: '#2A0606' },
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
      textMuted:     '#806A98',
      error:         '#C42848',
      warning:       '#B87000',
      success:       '#2A8048',
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
      primary:       '#0E7AB8',
      primaryDark:   '#075280',
      primaryLight:  '#4FB0E0',
      accent:        '#E06840',
      textPrimary:   '#08202C',
      textSecondary: '#285468',
      textMuted:     '#5C8090',
      error:         '#CC2E3C',
      warning:       '#B87800',
      success:       '#1A8A54',
    },
    sections: {
      workout: { soft: '#CCE6F2', strong: '#0E7AB8', text: '#08303C' },
      meals:   { soft: '#F8DCD0', strong: '#E06840', text: '#5A1808' },
      ai:      { soft: '#E0E0F8', strong: '#4040C8', text: '#101058' },
      planner: { soft: '#F8ECC8', strong: '#B07820', text: '#503808' },
      account: { soft: '#D0EDE8', strong: '#1A8888', text: '#063030' },
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
      primary:       '#C04870',
      primaryDark:   '#903050',
      primaryLight:  '#E888A8',
      accent:        '#C89040',
      textPrimary:   '#1E0A10',
      textSecondary: '#5A2838',
      textMuted:     '#9A6878',
      error:         '#C42030',
      warning:       '#B07800',
      success:       '#1A8A54',
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
      textMuted:     '#786858',
      error:         '#FF4848',
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
      textMuted:     '#5060A0',
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
      primary:       '#FF2898',
      primaryDark:   '#C80070',
      primaryLight:  '#FF80CC',
      accent:        '#20E890',
      textPrimary:   '#F2F4F8',
      textSecondary: '#A0AABB',
      textMuted:     '#606878',
      error:         '#F04858',
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
      textMuted:     '#507080',
      error:         '#F05870',
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
      textMuted:     '#806070',
      error:         '#F04850',
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

};

export const colors = APP_THEMES.slate.colors;

export function getTheme(themeName?: AppThemeName | string): AppTheme {
  return (APP_THEMES as Record<string, AppTheme>)[themeName ?? 'slate'] ?? APP_THEMES.slate;
}

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  full: 999,
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
} as const;
