'use client';

import {
  Activity, AlertCircle, BookOpen, Check, ChevronDown, CircleCheck, ClipboardList,
  Clock3, Code2, Copy, FileCode2, FileText, GitBranch, GitCommitHorizontal, GitFork,
  Link2, ListFilter, LoaderCircle, Minus, Package, ScanLine, Shield, ShieldAlert, Terminal, X,
} from 'lucide-react';
import { useState, type CSSProperties, type FormEvent } from 'react';
import { ProjectReviewPanel } from './project-review';
import { demoReport } from '../lib/demo-report';
import {
  categories, checkNames, getMetrics, getRiskCounts, grade, phaseLabels, requestScan, riskLocation, scanDate,
  severities, statuses, toMarkdown,
} from '../lib/report-display';
import type { CheckResult, CheckStatus, RiskFinding, RiskSeverity, ScanPhase, ScanReport, ScoreDimension } from '../types/report';

const examples = [
  { label: 'Express', url: 'https://github.com/expressjs/express' },
  { label: 'Hello World', url: 'https://github.com/octocat/Hello-World' },
];
const phases = Object.keys(phaseLabels) as ScanPhase[];
const levels = Object.keys(severities) as RiskSeverity[];
const stackByFile: Record<string, string> = {
  'package.json': 'Node.js', 'requirements.txt': 'Python', 'pyproject.toml': 'Python', pipfile: 'Python', 'setup.py': 'Python',
  'environment.yml': 'Python', 'environment.yaml': 'Python',
  'go.mod': 'Go', 'cargo.toml': 'Rust', 'pom.xml': 'Maven', 'build.gradle': 'Gradle', 'build.gradle.kts': 'Gradle',
  gemfile: 'Ruby', 'composer.json': 'PHP', 'mix.exs': 'Elixir', 'deno.json': 'Deno', 'pubspec.yaml': 'Dart',
};

function StatusIcon({ status }: { status: CheckStatus }) {
  const Icon = status === 'pass' ? Check : status === 'fail' ? X : Minus;
  return <span className={'check-icon ' + status} title={statuses[status]}><Icon size={13} aria-hidden="true" /><span className="sr-only">{statuses[status]}</span></span>;
}

function Progress({ phase }: { phase: ScanPhase }) {
  const current = phases.indexOf(phase);
  return (
    <div className="scan-progress">
      <span role="status" className="sr-only">{phaseLabels[phase]}</span>
      <ol aria-label="扫描阶段">
        {phases.map((item, index) => (
          <li key={item} aria-current={index === current ? 'step' : undefined} className={index <= current ? 'reached' : ''}>
            {index === current ? <LoaderCircle className="spin" size={14} /> : index < current ? <Check size={14} /> : <span className="step-dot" />}
            {phaseLabels[item]}
          </li>
        ))}
      </ol>
    </div>
  );
}

function ScoreCards({ report }: { report: ScanReport }) {
  const score = report.readiness.total;
  const tone = score >= 90 ? 'excellent' : score >= 70 ? 'good' : score >= 50 ? 'fair' : 'poor';
  return (
    <div className="score-grid">
      <section className="panel score-panel" aria-labelledby="score-title">
        <div className="panel-heading"><Activity size={16} /><h3 id="score-title">接入就绪度</h3></div>
        <div className="score-body">
          <div className="gauge" role="meter" aria-label="接入就绪度" aria-valuenow={score} aria-valuemin={0} aria-valuemax={100}
            style={{ '--score': score + '%' } as CSSProperties}>
            <div className="gauge-face"><strong>{score}</strong><span>/ 100</span></div>
          </div>
          <div className="score-label"><span className={'grade ' + tone}>{grade(score)}</span><span className="muted">综合评分</span></div>
        </div>
      </section>
      <section className="panel dimensions-panel" aria-labelledby="dimensions-title">
        <div className="panel-heading"><ScanLine size={16} /><h3 id="dimensions-title">维度评分</h3></div>
        <ul className="dimension-list">
          {getMetrics(report).map(({ label, points, maxPoints }) => (
            <li key={label}>
              <span>{label}</span>
              <div role="meter" aria-label={label} aria-valuenow={points} aria-valuemax={maxPoints} aria-valuemin={0} className="dimension-track">
                <div className="dimension-fill" style={{ width: (points / maxPoints) * 100 + '%' }} />
              </div>
              <span className="dimension-value">{points}<span> / {maxPoints}</span></span>
            </li>
          ))}
        </ul>
        <details className="score-details">
          <summary>评分明细 <ChevronDown size={14} /></summary>
          <ul>{report.scoreBreakdown.map(item => (
            <li key={item.check}><StatusIcon status={item.status} /><div><strong>{checkNames[item.check]}</strong><p>{item.reason}</p></div>
              <span className="score-points">{item.points}/{item.maxPoints}</span></li>
          ))}</ul>
        </details>
      </section>
    </div>
  );
}

