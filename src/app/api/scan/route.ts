import { analyzeRepository, redactText } from '../../../lib/scan/checks.ts';
import { parseRepositoryUrl, ScanError, withRepository } from '../../../lib/scan/repository.ts';
import { calculateScore } from '../../../lib/scan/score.ts';
import { readJsonBody } from '../../../lib/http.ts';
import { prepareReview } from '../../../lib/review/context.ts';
import { registerReview } from '../../../lib/review/service.ts';
import type { ScanEvent, ScanPhase, ScanReport } from '../../../types/report.ts';

export const runtime = 'nodejs';
export const maxDuration = 70;

const maxRequestBytes = 4096;
const maxConcurrentScans = 2;
let activeScans = 0;

const errors = {
  INVALID_REQUEST: { status: 400, message: '请提交包含 repoUrl 字符串的 JSON 请求。' },
  INVALID_URL: { status: 400, message: '请输入受支持的公开 Git HTTPS 仓库根地址。' },
  REPOSITORY_UNAVAILABLE: { status: 502, message: '无法访问仓库。请确认仓库存在、已公开，并重试。' },
  SCAN_TIMEOUT: { status: 504, message: '克隆或扫描超时。' },
  SCAN_LIMIT: { status: 422, message: '仓库超出扫描容量限制。' },
  SCAN_BUSY: { status: 429, message: '扫描任务已满，请稍后重试。' },
  INTERNAL_ERROR: { status: 500, message: '扫描服务暂时无法完成请求。' },
};

function errorResponse(code: keyof typeof errors) {
  const { message, status } = errors[code];
  return Response.json({ error: { code, message } }, { status });
}

function scanErrorCode(error: unknown) {
  if (error instanceof ScanError) return error.code;
  console.error('Repository scan failed.');
  return 'INTERNAL_ERROR';
}

export async function POST(request: Request): Promise<Response> {
  let input: unknown;
  try {
    input = await readJsonBody(request.body, maxRequestBytes);
  } catch {
    return errorResponse('INVALID_REQUEST');
  }
  if (!input || typeof input !== 'object' || !('repoUrl' in input) || typeof input.repoUrl !== 'string') {
    return errorResponse('INVALID_REQUEST');
  }

  let repository: ReturnType<typeof parseRepositoryUrl>;
  try {
    repository = parseRepositoryUrl(input.repoUrl);
  } catch {
    return errorResponse('INVALID_URL');
  }
  if (activeScans >= maxConcurrentScans) return errorResponse('SCAN_BUSY');

  activeScans++;
  const repoUrl = input.repoUrl;
  async function scan(onPhase?: (phase: ScanPhase) => void) {
    try {
      onPhase?.('clone');
      const { report, prepared } = await withRepository(repoUrl, snapshot => {
        onPhase?.('risks');
        const checks = analyzeRepository(snapshot);
        onPhase?.('report');
        const report: ScanReport = {
          repository: {
            repoUrl: redactText(repository.repoUrl),
            owner: redactText(repository.owner),
            repoName: redactText(repository.repoName),
            branch: redactText(snapshot.branch),
            commitHash: snapshot.commitHash,
            scannedAt: new Date().toISOString(),
          },
          ...checks,
          ...calculateScore(checks),
        };
        return { report, prepared: prepareReview(snapshot, report) };
      }, () => onPhase?.('structure'));
      return { ...report, reviewId: registerReview(report, prepared) };
    } finally {
      activeScans--;
    }
  }

  if (request.headers.get('accept')?.includes('application/x-ndjson')) {
    const encoder = new TextEncoder();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        function send(event: ScanEvent) {
          if (!cancelled) controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
        }
        try {
          const report = await scan(phase => send({ type: 'phase', phase }));
          send({ type: 'report', report });
        } catch (error) {
          const code = scanErrorCode(error);
          send({ type: 'error', error: { code, message: errors[code].message } });
        } finally {
          if (!cancelled) controller.close();
        }
      },
      cancel() {
        cancelled = true;
      },
    });
    return new Response(body, {
      headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' },
    });
  }

  try {
    const report = await scan();
    return Response.json(report, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return errorResponse(scanErrorCode(error));
  }
}
