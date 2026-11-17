import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { TopologyEdge } from '@ops-dashboard/shared';
import { DiagramLegend } from './DiagramLegend';
import { EDGE_STYLE, EDGE_LABEL } from './diagramTheme';

describe('DiagramLegend', () => {
  it('renders a label for every edge kind', () => {
    render(<DiagramLegend />);
    for (const kind of Object.keys(EDGE_LABEL) as TopologyEdge['kind'][]) {
      expect(screen.getByText(EDGE_LABEL[kind])).toBeInTheDocument();
    }
  });

  it('Requirement 2.4: every edge kind has a distinguishable dash pattern except at most one solid line, not color alone', () => {
    const kinds = Object.keys(EDGE_STYLE) as TopologyEdge['kind'][];
    const dashPatterns = kinds.map((kind) => EDGE_STYLE[kind].dash);
    const solidCount = dashPatterns.filter((d) => !d).length;
    const dashedPatterns = dashPatterns.filter((d): d is string => Boolean(d));

    // At most one kind may be solid (the "primary" undashed line) — every other kind must have
    // its OWN dash pattern, and no two dashed kinds may share the identical pattern (otherwise
    // they'd be indistinguishable from each other under a grayscale/colorblind simulation).
    expect(solidCount).toBeLessThanOrEqual(1);
    expect(new Set(dashedPatterns).size).toBe(dashedPatterns.length);
  });

  it('renders each edge kind swatch with its configured stroke color and dash pattern', () => {
    const { container } = render(<DiagramLegend />);
    const lines = container.querySelectorAll('svg line');
    const kinds = Object.keys(EDGE_LABEL) as TopologyEdge['kind'][];
    expect(lines).toHaveLength(kinds.length);
    lines.forEach((line, index) => {
      const kind = kinds[index];
      expect(line.getAttribute('stroke')).toBe(EDGE_STYLE[kind].stroke);
      if (EDGE_STYLE[kind].dash) {
        expect(line.getAttribute('stroke-dasharray')).toBe(EDGE_STYLE[kind].dash);
      }
    });
  });
});
