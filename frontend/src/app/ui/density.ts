/**
 * Font density utility — applies compact/standard/comfortable scaling to
 * typography and spacing CSS custom properties.
 */
export type Density = 'compact' | 'standard' | 'comfortable';

const DENSITY_SCALES: Record<Density, number> = {
  compact: 0.85,
  standard: 1.0,
  comfortable: 1.15,
};

const BASE_SIZES = {
  '--text-xs': 11,
  '--text-sm': 12,
  '--text-base': 13,
  '--text-md': 14,
  '--text-lg': 16,
  '--text-xl': 18,
  '--text-2xl': 22,
} as const;

const BASE_SPACING = {
  '--space-xs': 4,
  '--space-sm': 8,
  '--space-md': 12,
  '--space-lg': 16,
  '--space-xl': 24,
} as const;

export function applyDensity(density: Density) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const scale = DENSITY_SCALES[density];

  for (const [prop, base] of Object.entries(BASE_SIZES)) {
    root.style.setProperty(prop, `${Math.round(base * scale)}px`);
  }
  for (const [prop, base] of Object.entries(BASE_SPACING)) {
    root.style.setProperty(prop, `${Math.round(base * scale)}px`);
  }

  root.dataset.density = density;
}
