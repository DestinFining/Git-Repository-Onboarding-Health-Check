export interface RepositoryMetadata {
  /** Canonical HTTPS repository URL. */
  repoUrl: string;
  owner: string;
  repoName: string;
  branch: string;
  commitHash: string;
  /** UTC timestamp in ISO 8601 format. */
  scannedAt: string;
}

export type ScoreDimension = 'completeness' | 'portability' | 'security';

export interface DimensionScore {
  /** Earned points, from zero to maxPoints. */
  points: number;
  maxPoints: number;
}

export interface ReadinessScore {
  /** Integer from 0 to 100. */
  total: number;
  dimensions: Record<ScoreDimension, DimensionScore>;
}

export interface ScoreBreakdownItem extends DimensionScore {
  dimension: ScoreDimension;
  check: keyof CompletenessChecks | keyof PortabilityChecks | keyof SecurityChecks;
  status: CheckStatus;
  deductedPoints: number;
  reason: string;
}

export type CheckStatus = 'pass' | 'fail' | 'skipped';

export interface CheckResult {
  status: CheckStatus;
  summary: string;
  /** Partial credit for checks that distinguish quality or severity. */
  points?: number;
  /** Repository-relative paths observed by this check. */
  filePaths: string[];
}

export interface CompletenessChecks {
  readme: CheckResult & { sections?: { label: string; status: CheckStatus }[] };
  dependencyManifest: CheckResult;
  startupScript: CheckResult;
}

export interface PortabilityChecks {
  windowsOnlyScripts: CheckResult;
  hardcodedPaths: CheckResult;
}

export interface SecurityChecks {
  exposedSecrets: CheckResult;
  privateKeys: CheckResult;
  trackedEnvFiles: CheckResult;
}

export type RiskSeverity = 'High' | 'Medium' | 'Low';

export interface RiskFinding {
  category: ScoreDimension;
  severity: RiskSeverity;
  title: string;
  /** Repository-relative path. Null when an expected file is missing. */
  filePath: string | null;
  /** 1-based line number. Null for file-level or missing-file findings. */
  lineNumber: number | null;
  /** Redacted text only. Null when there is no safe or relevant excerpt. */
  redactedSnippet: string | null;
  remediation: string;
}

export interface ScanReport {
  reviewId?: string;
  repository: RepositoryMetadata;
  readiness: ReadinessScore;
  scoreBreakdown: ScoreBreakdownItem[];
  completeness: CompletenessChecks;
  portability: PortabilityChecks;
  security: SecurityChecks;
  risks: RiskFinding[];
  riskCounts?: Record<RiskSeverity, number>;
  /** True when a check had more findings than the report can display. */
  risksTruncated: boolean;
}

export interface ProjectReview {
  source: 'ai' | 'rules';
  positioning: string;
  architecture: string;
  difficulty: 'low' | 'medium' | 'high';
  difficultyReason: string;
  aiScore: number | null;
  startupSteps: string[];
  priorities: [string, string, string];
  message?: string;
}

export type ScanPhase = 'clone' | 'structure' | 'risks' | 'report';

export type ScanEvent =
  | { type: 'phase'; phase: ScanPhase }
  | { type: 'report'; report: ScanReport }
  | { type: 'error'; error: { code: string; message: string } };
