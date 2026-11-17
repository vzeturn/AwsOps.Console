import { useMemo } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Container from '@cloudscape-design/components/container';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import type { ThresholdMeta, TopologyResource } from '@ops-dashboard/shared';
import { useTopology, useInfra, useMonitoring } from '../hooks/useApi';
import { KpiTile, KpiTileRow } from '../components/KpiTile';
import { SeverityStatusBar } from '../components/SeverityStatusBar';
import { InfraNetworkDiagram } from '../components/InfraNetworkDiagram';

export const Route = createFileRoute('/infra-map')({
  // Wrapped in an inline arrow (not `component: InfraMapPage` directly) — the `tanstackRouter`
  // plugin's static analysis of "is this route file's `component` an EXPORTED value" is what
  // decides whether to code-split it; a locally-defined wrapper referencing the exported
  // `InfraMapPage` still reads as this route's OWN component to that analysis (confirmed by
  // building: the dedicated `infra-map-*.js` chunk is present with this indirection, absent
  // without it), while `InfraMapPage` itself stays reachable for `infra-map.test.tsx` to import
  // and render directly, with no need to go through `Route.options.component`'s lazy wrapper at
  // all (which — also confirmed by actually running it — never resolves under Vitest's transform
  // pipeline, unlike a real `vite build`/`vite dev` server).
  component: () => <InfraMapPage />,
});

/** Joins health onto topology resource ids from `/infra` (EC2/RDS/ALB) and `/monitoring` (every
 * monitored resource type, including the worst metric per resource) — `TopologyData` itself
 * deliberately carries structure only, see its own doc comment in shared/src/index.ts. */
function useHealthLookup() {
  const infra = useInfra();
  const monitoring = useMonitoring();

  return useMemo(() => {
    const map = new Map<string, ThresholdMeta>();
    for (const item of infra.data?.ec2 ?? []) map.set(item.instanceId, item.threshold);
    for (const item of infra.data?.rds ?? []) map.set(item.dbInstanceIdentifier, item.threshold);
    for (const item of infra.data?.alb ?? []) map.set(item.name, item.threshold);
    for (const resource of monitoring.data?.resources ?? []) {
      const worst = resource.metrics
        .filter((m) => m.threshold)
        .sort((a, b) => {
          const rank = (level: string) => (level === 'critical' ? 2 : level === 'warn' ? 1 : 0);
          return rank(b.threshold?.level ?? 'ok') - rank(a.threshold?.level ?? 'ok');
        })[0];
      if (worst?.threshold) map.set(resource.resourceId, worst.threshold);
    }
    return map;
  }, [infra.data, monitoring.data]);
}

/** Rolls the health map + topology's own resource count into the counts `SeverityStatusBar`
 * needs, plus a couple of structural KPIs (VPC/subnet counts) — the "how big is this account, and
 * is anything on fire" summary that used to require reading the whole tree to answer. */
function useMapSummary(data: ReturnType<typeof useTopology>['data'], health: Map<string, ThresholdMeta>) {
  return useMemo(() => {
    const allResourceIds = [
      ...(data?.resources ?? []),
      ...(data?.unplacedResources ?? []),
      ...(data?.accountResources ?? []),
    ].map((r) => r.id);

    let critical = 0;
    let warn = 0;
    let ok = 0;
    let unmonitored = 0;
    for (const id of allResourceIds) {
      const level = health.get(id)?.level;
      if (level === 'critical') critical += 1;
      else if (level === 'warn') warn += 1;
      else if (level === 'ok') ok += 1;
      else unmonitored += 1;
    }

    const subnetCount = (data?.vpcs ?? []).reduce((sum, vpc) => sum + vpc.subnets.length, 0);

    return {
      counts: { critical, warn, ok, unmonitored },
      totalResources: allResourceIds.length,
      vpcCount: data?.vpcs.length ?? 0,
      subnetCount,
    };
  }, [data, health]);
}

/**
 * Interactive_Kpi's scroll+highlight action (Requirement 1.2): smooth-scrolls the target element
 * into view, then applies `index.css`'s `infra-map-highlight-pulse` animation (0.5s x 3 = 1.5s
 * total, matching the Requirement's own "at least 1.5 seconds" minimum) before removing it. Kept
 * as a plain function (not a shared hook/module) since there is currently exactly one call site —
 * this file's own `InfraMapPage` — matching this codebase's existing convention of not
 * pre-emptively extracting a single-use helper into shared infrastructure.
 */
export function scrollAndHighlight(elementId: string) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('infra-map-highlight-pulse');
  setTimeout(() => el.classList.remove('infra-map-highlight-pulse'), 1600);
}

/**
 * Pure decision function (Requirement 1.1/1.3) — given how many unplaced resources exist, decides
 * whether the "Unplaced resources" `KpiTile` gets an `onActivate`/`activateLabel` at all. Kept as
 * a plain, exported, DOM-free function specifically so `infra-map.test.tsx` can verify this
 * decision directly, without needing to render the whole page (which — see `InfraMapPage`'s own
 * comment — cannot be exported without breaking Requirement 3.5's bundle isolation). "Resources
 * tracked" has no equivalent decision function — its activation is unconditional (always scrolls
 * to the topology section, per Requirement 1.1's own "Resources tracked -> the whole canvas"
 * example) — only "Unplaced resources" needs a conditional per Requirement 1.3.
 */
