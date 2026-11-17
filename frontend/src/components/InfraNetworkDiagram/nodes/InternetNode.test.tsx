import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { NodeProps } from '@xyflow/react';
import { InternetNode } from './InternetNode';

function buildNodeProps(): NodeProps {
  return { id: 'internet', data: {}, selected: false, type: 'internet', dragging: false, zIndex: 0, isConnectable: false, positionAbsoluteX: 0, positionAbsoluteY: 0, draggable: false, selectable: false, deletable: false, width: 140, height: 44 } as unknown as NodeProps;
}

describe('InternetNode', () => {
  it('renders the "Internet" label', () => {
    render(<InternetNode {...buildNodeProps()} />);
    expect(screen.getByText('Internet')).toBeInTheDocument();
  });
});
