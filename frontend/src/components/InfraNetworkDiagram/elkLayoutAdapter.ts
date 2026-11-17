// `elkjs/lib/elk-api` (NOT the package's main `elkjs` entry) is used here — this took THREE
// corrections during implementation to land on, each caught by an actual failure rather than by
// re-reading docs more carefully, so the full story is worth keeping:
//
// 1. `elkjs/lib/elk-api.js`'s constructor unconditionally throws "Cannot construct an ELK without
//    both 'workerUrl' and 'workerFactory'" if NEITHER is given — so it always needs one supplied
//    explicitly (see the `elk` instance below).
// 2. The package's MAIN entry (`elkjs`, i.e. `lib/main.js`) was tried next specifically because
//    ITS constructor treats `workerUrl` as optional (falls back to a synchronous in-process layout
//    via a statically bundled copy of `elk-worker.min.js`). That worked functionally, but
//    `lib/main.js` ALSO does `require('web-worker')` — resolved at BUILD time by Vite 8's Rolldown
//    bundler rather than deferred to its own runtime try/catch — so the package had to be
//    installed as a real dependency (`package.json`) just to make `vite build` succeed at all.
// 3. Once the build succeeded, the ACTUAL production bundle was inspected (`dist/assets/infra-map-*.js`),
//    which is what caught the real problem: `lib/main.js`'s synchronous fallback path statically
//    `require()`s `elk-worker.min.js` (the ~1.5MB GWT-transpiled layout algorithm) directly into
//    the main chunk, in ADDITION to this module's own `workerUrl: new URL('elkjs/lib/elk-worker.min.js', ...)`
//    creating a SECOND, separately-chunked copy of the exact same file for the real-Worker path
//    that a real browser (which always has `Worker`) actually uses. The synchronous fallback code
//    is realistically dead weight for every actual user, yet was being shipped anyway.
//
// The fix: `elk-api.js` has ZERO static `require()` of `elk-worker.min.js` or `web-worker` — it
// only takes whatever `workerFactory`/`workerUrl` is explicitly given, so nothing gets bundled
// that isn't asked for. `workerUrl` (real browser Worker) is used unconditionally for the actual
// app; the ONLY place a no-Worker fallback is needed at all is Vitest's jsdom test environment
// (which has no `Worker` global) — handled by `elkLayoutAdapter.test.ts` relying on `elkjs`'s own
// main-entry package instead, kept OUT of this module's own import graph so it can never reach a
// production bundle (see the test file's own import).
import ELK from 'elkjs/lib/elk-api';
import type { Node, Edge } from '@xyflow/react';
import {
  INTERNET_NODE_ID,
  type TopologyEdge,
  type TopologyResource,
  type TopologyVpc,
} from '@ops-dashboard/shared';

/**
 * `elkLayoutAdapter.ts` — the ONE module that knows how to turn one VPC's structure into on-screen
 * positions, using `elkjs`'s `layered` (Sugiyama) algorithm. Deliberately pure and DOM-free (no
 * React, no `document`, no measured `getBoundingClientRect`) so it is unit-testable without
 * rendering anything — see `elkLayoutAdapter.test.ts`.
 *
 * WHY ELK, NOT DAGRE (infra-map-redesign spec, Requirement 3 / design.md's "Library choice
 * record"): Dagre has an open, documented bug that mis-lays-out a sub-flow (a node with a
 * `parentId`) when that node ALSO has an edge leaving the sub-flow to a node outside it — exactly
 * this account's real edge shape (`balances-to`: a resource inside a subnet -> an internet/ALB
 * node outside it; `egress-via`: a resource inside a subnet -> a NAT gateway that may sit in a
 * different subnet). ELK is the only one of the layouting libraries React Flow's own docs compare
 * that supports dynamic node sizes + sub-flow layout + edge routing all at once.
 *
 * WHY A WEB WORKER (Requirement 3.4): `elkjs`'s layout computation is synchronous JS by default —
 * for a large topology this would block the main thread and freeze the UI while computing.
 * `workerUrl` is elkjs's own documented mechanism for offloading that computation; if the worker
 * script fails to load for any reason, elkjs falls back to synchronous execution with a console
 * warning rather than throwing (elkjs's own documented behavior) — a graceful degradation, not a
 * silent gap.
 */

