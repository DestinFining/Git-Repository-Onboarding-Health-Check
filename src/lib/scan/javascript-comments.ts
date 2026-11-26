import ts from 'typescript';

export function maskJavaScriptBlockComments(path: string, content: string) {
  if (!/\.[cm]?[jt]sx?$/i.test(path) || !content.includes('/*')) return content;

  try {
    return maskComments(path, content);
  } catch (error) {
    if (error instanceof RangeError) return content;
    throw error;
  }
}

function maskComments(path: string, content: string) {
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest);
  const comments = new Map<number, number>();
  const pending: ts.Node[] = [source];

  // Use token boundaries so comment markers inside strings, templates and regex literals stay intact.
  while (pending.length) {
    const node = pending.pop()!;
    if (ts.isJSDoc(node)) continue;
    if (node.kind > ts.SyntaxKind.LastToken) {
      for (const child of node.getChildren(source)) pending.push(child);
      continue;
    }
    const from = node.getFullStart();
    const until = node.getStart(source);
    if (from === until) continue;
    for (const range of [...ts.getLeadingCommentRanges(content, from) ?? [], ...ts.getTrailingCommentRanges(content, from) ?? []]) {
      if (range.kind === ts.SyntaxKind.MultiLineCommentTrivia && range.end <= until) comments.set(range.pos, range.end);
    }
  }

  if (!comments.size) return content;
  const chunks: string[] = [];
  let offset = 0;
  for (const [start, end] of [...comments].sort(([a], [b]) => a - b)) {
    chunks.push(content.slice(offset, start), content.slice(start, end).replace(/[^\r\n]/g, ' '));
    offset = end;
  }
  chunks.push(content.slice(offset));
  return chunks.join('');
}
