/**
 * Shape of `endpoint-drift.json` - written once a day by security-endpoint-drift-detector-fn
 * (SSM RunCommand is far too heavy to run every 10 min) and read by findings-aggregator-fn.
 */
export const ENDPOINT_DRIFT_S3_KEY = 'endpoint-drift.json';

export interface DriftFinding {
  instanceId: string;
  detectedProcesses: string[];
  hasSecurityExceptionTag: boolean;
}

export interface EndpointDriftReport {
  generatedAt: string;
  scanned: number;
  findings: DriftFinding[];
}
