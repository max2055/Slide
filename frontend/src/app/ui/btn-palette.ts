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
  primaryBg: "#7c5cff",
  primaryColor: "#ffffff",
  primaryBorder: "#7c5cff",
  secondaryBg: "#f1f3f5",
  secondaryColor: "#3c3c43",
  secondaryBorder: "#e5e5ea",
  ghostColor: "#6e6e73",
  ghostHoverColor: "#7c5cff",
  ghostHoverBg: "#eceef0",
  dangerBg: "#f87171",
  dangerColor: "#ffffff",
  dangerBorder: "#f87171",
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

export function applyButtonPalette(palette: Partial<ButtonPalette>) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const [key, cssVar] of Object.entries(TOKEN_MAP)) {
    const value = palette[key as keyof ButtonPalette];
    if (value !== undefined) {
      root.style.setProperty(cssVar, value);
    }
  }
}