// One shared ELK instance for the module's lifetime (matches elkjs's own recommended usage — the
// constructor is cheap to keep around, expensive to recreate per layout call). `elk-api.js`'s
// constructor REQUIRES `workerUrl` or `workerFactory` — always supplying `workerUrl` here means
// this module never statically references `elk-worker.min.js` itself (no `require`/`import` of
// it anywhere in this file), so Rolldown has nothing to inline into the production chunk; the
// browser only ever fetches that ~1.5MB algorithm payload lazily, from this URL, if and when a
// layout actually runs.
//
// Constructed LAZILY (inside `getDefaultElk()`, on first use) rather than eagerly at module-scope
// — `new ELK({ workerUrl })` calls `elk-api.js`'s own default factory, `new Worker(url)`,
// synchronously INSIDE the constructor itself. Vitest's jsdom environment has no real `Worker`
// global, so an eager module-scope `const elk = new ELK(...)` would throw `ReferenceError: Worker
// is not defined` the instant this module is IMPORTED — before `elkLayoutAdapter.test.ts` even
// gets a chance to pass its own test-only instance into `computeVpcLayout`. Laziness means merely
// importing this module is side-effect-free; only actually calling `computeVpcLayout` without an
// explicit override touches the real constructor, at which point a real browser (this module's
// only actual runtime target) always has `Worker`.
let defaultElk: InstanceType<typeof ELK> | undefined;
function getDefaultElk(): InstanceType<typeof ELK> {
  if (!defaultElk) {
    defaultElk = new ELK({ workerUrl: new URL('elkjs/lib/elk-worker.min.js', import.meta.url).toString() });
  }
  return defaultElk;
}

/** ELK's own layout options for the `layered` algorithm — `RIGHT` direction reads naturally for a
 * "internet -> VPC -> subnet -> resource" flow (left-to-right, matching how this account's
 * `balances-to`/`egress-via`/`ingress-from` edges conceptually flow), `hierarchyHandling:
 * INCLUDE_CHILDREN` is REQUIRED (not the default `SEPARATE_CHILDREN`) specifically so that an edge
 * crossing a subnet boundary (Requirement 3.3's case) is routed correctly relative to the OTHER
 * subnet's box, not laid out as if the two subnets were unrelated separate graphs. */
const BASE_LAYOUT_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  'elk.spacing.nodeNode': '32',
  'elk.layered.spacing.nodeNodeBetweenLayers': '64',
  'elk.spacing.edgeNode': '24',
  'elk.spacing.edgeEdge': '12',
  'elk.padding': '[top=48,left=24,bottom=24,right=24]',
  'elk.edgeRouting': 'ORTHOGONAL',
};

const SUBNET_PADDING = '[top=40,left=16,bottom=16,right=16]';

// Node sizing constants — replaces the old hardcoded `minWidth: 150` (Requirement 5.1). ELK needs
// concrete width/height BEFORE layout runs (it does not measure DOM, per elkjs's own documented
// model), so these are deliberate estimates matching the rendered chip's actual font/padding
// budget, not arbitrary numbers.
const RESOURCE_NODE_HEIGHT = 56;
const RESOURCE_CHAR_WIDTH_PX = 7.2; // `variant="samp"` monospace at body-s size, measured empirically against Cloudscape's own font stack.
const RESOURCE_NODE_MIN_WIDTH = 150;
const RESOURCE_NODE_MAX_WIDTH = 260;
const RESOURCE_NODE_CHROME_WIDTH = 56; // icon + gaps + padding, everything in the chip besides the name text itself.

const SUBNET_HEADER_HEIGHT = 64; // name + tier badge + CIDR/AZ/IP-count line, above the resource grid.
const SUBNET_MIN_WIDTH = 220;

const INTERNET_NODE_WIDTH = 140;
const INTERNET_NODE_HEIGHT = 44;

/**
 * Estimates a Resource_Node's on-canvas width from its display name's length (Requirement 5.1) —
 * replaces the old flat `minWidth: 150`, which had no relationship to the actual text and could
 * either waste space (a short name like `natgw-1`) or overflow (a full EC2 instance id, ~20
 * characters). Clamped so a pathologically long name truncates (with the existing `Popover`
 * tooltip as the accessible full-text affordance, per design.md) rather than producing an
 * unboundedly wide node that would distort the whole layout.
 */
export function estimateResourceNodeWidth(name: string): number {
  const textWidth = Math.ceil(name.length * RESOURCE_CHAR_WIDTH_PX) + RESOURCE_NODE_CHROME_WIDTH;
  return Math.min(RESOURCE_NODE_MAX_WIDTH, Math.max(RESOURCE_NODE_MIN_WIDTH, textWidth));
}

interface ElkEdgeInput {
  id: string;
  sources: string[];
  targets: string[];
}

interface ElkNodeInput {
  id: string;
  width: number;
  height: number;
  layoutOptions?: Record<string, string>;
  children?: ElkNodeInput[];
  /** Only ever present on the synthetic root node (design.md: edges are declared once, at the
   * root, referencing node ids anywhere in the tree — ELK's own documented model for cross-
   * hierarchy edges, rather than nesting an edge inside whichever node happens to be its source). */
  edges?: ElkEdgeInput[];
}

interface ElkLayoutResultNode {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  children?: ElkLayoutResultNode[];
}

