import type { TopologyResourceKind } from '@ops-dashboard/shared';

/**
 * Small, flat resource-kind glyphs styled after AWS's own Architecture Icons convention: a
 * rounded-square badge in the resource's AWS SERVICE CATEGORY color, with a simple white glyph
 * recognizable as that resource type. Cloudscape's `Icon` component has no AWS service icons at
 * all (it's a general-purpose UI icon set — `settings`/`share`/`gen-ai` were being reused as
 * stand-ins, which don't read as "EC2"/"RDS"/"ALB" to anyone who's used the AWS console), so this
 * is a small hand-built SVG set instead — same category-color convention the AWS console and
 * AWS Architecture Icons package use, just simplified to single-color glyphs at icon size.
 *
 * Category colors match AWS's official Architecture Icons palette:
 *   Compute (EC2, ECS)        #ED7100 (orange)
 *   Database (RDS)            #3B48CC (blue)
 *   Networking (ALB/NLB/NAT/TGW) #8C4FFF (purple)
 *   Storage (S3)               #7AA116 (green)
 */
const CATEGORY_COLOR: Record<TopologyResourceKind, string> = {
  ec2: '#ED7100',
  ecs: '#ED7100',
  rds: '#3B48CC',
  alb: '#8C4FFF',
  nlb: '#8C4FFF',
  natgw: '#8C4FFF',
  tgw: '#8C4FFF',
  s3: '#7AA116',
};

/** AWS service abbreviation shown INSIDE the badge, exactly like AWS Architecture Icons do (a
 * resource icon is a colored square with a short service abbreviation + a small glyph) — far more
 * identifiable at a glance than a generic shape alone. */
const CATEGORY_LABEL: Record<TopologyResourceKind, string> = {
  ec2: 'EC2',
  ecs: 'ECS',
  rds: 'RDS',
  alb: 'ALB',
  nlb: 'NLB',
  natgw: 'NAT',
  tgw: 'TGW',
  s3: 'S3',
};

/** Glyph paths, drawn in a 24x24 viewBox, in `currentColor` (white, set by the wrapping badge). */
function Glyph({ kind }: { kind: TopologyResourceKind }) {
  switch (kind) {
    // EC2 — a server unit: a rounded rectangle with two "slot" lines, the standard EC2 icon shape.
    case 'ec2':
      return (
        <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <rect x="5" y="5" width="14" height="14" rx="1.5" />
          <path d="M8 9h8M8 12h8M8 15h4" />
        </g>
      );
    // ECS — a grid of containers (2x2 boxes), the standard "orchestrated containers" motif.
    case 'ecs':
      return (
        <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
          <rect x="4.5" y="4.5" width="6.5" height="6.5" rx="1" />
          <rect x="13" y="4.5" width="6.5" height="6.5" rx="1" />
          <rect x="4.5" y="13" width="6.5" height="6.5" rx="1" />
          <rect x="13" y="13" width="6.5" height="6.5" rx="1" />
        </g>
      );
    // RDS — a database cylinder (stacked ellipses), the universal database glyph.
    case 'rds':
      return (
        <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
          <ellipse cx="12" cy="6.5" rx="6.5" ry="2.5" />
          <path d="M5.5 6.5v11c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5v-11" />
          <path d="M5.5 12c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5" />
        </g>
      );
    // ALB — Application Load Balancer: one node fanning out to three, layer-7 (app) style spread.
    case 'alb':
      return (
        <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="6" cy="12" r="2.2" />
          <circle cx="18" cy="6" r="2.2" />
          <circle cx="18" cy="12" r="2.2" />
          <circle cx="18" cy="18" r="2.2" />
          <path d="M8.2 12H14M14 12 16 6M14 12h1.8M14 12 16 18" />
        </g>
      );
    // NLB — Network Load Balancer: same fan shape but a single straight-through line (layer-4,
    // pass-through) to visually distinguish it from ALB's branching lines.
    case 'nlb':
      return (
        <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="10.2" width="4" height="3.6" rx="0.8" />
          <rect x="16" y="10.2" width="4" height="3.6" rx="0.8" />
          <path d="M8 12h8" />
        </g>
      );
    // NAT Gateway — bidirectional arrows through a gate, the standard NAT motif.
    case 'natgw':
      return (
        <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 8h9M10 5.5 13 8l-3 2.5" />
          <path d="M20 16h-9M14 13.5 11 16l3 2.5" />
        </g>
      );
    // Transit Gateway — a central hub with spokes, the standard "connects several networks" motif.
    case 'tgw':
      return (
        <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <circle cx="12" cy="12" r="2.3" />
          <path d="M12 9.7V5M12 14.3V19M9.7 12H5M14.3 12H19" />
          <circle cx="12" cy="4" r="1.3" fill="currentColor" stroke="none" />
          <circle cx="12" cy="20" r="1.3" fill="currentColor" stroke="none" />
          <circle cx="4" cy="12" r="1.3" fill="currentColor" stroke="none" />
          <circle cx="20" cy="12" r="1.3" fill="currentColor" stroke="none" />
        </g>
      );
    // S3 — a bucket: a trapezoid outline, the standard S3 bucket silhouette.
    case 's3':
      return (
        <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 6h12l-1.3 13a1 1 0 0 1-1 .9H8.3a1 1 0 0 1-1-.9L6 6Z" />
          <path d="M6 6c0-1.1 2.7-2 6-2s6 .9 6 2-2.7 2-6 2-6-.9-6-2Z" />
        </g>
      );
    default:
      return null;
  }
}

export interface AwsResourceIconProps {
  kind: TopologyResourceKind;
  /** Pixel size of the square badge — glyph scales with it. Defaults to 28 (fits inline with a
   * body-s text row without dominating it). */
  size?: number;
}

/** A resource-kind badge: colored rounded square (AWS service-category color) + glyph + short
 * service abbreviation underneath the glyph, matching how the AWS Console's own resource icons
 * are composed. Renders as an inline SVG so it scales crisply at any size and inherits no
 * unrelated Cloudscape icon styling. */
export function AwsResourceIcon({ kind, size = 28 }: AwsResourceIconProps) {
  const color = CATEGORY_COLOR[kind];
  const label = CATEGORY_LABEL[kind];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={`${label} icon`} style={{ flexShrink: 0 }}>
      <rect x="0.5" y="0.5" width="23" height="23" rx="5" fill={color} />
      <g color="#fff" transform="translate(12,9) scale(0.68) translate(-12,-12)">
        <Glyph kind={kind} />
      </g>
      <text
        x="12"
        y="20.5"
        textAnchor="middle"
        fontSize="5.2"
        fontWeight="700"
        fill="#fff"
        fontFamily="ui-sans-serif, system-ui, -apple-system, sans-serif"
        style={{ letterSpacing: '0.02em' }}
      >
        {label}
      </text>
    </svg>
  );
}
