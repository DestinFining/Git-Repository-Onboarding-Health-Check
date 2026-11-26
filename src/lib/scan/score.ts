import type {
  CheckResult,
  ReadinessScore,
  ScanReport,
  ScoreBreakdownItem,
  ScoreDimension,
} from '../../types/report.ts';

type Checks = Pick<ScanReport, 'completeness' | 'portability' | 'security'>;

const weights = {
  completeness: { readme: 15, dependencyManifest: 10, startupScript: 15 },
  portability: { windowsOnlyScripts: 15, hardcodedPaths: 15 },
  security: { exposedSecrets: 10, privateKeys: 10, trackedEnvFiles: 10 },
} satisfies { [Dimension in ScoreDimension]: Record<keyof Checks[Dimension], number> };

export function calculateScore(checks: Checks): Pick<ScanReport, 'readiness' | 'scoreBreakdown'> {
  const dimensions: ReadinessScore['dimensions'] = {
    completeness: { points: 0, maxPoints: 0 },
    portability: { points: 0, maxPoints: 0 },
    security: { points: 0, maxPoints: 0 },
  };
  const scoreBreakdown: ScoreBreakdownItem[] = [];
  let total = 0;

  function scoreDimension<Check extends ScoreBreakdownItem['check']>(
    dimension: ScoreDimension,
    results: Record<Check, CheckResult>,
    dimensionWeights: Record<Check, number>,
  ) {
    for (const check of Object.keys(dimensionWeights) as Check[]) {
      const maxPoints = dimensionWeights[check];
      const { status, summary } = results[check];
      const points = status === 'pass' ? maxPoints : 0;
      dimensions[dimension].points += points;
      dimensions[dimension].maxPoints += maxPoints;
      total += points;
      scoreBreakdown.push({ dimension, check, status, maxPoints, points, deductedPoints: maxPoints - points, reason: summary });
    }
  }

  scoreDimension('completeness', checks.completeness, weights.completeness);
  scoreDimension('portability', checks.portability, weights.portability);
  scoreDimension('security', checks.security, weights.security);
  return { readiness: { total, dimensions }, scoreBreakdown };
}
