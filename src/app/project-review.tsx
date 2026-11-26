'use client';

import { LoaderCircle, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ruleReview } from '../lib/review/rules';
import type { ProjectReview, ScanReport } from '../types/report';

const difficulties = { low: '低', medium: '中', high: '高' };
const unavailable = 'AI 点评暂不可用，已基于静态规则生成基础建议。';

export function ProjectReviewPanel({ report, isDemo }: { report: ScanReport; isDemo: boolean }) {
  const { reviewId } = report;
  const [result, setResult] = useState<ProjectReview | null>(null);

  useEffect(() => {
    if (!reviewId) return;
    const controller = new AbortController();
    async function loadReview() {
      try {
        const response = await fetch('/api/ai-review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reviewId }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
        });
        const review: ProjectReview = response.ok
          ? await response.json()
          : ruleReview(report, response.status === 404 ? '点评上下文已过期，已基于静态规则生成基础建议。' : unavailable);
        if (!controller.signal.aborted) setResult(review);
      } catch {
        if (!controller.signal.aborted) setResult(ruleReview(report, unavailable));
      }
    }
    void loadReview();
    return () => controller.abort();
  }, [report, reviewId]);

  const review = result ?? (reviewId ? null : ruleReview(report, isDemo ? '示例报告使用静态规则生成基础建议。' : unavailable));
  return <section id="review" className="review-section" aria-labelledby="review-title">
    <div className="section-heading"><h2 id="review-title">接入建议与架构点评</h2></div>
    {!review ? <div className="panel review-loading" role="status"><LoaderCircle className="spin" size={18} aria-hidden="true" />正在生成接入建议，基础报告已可查看。</div>
      : <div className="panel review-panel">
        <div className="panel-heading"><Sparkles size={16} aria-hidden="true" /><h3>项目定位与接入难度</h3><span className="review-source">{review.source === 'ai' ? 'AI 点评' : '静态规则'}</span></div>
        {review.message && <p className="review-notice" role="status">{review.message}</p>}
        <div className="review-overview">
          <div className="review-copy">
            <p className="review-position">{review.positioning}</p>
            <h4>架构点评</h4><p>{review.architecture}</p>
            <h4>上手难度 <span className="review-difficulty">{difficulties[review.difficulty]}</span></h4><p>{review.difficultyReason}</p>
          </div>
          <dl className="review-scores">
            <div><dt>规则评分</dt><dd>{report.readiness.total}<span> / 100</span></dd></div>
            <div><dt>AI 综合评分</dt><dd>{review.aiScore === null ? <span>未生成</span> : <>{review.aiScore}<span> / 100</span></>}</dd></div>
          </dl>
        </div>
        <div className="review-actions">
          <div><h4>本地启动指南</h4><ol>{review.startupSteps.map((step, index) => <li key={index}>{step}</li>)}</ol></div>
          <div><h4>优先整改 · Top 3</h4><ol>{review.priorities.map((item, index) => <li key={index}>{item}</li>)}</ol></div>
        </div>
      </div>}
  </section>;
}