export interface VpcLayoutInput {
  vpc: TopologyVpc;
  resourcesBySubnet: Map<string, TopologyResource[]>;
  /** Every edge in the topology (not pre-filtered) — this function filters to the ones whose BOTH
   * endpoints exist in this VPC's node set plus the synthetic `internet` node, mirroring the old
   * `DiagramCanvas`'s "only draw an edge when both ends are mounted" behavior (design.md). */
  edges: TopologyEdge[];
}

export interface VpcLayoutResult {
  nodes: Node[];
  edges: Edge[];
}

function subnetNodeId(subnetId: string): string {
  return `subnet:${subnetId}`;
}

/** Builds the ELK input graph for one VPC: `vpc -> subnet children -> resource grandchildren`,
 * plus the synthetic `internet` node as a top-level sibling of the VPC (an edge FROM the internet
 * node into a public-subnet resource is exactly Requirement 3.3's cross-boundary case: the
 * internet node is OUTSIDE every subnet, by definition). */
function buildElkGraph(input: VpcLayoutInput): { graph: ElkNodeInput; relevantEdges: TopologyEdge[] } {
  const { vpc, resourcesBySubnet } = input;

  const subnetChildren: ElkNodeInput[] = vpc.subnets.map((subnet) => {
    const resources = resourcesBySubnet.get(subnet.subnetId) ?? [];
    const resourceChildren: ElkNodeInput[] = resources.map((resource) => ({
      id: resource.id,
      width: estimateResourceNodeWidth(resource.name),
      height: RESOURCE_NODE_HEIGHT,
    }));

    return {
      id: subnetNodeId(subnet.subnetId),
      // A subnet's OWN size is derived from its children by ELK when no explicit width/height
      // constraint forces otherwise — but ELK's compound-node model still requires a starting
      // width/height for the container itself when it holds children with the layered algorithm,
      // so a minimum footprint is provided; ELK grows it to fit the actual children.
      width: Math.max(SUBNET_MIN_WIDTH, resourceChildren.length * (RESOURCE_NODE_MIN_WIDTH + 32)),
      height: SUBNET_HEADER_HEIGHT + RESOURCE_NODE_HEIGHT + 32,
      layoutOptions: { 'elk.padding': SUBNET_PADDING },
      children: resourceChildren,
    };
  });

  const vpcNode: ElkNodeInput = {
    id: vpc.vpcId,
    width: SUBNET_MIN_WIDTH,
    height: SUBNET_HEADER_HEIGHT,
    children: subnetChildren,
  };

  const internetNode: ElkNodeInput = {
    id: INTERNET_NODE_ID,
    width: INTERNET_NODE_WIDTH,
    height: INTERNET_NODE_HEIGHT,
  };

  // Only an edge whose BOTH endpoints are represented in this VPC's node set (every resource
  // across every subnet, the VPC itself, or the internet node) is included — an edge into a VPC
  // that is not currently on screen (e.g. the inactive Tabs pane) has nothing to visually anchor
  // to, matching the old DiagramCanvas's documented behavior (design.md's Architecture section).
  const nodeIds = new Set<string>([INTERNET_NODE_ID, vpc.vpcId]);
  for (const subnet of vpc.subnets) {
    nodeIds.add(subnetNodeId(subnet.subnetId));
    for (const resource of resourcesBySubnet.get(subnet.subnetId) ?? []) nodeIds.add(resource.id);
  }
  const relevantEdges = input.edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));

  const elkEdges: ElkEdgeInput[] = relevantEdges.map((edge, index) => ({
    id: `edge-${index}-${edge.from}-${edge.to}`,
    sources: [edge.from],
    targets: [edge.to],
  }));

  // `sources`/`targets` are arrays per ELK's JSON schema (not `source`/`target` strings, unlike
  // React Flow's Edge type) — a common integration pitfall documented in ELK/React Flow
  // integration guides, avoided here by keeping `ElkEdgeInput` a distinct shape from React Flow's
  // `Edge` rather than sharing one type between the two libraries.
  const graph: ElkNodeInput = {
    id: 'root',
    width: 0,
    height: 0,
    layoutOptions: BASE_LAYOUT_OPTIONS,
    children: [internetNode, vpcNode],
    edges: elkEdges,
  };

  return { graph, relevantEdges };
}

/** Recursively walks ELK's output tree, collecting one React Flow `Node` per ELK node (skipping
 * the synthetic `root`), with `parentId` set to the immediate ELK parent and `position` taken
 * DIRECTLY from ELK's own `x`/`y` — ELK already reports child coordinates relative to their
 * parent's origin (top-left), which is EXACTLY React Flow's own `parentId`-relative positioning
 * contract (design.md's Data Flow section, confirmed against both libraries' documented coordinate
 * systems), so no coordinate transformation is needed between the two. */