export function resolveUnplacedKpiActivation(unplacedCount: number): { onActivate?: () => void; activateLabel?: string } {
  if (unplacedCount === 0) return {};
  return {
    onActivate: () => scrollAndHighlight('infra-map-unplaced-section'),
    activateLabel: 'Scroll to unplaced resources',
  };
}

/**
 * Deliberately NOT exported — unlike `assessment.tsx`'s `AssessmentPage`/`playbooks.tsx`'s
 * `PlaybooksPage`, which accept losing this route's dedicated bundle chunk as the cost of a
 * directly-renderable test target. `/infra-map` cannot make that same trade: it carries an
 * EXPLICIT bundle-isolation requirement (Requirement 3.5) the other two do not, and — confirmed
 * by actually building with `InfraMapPage` exported — even routing `Route`'s own `component`
 * field through an extra inline-wrapper indirection does not save it: the bundler must keep any
 * exported binding's full dependency graph reachable from wherever the module lands, which pulls
 * this whole component (and everything it imports, including `InfraNetworkDiagram`) into the
 * shared `index.js` chunk every route pays for, regardless of what `component:` itself points at.
 *
 * `infra-map.test.tsx` instead tests the genuinely independent, extractable PIECES of this
 * component's Interactive_Kpi wiring (Requirement 1) — `scrollAndHighlight` and
 * `resolveUnplacedKpiActivation`, both exported above — directly, rather than rendering this
 * whole page. The interactive AFFORDANCE itself (role="button"/tabIndex/keyboard activation/
 * dev-mode warning) is `KpiTile.test.tsx`'s job, already covered there against the real
 * component in isolation.
 */
function InfraMapPage() {
  const topology = useTopology();
  const health = useHealthLookup();
  const navigate = useNavigate();

  const data = topology.data;
  const summary = useMapSummary(data, health);

  function handleResourceClick(resource: TopologyResource) {
    if (!resource.monitoringType) return;
    void navigate({
      to: '/resource/$resourceType/$resourceId',
      params: { resourceType: resource.monitoringType, resourceId: resource.id },
    });
  }

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description={data?.accountId ? `Account ${data.accountId} · ${data.region}` : undefined}
        >
          Infra Map
        </Header>
      }
    >
      <SpaceBetween size="l">
        {topology.isError && (
          <Alert type="error" header="Failed to load topology">
            {(topology.error as Error).message}
          </Alert>
        )}
        {!topology.isLoading && data && (
          <Container disableContentPaddings>
            <Box padding="l">
              <SpaceBetween size="m">
                <SeverityStatusBar counts={summary.counts} />
                <KpiTileRow>
                  {/* "VPCs"/"Subnets" stay purely informational (Requirement 1.3) — with 2+ VPCs
                      shown one at a time behind `Tabs` (InfraNetworkDiagram/index.tsx), there is
                      no single "all VPCs" element on screen to scroll to; inventing a target for
                      these two would visually promise an action that does not exist. */}
                  <KpiTile label="VPCs" value={String(summary.vpcCount)} />
                  <KpiTile label="Subnets" value={String(summary.subnetCount)} />
                  {/* Requirement 1.1 explicitly lists "Resources tracked -> the whole canvas" as
                      an Interactive_Kpi (only "VPCs"/"Subnets" are exempted, per Requirement
                      1.3) — scrolls to the topology section below. */}
                  <KpiTile
                    label="Resources tracked"
                    value={String(summary.totalResources)}
                    onActivate={() => scrollAndHighlight('infra-map-topology-section')}
                    activateLabel="Scroll to network topology diagram"
                  />
                  <KpiTile
                    label="Unplaced resources"
                    value={String(data.unplacedResources.length)}
                    severity={data.unplacedResources.length > 0 ? 'warning' : 'ok'}
                    // Only interactive when there is an actual "Unplaced resources" section
                    // rendered to scroll to (AccountResourceGroupBox.tsx / index.tsx only render
                    // it when `data.unplacedResources.length > 0`) — otherwise this tile has
                    // nothing to drill into, so it correctly stays purely informational. The
                    // decision itself is `resolveUnplacedKpiActivation` (exported, unit-tested
                    // directly in infra-map.test.tsx).
                    {...resolveUnplacedKpiActivation(data.unplacedResources.length)}
                  />
                </KpiTileRow>
              </SpaceBetween>
            </Box>
          </Container>
        )}
        <Container
          id="infra-map-topology-section"
          header={<Header variant="h2">Network topology</Header>}
          disableContentPaddings
        >
          <Box padding="l">
            {topology.isLoading ? (
              <Box textAlign="center" padding="l">
                Loading topology…
              </Box>
            ) : (
              data && <InfraNetworkDiagram data={data} health={health} onResourceClick={handleResourceClick} />
            )}
          </Box>
        </Container>
      </SpaceBetween>
    </ContentLayout>
  );
}