function Indicators({ report }: { report: ScanReport }) {
  const { readme, dependencyManifest, startupScript } = report.completeness;
  const stacks = [...new Set(dependencyManifest.filePaths.flatMap(path => {
    const name = path.toLowerCase().split('/').pop() ?? '';
    return stackByFile[name] ?? (/^requirements-.+\.txt$/.test(name) ? 'Python' : name.endsWith('.csproj') ? '.NET' : []);
  }))];
  const counts = getRiskCounts(report);
  const total = counts.High + counts.Medium + counts.Low;
  const startupNames = [...new Set(startupScript.filePaths.map(path => path.split('/').pop() ?? path))];
  const startupLabel = startupNames.map(name => name.toLowerCase() === 'package.json' ? 'npm scripts' : name).join(' · ');
  return (
    <div className="indicator-grid" aria-label="关键指标">
      <article className="panel indicator"><div><BookOpen /><span>README</span></div><strong>{statuses[readme.status]}</strong><code title={readme.filePaths.join('、')}>{readme.filePaths[0] ?? '未找到 README'}</code></article>
      <article className="panel indicator"><div><Package /><span>技术栈 / 依赖</span></div><strong title={stacks.join(' · ')}>{stacks.join(' · ') || (dependencyManifest.filePaths.length ? '已检测' : '未检测')}</strong><code title={dependencyManifest.filePaths.join('、')}>{dependencyManifest.filePaths.length ? dependencyManifest.filePaths[0] + (dependencyManifest.filePaths.length > 1 ? ' 等 ' + dependencyManifest.filePaths.length + ' 项' : '') : '暂无依赖清单'}</code></article>
      <article className="panel indicator"><div><Terminal /><span>启动方式</span></div><strong title={startupLabel}>{startupLabel || statuses[startupScript.status]}</strong><small>{startupScript.filePaths.length ? '检测到 ' + startupScript.filePaths.length + ' 个入口文件' : '暂无启动入口'}</small></article>
      <article className="panel indicator"><div><ShieldAlert /><span>风险总数</span></div><strong>{total} <small>项</small></strong>
        <div className="risk-counts">{levels.map(level => <span className={'severity-' + level.toLowerCase()} key={level}><i />{severities[level]} {counts[level]}</span>)}</div>
      </article>
    </div>
  );
}

function ChecklistItem({ label, result, children }: { label: string; result: CheckResult; children?: React.ReactNode }) {
  return <li className="check-item"><StatusIcon status={result.status} /><div className="check-text"><strong>{label}</strong><p>{result.summary}</p>{children}
    {result.filePaths.length > 0 && <details className="check-files"><summary>{result.filePaths.length} 个相关文件 <ChevronDown size={12} /></summary>
      <ul>{result.filePaths.map((path, index) => <li key={index}><code>{path}</code></li>)}</ul></details>}
  </div></li>;
}

function Checklist({ completeness }: { completeness: ScanReport['completeness'] }) {
  const { readme, dependencyManifest, startupScript } = completeness;
  return <section className="panel checklist" aria-labelledby="checklist-title">
    <div className="panel-heading"><ClipboardList size={16} /><h3 id="checklist-title">完整度检查</h3></div>
    <ul className="check-list">
      <ChecklistItem label="README 章节覆盖" result={readme}>
        {readme.sections && <ul className="readme-sections">{readme.sections.map(item => <li key={item.label}><StatusIcon status={item.status} />{item.label}</li>)}</ul>}
      </ChecklistItem>
      <ChecklistItem label="依赖清单" result={dependencyManifest} />
      <ChecklistItem label="启动脚本 / 入口" result={startupScript} />
    </ul>
  </section>;
}

function RiskCard({ risk }: { risk: RiskFinding }) {
  const severity = 'severity-' + risk.severity.toLowerCase();
  return <article className={'risk-card ' + severity}>
    <div className="risk-card-heading"><span className="risk-type-icon"><ShieldAlert size={16} /></span><div><h4>{risk.title}</h4>
      <code className="risk-location"><FileCode2 size={13} aria-hidden="true" />{riskLocation(risk)}</code></div>
      <span className="severity-badge"><i />{severities[risk.severity]}</span></div>
    {risk.redactedSnippet && <pre className="risk-code"><code>{risk.redactedSnippet.split(/(\*{4})/).map((part, index) => part === '****' ? <mark key={index}>{part}</mark> : part)}</code></pre>}
    <p className="remediation"><strong>如何修复</strong> {risk.remediation}</p>
  </article>;
}

