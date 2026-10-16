import type { CSSProperties } from 'react';

/** Fixed colors only: persisted settings contain a palette ID, never arbitrary CSS. */
export const ARCHIVE_PALETTES = [
  { id: 'blue', name: 'Blue', accent: '#438cec', light: '#87b5fc', primary: '#347ddd', hover: '#428aed' },
  { id: 'cyan', name: 'Cyan', accent: '#44a9c7', light: '#8acbdf', primary: '#237f9b', hover: '#2c8da9' },
  { id: 'teal', name: 'Teal', accent: '#45ac9d', light: '#8acfc3', primary: '#247e72', hover: '#2d8c7f' },
  { id: 'green', name: 'Green', accent: '#75a96b', light: '#afd0a8', primary: '#4d7f44', hover: '#598d50' },
  { id: 'amber', name: 'Amber', accent: '#c39b54', light: '#dfc18a', primary: '#886522', hover: '#96742d' },
  { id: 'coral', name: 'Coral', accent: '#d08b70', light: '#e5b39f', primary: '#a05d43', hover: '#ae6a50' },
  { id: 'rose', name: 'Rose', accent: '#c684a1', light: '#dfa9bf', primary: '#9c5476', hover: '#aa6183' },
  { id: 'violet', name: 'Violet', accent: '#a18ade', light: '#c3b2ee', primary: '#7b60ba', hover: '#886dc7' },
] as const;
export type ArchivePaletteId = typeof ARCHIVE_PALETTES[number]['id'];
export const DEFAULT_ARCHIVE_PALETTE: ArchivePaletteId = 'blue';
export const isArchivePalette = (value: unknown): value is ArchivePaletteId => typeof value === 'string' && ARCHIVE_PALETTES.some(palette => palette.id === value);
export const getArchivePalette = (id?: string) => ARCHIVE_PALETTES.find(palette => palette.id === id) || ARCHIVE_PALETTES[0];

/** Rotate neutral colors into the palette hue while retaining saturation and lightness. */
function tintedNeutral(hex: string, accent: string, original: boolean) {
  if (original) return hex;
  const rgb = (value: string) => [1, 3, 5].map(offset => parseInt(value.slice(offset, offset + 2), 16) / 255);
  const hueOf = (values: number[]) => {
    const [r, g, b] = values; const max = Math.max(...values); const min = Math.min(...values); const delta = max - min;
    if (!delta) return 0;
    return ((max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60 + 360) % 360;
  };
  const channels = rgb(hex); const max = Math.max(...channels); const min = Math.min(...channels);
  const lightness = (max + min) / 2;
  const saturation = max === min ? 0 : (max - min) / (1 - Math.abs(2 * lightness - 1));
  const hue = hueOf(rgb(accent)) / 60;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs(hue % 2 - 1)); const m = lightness - chroma / 2;
  const colors = hue < 1 ? [chroma, x, 0] : hue < 2 ? [x, chroma, 0] : hue < 3 ? [0, chroma, x] : hue < 4 ? [0, x, chroma] : hue < 5 ? [x, 0, chroma] : [chroma, 0, x];
  return `#${colors.map(channel => Math.round((channel + m) * 255).toString(16).padStart(2, '0')).join('')}`;
}
export function archivePaletteStyle(id?: string): CSSProperties {
  const palette = getArchivePalette(id);
  const tint = (hex: string) => tintedNeutral(hex, palette.accent, palette.id === 'blue');
  return {
    '--accent': palette.accent,
    '--archive-accent-light': palette.light,
    '--archive-primary': palette.primary,
    '--archive-primary-hover': palette.hover,
    '--archive-glow': palette.id === 'blue' ? '#3680e924' : `${palette.accent}24`,
    '--background': tint('#0b0f14'),
    '--foreground': tint('#e4e9ef'),
    '--muted': tint('#141d26'),
    '--muted-foreground': tint('#98a3af'),
    '--border': tint('#222b35'),
    '--archive-page-top': tint('#0d1116'),
    '--archive-pane': tint('#141d26'),
    '--archive-pane-deep': tint('#10171e'),
    '--archive-pane-hover': tint('#172432'),
    '--archive-pane-hover-deep': tint('#121d27'),
    '--archive-field': tint('#0a1017'),
    '--archive-menu': tint('#111a24'),
    '--archive-edge': tint('#303c4d'),
    '--archive-secondary': tint('#c2ccd6'),
    '--archive-faint': tint('#74808e'),
    '--archive-heading': tint('#edf1f5'),
  } as CSSProperties;
}
