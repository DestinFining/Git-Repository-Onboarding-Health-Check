import type { CheckStatus, RiskFinding, RiskSeverity, ScanEvent, ScanPhase, ScanReport } from '../types/report.ts';

export const categories = { completeness: '工程完整度', portability: '跨平台与路径', security: '密钥安全' };
export const severities = { High: '高危', Medium: '中危', Low: '低危' };
export const statuses: Record<CheckStatus, string> = { pass: '通过', fail: '需整改', skipped: '未验证' };
export const checkNames: Record<ScanReport['scoreBreakdown'][number]['check'], string> = {
  readme: 'README', dependencyManifest: '依赖清单', startupScript: '启动方式', windowsOnlyScripts: 'Windows 专用脚本',
  hardcodedPaths: '硬编码路径', exposedSecrets: '暴露密钥', privateKeys: '私钥', trackedEnvFiles: '敏感配置文件',
};
export const phaseLabels: Record<ScanPhase, string> = {
  clone: '正在拉取仓库', structure: '分析工程结构', risks: '扫描敏感风险', report: '生成报告',
};

export function grade(score: number) {
  if (score >= 90) return '极佳';
  if (score >= 70) return '良好';
  if (score >= 50) return '需整改';
  return '高风险';
}

export function getRiskCounts(report: ScanReport): Record<RiskSeverity, number> {
  if (report.riskCounts) return report.riskCounts;
  const counts = { High: 0, Medium: 0, Low: 0 };
  for (const risk of report.risks) counts[risk.severity]++;
  return counts;
}

export function getMetrics(report: ScanReport) {
  const { completeness, security } = report.readiness.dimensions;
  const checks = report.scoreBreakdown;
  return [
    { label: '工程完整度', ...completeness },
    { label: '跨平台兼容', ...checks.find(item => item.check === 'windowsOnlyScripts')! },
    { label: '路径规范', ...checks.find(item => item.check === 'hardcodedPaths')! },
    { label: '密钥安全', ...security },
  ];
}

export function riskLocation(risk: RiskFinding) {
  if (!risk.filePath) return '仓库级检查';
  return risk.filePath + (risk.lineNumber !== null ? ':' + risk.lineNumber : '');
}

export const scanDate = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium',
});

function escapeMarkdown(value: string) {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/@/g, '&#64;').replace(/[\\`*_{}\[\]()#+|!~]/g, '\\$&');
}

function code(value: string) {
  const clean = value.replace(/[\r\n\t]+/g, ' ');
  const fence = '`'.repeat(Math.max(0, ...Array.from(clean.matchAll(/`+/g), match => match[0].length)) + 1);
  return fence + ' ' + clean + ' ' + fence;
}

export function toMarkdown(report: ScanReport, isDemo: boolean) {
  const { repository, completeness, readiness } = report;
  const counts = getRiskCounts(report);
  return [
    '# Git 仓库接入体检报告', '',
    ...(isDemo ? ['> 示例报告 · 仓库与风险均为模拟数据。', ''] : []),
    '- 仓库 ' + code(repository.repoUrl),
    '- 分支 ' + code(repository.branch),
    '- 提交 ' + code(repository.commitHash),
    '- 扫描时间 ' + code(repository.scannedAt), '',
    '## 接入就绪度', '',
    '**' + readiness.total + '/100 · ' + grade(readiness.total) + '**', '',
    ...getMetrics(report).map(item => '- ' + item.label + ' ' + item.points + '/' + item.maxPoints), '',
    '### 评分明细', '',
    ...report.scoreBreakdown.map(item => '- ' + checkNames[item.check] + ' ' + item.points + '/' + item.maxPoints + ' · ' + escapeMarkdown(item.reason)), '',
    '## 完整度检查', '',
    ...([
      ['README', completeness.readme],
      ['依赖清单', completeness.dependencyManifest],
      ['启动方式', completeness.startupScript],
    ] as const).map(([label, result]) => '- [' + (result.status === 'pass' ? 'x' : ' ') + '] ' + label + ' · ' +
      escapeMarkdown(result.summary) + (result.filePaths.length ? ' · ' + result.filePaths.map(code).join('、') : '')),
    ...(completeness.readme.sections ?? []).map(item => '- [' + (item.status === 'pass' ? 'x' : ' ') + '] README ' + item.label + ' · ' + statuses[item.status]),
    '', '## 风险清单', '',
    '高危 ' + counts.High + ' · 中危 ' + counts.Medium + ' · 低危 ' + counts.Low, '',
    ...(report.risksTruncated ? ['> 风险明细已截断，统计保留完整数量。', ''] : []),
    ...(report.risks.length ? report.risks.flatMap(risk => [
      '### ' + severities[risk.severity] + ' · ' + escapeMarkdown(risk.title), '',
      '- 分类 ' + categories[risk.category],
      '- 位置 ' + code(riskLocation(risk)),
      ...(risk.redactedSnippet ? ['- 脱敏片段 ' + code(risk.redactedSnippet)] : []),
      '- 修复建议 ' + escapeMarkdown(risk.remediation), '',
    ]) : ['未发现可展示的风险。', '']),
  ].join('\n');
}

export async function requestScan(repoUrl: string, onPhase: (phase: ScanPhase) => void): Promise<ScanReport> {
  const response = await fetch('/api/scan', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify({ repoUrl }), signal: AbortSignal.timeout(75_000),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new Error(result?.error?.message ?? '扫描服务暂时无法响应，请稍后重试。');
  }
  if (!response.headers.get('Content-Type')?.includes('application/x-ndjson')) return response.json();
  if (!response.body) throw new Error('扫描服务未返回报告，请重试。');

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  function readEvent(line: string) {
    if (!line.trim()) return;
    const event: ScanEvent = JSON.parse(line);
    if (event.type === 'phase') onPhase(event.phase);
    if (event.type === 'error') throw new Error(event.error.message);
    if (event.type === 'report') return event.report;
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = (pending + value).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const report = readEvent(line);
        if (report) return report;
      }
    }
    const report = readEvent(pending);
    if (report) return report;
    throw new Error('扫描连接提前结束，请重试。');
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
