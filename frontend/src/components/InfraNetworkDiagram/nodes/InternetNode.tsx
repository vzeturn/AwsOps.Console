import type { NodeProps } from '@xyflow/react';
import Box from '@cloudscape-design/components/box';
import Icon from '@cloudscape-design/components/icon';

/**
 * `InternetNode` — React Flow custom node type `'internet'`. The synthetic node id
 * `INTERNET_NODE_ID` (`shared/src/index.ts`) is the source of every `ingress-from` edge — reused
 * verbatim from the old hand-built `InternetNode` JSX, no behavior change.
 */
export function InternetNode(_props: NodeProps) {
  return (
    <div
      style={{
        border: '1px solid #f59e0b',
        borderRadius: 20,
        padding: '8px 18px',
        background: 'rgba(245, 158, 11, 0.12)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
      }}
    >
      <Icon name="globe" size="small" />
      <Box fontWeight="bold" fontSize="body-s">
        Internet
      </Box>
    </div>
  );
}
