/** Default blue measured from the approved prototype's text. */
export const DEFAULT_ACCENT_COLOR = "#265f99";

/** Choose the higher-contrast foreground for an accent-filled control. */
export function accentForeground(hex: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return "#ffffff";
  const channels = [1, 3, 5].map(offset => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return (luminance + 0.05) / 0.05 > 1.05 / (luminance + 0.05) ? "#000000" : "#ffffff";
}
