/**
 * Button color palette — applies button color tokens to CSS custom properties.
 * Called from appearance-settings and app-settings initialization.
 */

export interface ButtonPalette {
  primaryBg: string;
  primaryColor: string;
  primaryBorder: string;
  secondaryBg: string;
  secondaryColor: string;
  secondaryBorder: string;
  ghostColor: string;
  ghostHoverColor: string;
  ghostHoverBg: string;
  dangerBg: string;
  dangerColor: string;
  dangerBorder: string;
}

export const DEFAULT_PALETTE: ButtonPalette = {
  primaryBg: "#1870c9",
  primaryColor: "#ffffff",
  primaryBorder: "#1870c9",
  secondaryBg: "#f1f3f5",
  secondaryColor: "#3c3c43",
  secondaryBorder: "#e5e5ea",
  ghostColor: "#3c3c43",
  ghostHoverColor: "#265f99",
  ghostHoverBg: "#eceef0",
  dangerBg: "#b91c1c",
  dangerColor: "#ffffff",
  dangerBorder: "#b91c1c",
};

const TOKEN_MAP: Record<keyof ButtonPalette, string> = {
  primaryBg: "--btn-primary-bg",
  primaryColor: "--btn-primary-color",
  primaryBorder: "--btn-primary-border",
  secondaryBg: "--btn-secondary-bg",
  secondaryColor: "--btn-secondary-color",
  secondaryBorder: "--btn-secondary-border",
  ghostColor: "--btn-ghost-color",
  ghostHoverColor: "--btn-ghost-hover-color",
  ghostHoverBg: "--btn-ghost-hover-bg",
  dangerBg: "--btn-danger-bg",
  dangerColor: "--btn-danger-color",
  dangerBorder: "--btn-danger-border",
};

export function applyButtonPalette(palette: Partial<ButtonPalette>, replace = false) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const [key, cssVar] of Object.entries(TOKEN_MAP)) {
    const value = palette[key as keyof ButtonPalette];
    if (value !== undefined) {
      root.style.setProperty(cssVar, value);
    } else if (replace) {
      root.style.removeProperty(cssVar);
    }
  }
}

/** Retain the chosen hue while making white labels readable on filled controls. */
export function primaryFill(accent: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(accent)) return DEFAULT_PALETTE.primaryBg;
  const rgb = [1, 3, 5].map(start => parseInt(accent.slice(start, start + 2), 16));
  for (let step = 0; step <= 100; step++) {
    const channels = rgb.map(channel => Math.round(channel * (1 - step / 100)));
    const linear = channels.map(channel => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    if (1.05 / (0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2] + 0.05) >= 4.6) {
      return '#' + channels.map(channel => channel.toString(16).padStart(2, '0')).join('');
    }
  }
  return DEFAULT_PALETTE.primaryBg;
}
