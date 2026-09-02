function hashBytes(input: string): number[] {
  let h = 0x811c9dc5;
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  for (let i = 0; i < 32; i++) {
    h ^= i;
    h = Math.imul(h, 0x01000193);
    bytes.push((h >>> 0) & 0xff);
  }
  return bytes;
}

export function agentIdenticon(seed: string): boolean[][] {
  const bytes = hashBytes(seed);
  const grid: boolean[][] = [];
  for (let row = 0; row < 5; row++) {
    const r: boolean[] = [];
    for (let col = 0; col < 3; col++) {
      const idx = row * 3 + col;
      r.push(((bytes[4 + Math.floor(idx / 8)] >> (idx % 8)) & 1) === 1);
    }
    grid.push([r[0], r[1], r[2], r[1], r[0]]);
  }
  return grid;
}

// Hue 160-220 (cyan-blue), vary saturation 60-85% and lightness for distinction
// Dark mode: lightness 58-72% for readability on dark backgrounds
// Light mode: lightness 38-48% for contrast on light backgrounds
function agentHsl(seed: string): { hue: number; sat: number; lightDark: number; lightLight: number } {
  const bytes = hashBytes(seed);
  const hue = 160 + (((bytes[0] << 8) | bytes[1]) % 61);
  const sat = 60 + (bytes[2] % 26);
  const lightDark = 58 + (bytes[3] % 15);
  const lightLight = 38 + (bytes[3] % 11);
  return { hue, sat, lightDark, lightLight };
}

export function agentColor(seed: string): string {
  const { hue, sat, lightDark } = agentHsl(seed);
  return `hsl(${hue}, ${sat}%, ${lightDark}%)`;
}

export function agentColorLight(seed: string): string {
  const { hue, sat, lightLight } = agentHsl(seed);
  return `hsl(${hue}, ${sat}%, ${lightLight}%)`;
}

function hslToRgb(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255);
  };
  return `${f(0)}, ${f(8)}, ${f(4)}`;
}

export function agentColorRgb(seed: string): string {
  const { hue, sat, lightDark } = agentHsl(seed);
  return hslToRgb(hue, sat, lightDark);
}
