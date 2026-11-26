import { readJsonBody } from '../../../lib/http.ts';
import { getReview } from '../../../lib/review/service.ts';

export const runtime = 'nodejs';
export const maxDuration = 20;

export async function POST(request: Request): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' };
  const input = await readJsonBody(request.body, 1024).catch(() => null);
  if (!input || typeof input !== 'object' || !('reviewId' in input) || typeof input.reviewId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.reviewId)) {
    return Response.json({ error: { code: 'INVALID_REVIEW_ID' } }, { status: 400, headers });
  }
  const review = await getReview(input.reviewId);
  if (!review) return Response.json({ error: { code: 'REVIEW_EXPIRED' } }, { status: 404, headers });
  return Response.json(review, { headers });
}
