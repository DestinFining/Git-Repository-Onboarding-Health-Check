export async function readJsonBody(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<unknown> {
  if (!body) throw new Error('Missing body');
  const reader = body.getReader();
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    let text = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(text + decoder.decode());
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new Error('Body exceeds limit');
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}
