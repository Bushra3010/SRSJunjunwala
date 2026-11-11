/**
 * Card colours derived from the logo (forest green + wheat gold), extended with
 * clearly different, harmonious hues so neighbouring cards never share a colour.
 * Assign in order (or with `rot(i)`) — consecutive entries are always distinct.
 */
export const C = {
  green: "#1f6b32", // logo forest green
  gold: "#c08a24", // logo wheat gold
  blue: "#3e6fc0", // steel blue
  terracotta: "#b5532f",
  teal: "#1f7f86",
  plum: "#7b4f8e",
  olive: "#6f7d1e",
  slate: "#4b5563",
} as const;

export const ROTATION = [C.green, C.gold, C.blue, C.terracotta, C.teal, C.plum, C.olive, C.slate] as const;

/** Colour for the i-th item in a list or grid; never repeats for 8 consecutive items. */
export function rot(i: number, offset = 0): string {
  return ROTATION[(i + offset) % ROTATION.length]!;
}