function RiskExplorer({ report }: { report: ScanReport }) {
  const [severity, setSeverity] = useState<RiskSeverity | 'all'>('all');
  const [category, setCategory] = useState<ScoreDimension | 'all'>('all');
  const counts = getRiskCounts(report);
  const risks = report.risks.filter(risk => (severity === 'all' || risk.severity === severity) && (category === 'all' || risk.category === category));
  return <section className="risk-section" id="risks" aria-labelledby="risks-title">
    <div className="section-heading risk-heading"><div><h2 id="risks-title">风险与检查</h2><p>定位可能影响接入的问题，查看修复建议。</p></div></div>
    <div className="risk-grid">
      <div className="panel explorer">
        <div className="panel-heading"><Shield size={16} /><h3>主要风险</h3><span className="results-count" aria-live="polite">{risks.length} 项</span></div>
        <div className="filters">
          <div className="severity-filters" role="group" aria-label="按严重程度筛选">
            <button type="button" onClick={() => setSeverity('all')} aria-pressed={severity === 'all'}>全部 <span>{counts.High + counts.Medium + counts.Low}</span></button>
            {levels.map(level => <button type="button" key={level} className={'severity-' + level.toLowerCase()} onClick={() => setSeverity(level)} aria-pressed={severity === level}><i />{severities[level]} <span>{counts[level]}</span></button>)}
          </div>
          <label className="category-filter"><ListFilter size={14} aria-hidden="true" /><span className="sr-only">按风险类别筛选</span><select value={category} onChange={event => setCategory(event.target.value as ScoreDimension | 'all')}>
            <option value="all">全部类别</option>{Object.entries(categories).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select><ChevronDown size={13} aria-hidden="true" /></label>
        </div>
        {report.risksTruncated && <p className="truncated-note">风险明细达到显示上限，指标卡保留风险总数。</p>}
        <div className="risk-list">
          {risks.length ? risks.map((risk, index) => <RiskCard risk={risk} key={index} />) : <div className="risk-empty"><CircleCheck size={24} /><p>{report.risks.length ? '当前筛选下没有风险' : '未发现可展示的风险'}</p>
            {report.risks.length > 0 && <button className="text-button" onClick={() => { setSeverity('all'); setCategory('all'); }}>清除筛选</button>}</div>}
        </div>
      </div>
      <Checklist completeness={report.completeness} />
    </div>
  </section>;
}

async function writeClipboard(value: string) {
  if (navigator.clipboard) {
    try { await navigator.clipboard.writeText(value); return; } catch { /* Use the legacy fallback below. */ }
  }
  const focused = document.activeElement;
  const field = document.createElement('textarea');
  field.value = value;
  field.className = 'clipboard-helper';
  document.body.appendChild(field);
  try {
    field.select();
    if (!document.execCommand('copy')) throw new Error('Clipboard unavailable');
  } finally {
    field.remove();
    if (focused instanceof HTMLElement) focused.focus();
  }
}

export default function Home() {
  const [url, setUrl] = useState('');
  const [report, setReport] = useState<ScanReport>(demoReport);
  const [isDemo, setIsDemo] = useState(true);
  const [phase, setPhase] = useState<ScanPhase | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<'commit' | 'markdown' | 'error' | null>(null);
  const busy = phase !== null;

  async function runScan(value: string) {
    if (busy) return;
    const address = value.trim();
    if (!address) { setError('请输入公开 Git 仓库的 HTTPS 地址。'); return; }
    setUrl(address);
    setError('');
    setCopied(null);
    setPhase('clone');
    try {
      setReport(await requestScan(address, setPhase));
      setIsDemo(false);
    } catch (cause) {
      setError(cause instanceof Error && ['TimeoutError', 'AbortError'].includes(cause.name)
        ? '等待扫描结果超时，请稍后重试。'
        : cause instanceof TypeError ? '无法连接扫描服务，请检查网络后重试。'
          : cause instanceof Error ? cause.message : '扫描失败，请稍后重试。');
    } finally {
      setPhase(null);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void runScan(url); }

  async function copy(kind: 'commit' | 'markdown') {
    try {
      await writeClipboard(kind === 'commit' ? report.repository.commitHash : toMarkdown(report, isDemo));
      setCopied(kind);
    } catch { setCopied('error'); }
  }

  const { repository } = report;
  return <>
    <header className="topbar"><div className="shell topbar-inner">
      <a className="brand" href="#top"><span className="brand-icon"><GitBranch size={18} /></span>Git 体检</a>
      <nav aria-label="页面导航"><a href="#overview">报告总览</a><a href="#risks">风险清单</a><a href="#review">接入建议</a></nav>
    </div></header>
    <main id="top">
      <section className="hero" aria-labelledby="hero-title"><div className="shell hero-inner">
        <h1 id="hero-title">Git 仓库接入体检</h1>
        <p>评估仓库接入就绪度，发现工程、跨平台和密钥风险。</p>
        <form className="scan-form" onSubmit={submit}>
          <label htmlFor="repo-url" className="sr-only">公开 Git 仓库 HTTPS 地址</label>
          <Link2 size={20} className="input-icon" aria-hidden="true" />
          <input id="repo-url" value={url} onChange={event => { setUrl(event.target.value); setError(''); }} placeholder="https://github.com/expressjs/express"
            inputMode="url" autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={busy} aria-invalid={Boolean(error)} aria-describedby={error ? 'scan-error' : undefined} />
          <button type="submit" className="primary-button" disabled={busy}>{busy ? <LoaderCircle size={17} className="spin" /> : <ScanLine size={17} />}<span>{busy ? '正在扫描' : '开始扫描'}</span></button>
        </form>
        <div className="examples"><span>试试示例</span>{examples.map(example => <button key={example.label} type="button" disabled={busy} onClick={() => void runScan(example.url)}><GitFork size={14} />{example.label}</button>)}
          <button type="button" disabled={busy} onClick={() => { setReport(demoReport); setIsDemo(true); setUrl(''); setError(''); setCopied(null); }}><FileText size={14} />模拟风险报告</button></div>
        {busy && <Progress phase={phase} />}
        {error && <div className="scan-error" id="scan-error" role="alert"><AlertCircle size={17} />{error}</div>}
      </div></section>

      <div className="shell content">
        <section id="overview" aria-labelledby="overview-title">
          <div className="section-heading overview-heading"><div><h2 id="overview-title">报告总览</h2><p>{isDemo ? '当前展示模拟数据，扫描公开仓库可生成实测报告。' : '基于下方提交生成的仓库接入报告。'}</p></div>
            <button className="secondary-button" type="button" onClick={() => void copy('markdown')}>{copied === 'markdown' ? <Check size={16} /> : <Copy size={16} />}{copied === 'markdown' ? '已复制 Markdown' : '复制 Markdown 报告'}</button>
          </div>
          <div className="panel repo-bar">
            <div className="repo-identity"><span className="repo-icon"><Code2 size={21} /></span><div>
              <span className="meta-label">仓库 {isDemo && <span className="demo-label">示例报告</span>}</span>
              {isDemo || repository.repoUrl.includes('****') ? <strong className="repo-name">{repository.owner}/{repository.repoName}</strong>
                : <a className="repo-name" href={repository.repoUrl} target="_blank" rel="noreferrer">{repository.owner}/{repository.repoName}</a>}
            </div></div>
            <div className="repo-meta"><span className="meta-label"><GitBranch size={14} />分支</span><code title={repository.branch}>{repository.branch}</code></div>
            <div className="repo-meta"><span className="meta-label"><GitCommitHorizontal size={14} />Commit Hash</span><div className="commit"><code title={repository.commitHash}>{repository.commitHash.slice(0, 12)}</code>
              <button className="icon-button" type="button" aria-label="复制完整 Commit Hash" title="复制完整 Commit Hash" onClick={() => void copy('commit')}>{copied === 'commit' ? <Check size={14} /> : <Copy size={14} />}</button></div></div>
            <div className="repo-meta time-meta"><span className="meta-label"><Clock3 size={14} />扫描时间 <span className="timezone">UTC+8</span></span><time dateTime={repository.scannedAt} title={repository.scannedAt}>{scanDate.format(new Date(repository.scannedAt))}</time></div>
          </div>
          <ScoreCards report={report} />
          <Indicators report={report} />
        </section>
        <RiskExplorer report={report} key={(isDemo ? 'demo' : 'scan') + repository.scannedAt} />
        <ProjectReviewPanel report={report} isDemo={isDemo} key={report.reviewId ?? repository.scannedAt} />
      </div>
    </main>
    <div className="toast-region" role="status">{copied && <div className="copy-toast">{copied === 'error' ? <AlertCircle size={17} /> : <CircleCheck size={17} />}
      {copied === 'error' ? '无法访问剪贴板，请检查浏览器权限。' : copied === 'commit' ? '已复制完整 Commit Hash' : '已复制 Markdown 报告'}
      <button type="button" className="icon-button" onClick={() => setCopied(null)} aria-label="关闭通知"><X size={14} /></button></div>}</div>
  </>;
}