function collectReactFlowNodes(elkNode: ElkLayoutResultNode, parentId: string | undefined, out: Node[]): void {
  if (elkNode.id !== 'root') {
    out.push({
      id: elkNode.id,
      position: { x: elkNode.x ?? 0, y: elkNode.y ?? 0 },
      // `type` is assigned by the caller (`computeVpcLayout`), which knows whether this id is the
      // VPC/a subnet/a resource/the internet node — this function only knows ELK's tree shape.
      type: undefined,
      data: {},
      parentId,
      extent: parentId ? 'parent' : undefined,
      style: elkNode.width != null && elkNode.height != null ? { width: elkNode.width, height: elkNode.height } : undefined,
    });
  }
  for (const child of elkNode.children ?? []) {
    collectReactFlowNodes(child, elkNode.id === 'root' ? undefined : elkNode.id, out);
  }
}

/**
 * Converts one VPC's Topology_Data into a laid-out React Flow `{ nodes, edges }` pair, via ELK's
 * `layered` algorithm. Pure with respect to React/DOM (no side effects beyond the `elk.layout()`
 * call itself, which is the one necessarily-async, necessarily-external operation) — see
 * `elkLayoutAdapter.test.ts` for the unit tests this enables.
 *
 * `elkInstance` defaults to this module's own production singleton (real browser `Worker`,
 * `elk-api` entry — see the module-scope `elk` const above) and is ONLY ever overridden by
 * `elkLayoutAdapter.test.ts`, which passes an instance built from `elkjs`'s package MAIN entry
 * instead (that entry's own synchronous fallback works correctly under Node/jsdom, at the cost of
 * bundling the layout algorithm inline — an acceptable cost in a test file, which is never
 * shipped, but NOT an acceptable cost in this module's own always-bundled import graph, which is
 * the whole reason for the `elk-api` switch documented above). This keeps the "which ELK build
 * to use for this environment" decision entirely in the test file, rather than adding an
 * environment check to production code that would otherwise never need one.
 */
export async function computeVpcLayout(
  input: VpcLayoutInput,
  elkInstance: Pick<InstanceType<typeof ELK>, 'layout'> = getDefaultElk(),
): Promise<VpcLayoutResult> {
  const { graph, relevantEdges } = buildElkGraph(input);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- elkjs ships no bundled TypeScript types for its full API; this is the one call site that touches the untyped boundary.
  const result = (await elkInstance.layout(graph as any)) as ElkLayoutResultNode;

  const rawNodes: Node[] = [];
  collectReactFlowNodes(result, undefined, rawNodes);

  const subnetIds = new Set(input.vpc.subnets.map((s) => subnetNodeId(s.subnetId)));
  const resourceIdToKind = new Map<string, TopologyResource>();
  for (const resources of input.resourcesBySubnet.values()) {
    for (const resource of resources) resourceIdToKind.set(resource.id, resource);
  }

  const nodes: Node[] = rawNodes.map((node) => {
    if (node.id === INTERNET_NODE_ID) return { ...node, type: 'internet' };
    if (node.id === input.vpc.vpcId) return { ...node, type: 'vpcGroup', data: { vpc: input.vpc } };
    if (subnetIds.has(node.id)) {
      const subnetId = node.id.slice('subnet:'.length);
      const subnet = input.vpc.subnets.find((s) => s.subnetId === subnetId);
      return { ...node, type: 'subnetGroup', data: { subnet } };
    }
    const resource = resourceIdToKind.get(node.id);
    return { ...node, type: 'resource', data: { resource } };
  });

  const edges: Edge[] = relevantEdges.map((edge, index) => ({
    id: `edge-${index}-${edge.from}-${edge.to}`,
    source: edge.from,
    target: edge.to,
    // Custom edge type rendered by `TopologyEdgeComponent.tsx` (registered via `edgeTypes` in
    // `InfraNetworkDiagram/index.tsx`) — colors/dashes the edge by `data.kind`, matching the old
    // hand-drawn overlay's per-kind styling (`EDGE_STYLE`/`diagramTheme.ts`).
    type: 'topologyEdge',
    data: { kind: edge.kind },
  }));

  return { nodes, edges };
}

/** Terminates the shared ELK Web Worker (elkjs's own documented `terminateWorker()` API) — call
 * on app/route teardown if ever needed; not currently wired up anywhere, since this module's
 * ELK instance lives for the app's lifetime same as any other module-scope singleton in this
 * codebase (e.g. `core/aws-clients.ts`'s memoized clients on the backend). Exported for
 * completeness/testability, not because a current caller needs it. No-op if `computeVpcLayout`
 * was never called (the lazy default instance was never constructed, so there is no worker to
 * terminate in the first place). */
export function terminateElkWorker(): void {
  defaultElk?.terminateWorker();
}
