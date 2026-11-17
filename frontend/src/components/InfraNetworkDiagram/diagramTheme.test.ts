import { describe, it, expect } from 'vitest';
import { TIER_ACCENT, EDGE_STYLE } from './diagramTheme';

/**
 * Requirement 2.3 regression guard: computes the REAL WCAG relative-luminance contrast ratio
 * (the same formula browsers/contrast-checker tools use, not an approximation) for every
 * `TIER_ACCENT`/`EDGE_STYLE` color against the Diagram_Canvas's actual rendered background in
 * BOTH themes — `#ffffff` (light) / `#161d26` (dark), the real compiled values of
 * `--awsui-color-background-container-content` confirmed by reading a `vite build` output (see
 * `diagramTheme.ts`'s own top-of-file comment). If a future edit changes one of these colors
 * without re-verifying contrast, this test catches it rather than only a manual visual check.
 */
function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  return [parseInt(clean.slice(0, 2), 16), parseInt(clean.slice(2, 4), 16), parseInt(clean.slice(4, 6), 16)];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const srgb = c / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(hexA: string, hexB: string): number {
  const lumA = relativeLuminance(hexA);
  const lumB = relativeLuminance(hexB);
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

const LIGHT_CANVAS_BG = '#ffffff'; // --awsui-color-background-container-content, light mode
const DARK_CANVAS_BG = '#161d26'; // --awsui-color-background-container-content, dark mode
const MIN_CONTRAST = 3.0; // WCAG 1.4.11 non-text contrast minimum, per Requirement 2.3

describe('diagramTheme contrast (Requirement 2.3)', () => {
  it.each(Object.entries(TIER_ACCENT))('TIER_ACCENT.%s clears 3:1 against both light and dark canvas background', (_tier, hex) => {
    expect(contrastRatio(hex, LIGHT_CANVAS_BG)).toBeGreaterThanOrEqual(MIN_CONTRAST);
    expect(contrastRatio(hex, DARK_CANVAS_BG)).toBeGreaterThanOrEqual(MIN_CONTRAST);
  });

  it.each(Object.entries(EDGE_STYLE))('EDGE_STYLE.%s.stroke clears 3:1 against both light and dark canvas background', (_kind, style) => {
    expect(contrastRatio(style.stroke, LIGHT_CANVAS_BG)).toBeGreaterThanOrEqual(MIN_CONTRAST);
    expect(contrastRatio(style.stroke, DARK_CANVAS_BG)).toBeGreaterThanOrEqual(MIN_CONTRAST);
  });
});
