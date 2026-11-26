import { posix } from 'node:path';
import ts from 'typescript';

const blank = (text: string) => text.replace(/[^\r\n]/g, ' ');

function maskScriptPaths(path: string, content: string) {
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  const pending: ts.Node[] = [source];
  const calls: ts.CallExpression[] = [];
  const declarations = new Map<string, ts.Node | undefined>();
  const literals: ts.Node[] = [];
  const testFile = /\.(?:spec|test)\.[^.]+$|(?:^|\/)(?:__tests__|tests?)\//i.test(path);
  while (pending.length) {
    const node = pending.pop()!;
    ts.forEachChild(node, child => { pending.push(child); });
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) calls.push(node);
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isImportClause(node) || ts.isImportSpecifier(node) ||
        ts.isNamespaceImport(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
        node.name && ts.isIdentifier(node.name)) {
      const name = node.name.text;
      declarations.set(name, declarations.has(name) ? undefined : node);
    }
  }
  const isModule = (call: ts.Node, module: RegExp) => ts.isCallExpression(call) &&
    ts.isIdentifier(call.expression) && call.expression.text === 'require' &&
    call.arguments.length === 1 && ts.isStringLiteral(call.arguments[0]) && module.test(call.arguments[0].text);
  const isImported = (node: ts.Node | undefined, module: RegExp) => {
    while (node && !ts.isImportDeclaration(node) && !ts.isStatement(node)) node = node.parent;
    return !!node && ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && module.test(node.moduleSpecifier.text);
  };
  const express = /^express$/;
  const isExpressFactory = (node: ts.Expression) => {
    if (isModule(node, express)) return true;
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'Router') node = node.expression;
    if (!ts.isIdentifier(node)) return isModule(node, express);
    const declaration = declarations.get(node.text);
    return isImported(declaration, express) ||
      (!!declaration && ts.isVariableDeclaration(declaration) && !!declaration.initializer && isModule(declaration.initializer, express));
  };
  for (const node of calls) {
    if (!ts.isPropertyAccessExpression(node.expression)) continue;
    const { expression: receiver, name } = node.expression;
    const declaration = ts.isIdentifier(receiver) ? declarations.get(receiver.text) : undefined;
    const handler = node.arguments[1];
    const verifiedRouter = !!declaration && ts.isVariableDeclaration(declaration) && declaration.initializer &&
      ts.isCallExpression(declaration.initializer) && isExpressFactory(declaration.initializer.expression);
    const routeExample = ts.isIdentifier(receiver) && !declarations.has(receiver.text) &&
      /(?:^|\/)(?:routes?|router)(?:\/|\.)/i.test(path) && !!handler && ts.isIdentifier(handler) && /handler$/i.test(handler.text);
    const route = (verifiedRouter || routeExample) &&
      /^(?:all|get|post|put|patch|delete|head|options|use|route)$/.test(name.text) &&
      (node.arguments.length >= 2 || name.text === 'route');
    const assertion = testFile && /^(?:toBe|toEqual|toStrictEqual)$/.test(name.text) &&
      ts.isCallExpression(receiver) && ts.isIdentifier(receiver.expression) && receiver.expression.text === 'expect';
    const assertModule = /^(?:node:)?assert(?:\/strict)?$/;
    const nodeAssertion = testFile && /^(?:equal|strictEqual|deepEqual|deepStrictEqual)$/.test(name.text) &&
      ts.isIdentifier(receiver) && (isImported(declaration, assertModule) ||
        (!!declaration && ts.isVariableDeclaration(declaration) && !!declaration.initializer && isModule(declaration.initializer, assertModule)) ||
        (receiver.text === 'assert' && !declarations.has(receiver.text)));
    const argument = node.arguments[nodeAssertion ? 1 : 0];
    if (!argument) continue;
    if (ts.isStringLiteralLike(argument) &&
        (assertion || nodeAssertion || (route && argument.text.startsWith('/')))) literals.push(argument);
    if (route && ts.isTemplateExpression(argument) && argument.head.text.startsWith('/')) {
      literals.push(argument.head, ...argument.templateSpans.map(span => span.literal));
    }
  }
  let offset = 0;
  const chunks: string[] = [];
  for (const literal of literals.sort((a, b) => a.getStart(source) - b.getStart(source))) {
    const start = literal.getStart(source);
    chunks.push(content.slice(offset, start), blank(content.slice(start, literal.end)));
    offset = literal.end;
  }
  return chunks.length ? chunks.join('') + content.slice(offset) : content;
}

function maskShortMount(value: string) {
  const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
  const source = quoted ? quoted[2] : value;
  const separator = /:(?=\/|[a-z]:[\\/])/ig;
  if (/^[a-z]:[\\/]/i.test(source)) separator.lastIndex = 2;
  const match = separator.exec(source);
  if (match) {
    const end = match.index + 1 + Number(!!quoted);
    return value.slice(0, end) + blank(source.slice(match.index + 1)) + (quoted?.[1] ?? '');
  }
  if (/^(?:\/|[a-z]:[\\/])/i.test(source) && !/:(?![\\/])/.test(source)) {
    return blank(value);
  }
  return value;
}

function maskComposeTargets(content: string) {
  const sections: Array<{ indent: number; name: string }> = [];
  let longMountIndent: number | undefined;
  return content.replace(/^[^\r\n]+/gm, line => {
    if (/^\s*(?:#|$)/.test(line)) return line;
    const indent = line.length - line.trimStart().length;
    const item = /^\s*-\s+/.exec(line);
    while (sections.length && sections.at(-1)!.indent >= indent &&
        !(item && sections.at(-1)!.indent === indent && sections.at(-1)!.name === 'volumes')) sections.pop();
    const inline = /^(\s*volumes\s*:\s*\[)(.*)(\]\s*(?:#.*)?)$/.exec(line);
    if (inline && sections.length === 2 && sections[0].name === 'services') {
      if (/[{}\[\]]/.test(inline[2].replace(/"(?:\\.|[^"\\])*"|'(?:''|[^'])*'/g, ''))) return line;
      const values = inline[2].replace(/"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^,\s][^,]*?(?=\s*(?:,|$))/g, maskShortMount);
      return inline[1] + values + inline[3];
    }
    const inVolumes = sections.length === 3 && sections[0].name === 'services' && sections[2].name === 'volumes';
    if (!inVolumes || item || (longMountIndent !== undefined && indent <= longMountIndent)) longMountIndent = undefined;
    if (inVolumes && longMountIndent !== undefined) {
      const target = /^\s*target\s*:\s*/.exec(line);
      if (target) return target[0] + blank(line.slice(target[0].length));
    }
    if (item && inVolumes) {
      const value = line.slice(item[0].length);
      const field = /^(?:type|source|target)\s*:\s+/.exec(value);
      if (field) {
        longMountIndent = indent;
        if (field[0].startsWith('target')) {
          const start = item[0].length + field[0].length;
          return line.slice(0, start) + blank(line.slice(start));
        }
        return line;
      }
      const scalar = /^(?:"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|\S+)/.exec(value)?.[0];
      if (scalar) return item[0] + maskShortMount(scalar) + value.slice(scalar.length);
    }
    const key = /^\s*([\w.-]+)\s*:\s*(?:#.*)?$/.exec(line);
    if (key) sections.push({ indent, name: key[1] });
    return line;
  });
}

function maskDockerPaths(content: string) {
  const escape = /^\s*#\s*escape\s*=\s*([\\`])/im.exec(content)?.[1] ?? '\\';
  let continued = false;
  let copy = false;
  const heredocs: string[] = [];
  return content.replace(/^[^\r\n]+/gm, line => {
    if (heredocs.length && !continued) {
      if (line.trim() === heredocs[0]) heredocs.shift();
      return line;
    }
    if (/^\s*#/.test(line)) return line;
    if (!continued) {
      copy = /^\s*(?:WORKDIR|COPY|ADD)\s+/i.test(line);
    }
    const markers = [...line.matchAll(/(?:^|\s)<<-?['"]?([\w.-]+)['"]?(?=\s|$)/g)];
    heredocs.push(...markers.map(match => match[1]));
    continued = line.trimEnd().endsWith(escape);
    if (!copy || markers.length) return line;
    // COPY and ADD read from the build context or a stage, and write into the image.
    return blank(line);
  });
}

export function maskNonFilesystemPaths(path: string, content: string): string {
  const name = posix.basename(path);
  if (/\.[cm]?[jt]sx?$/i.test(name)) {
    try {
      return maskScriptPaths(path, content);
    } catch (error) {
      if (error instanceof RangeError) return content;
      throw error;
    }
  }
  if (/^(?:dockerfile|containerfile)(?:\..+)?$/i.test(name) || /\.dockerfile$/i.test(name)) return maskDockerPaths(content);
  if (/^(?:docker-)?compose(?:\.[\w.-]+)?\.ya?ml$/i.test(name)) return maskComposeTargets(content);
  if (/\.go$/i.test(name)) {
    return content.replace(/"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|`[^`]*`|\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)/g,
      token => token.startsWith('/*') ? blank(token) : token);
  }
  if (/\.pyw?$/i.test(name)) {
    const strings = /(?:[rubf]{0,2})(?:"""(?:\\[\s\S]|(?!""")[^\\])*"""|'''(?:\\[\s\S]|(?!''')[^\\])*''')|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|#[^\r\n]*|[()[\]{}]/gi;
    const brackets: Array<{ token: string; index: number }> = [];
    const lineStart = (index: number) => Math.max(content.lastIndexOf('\n', index - 1), content.lastIndexOf('\r', index - 1)) + 1;
    return content.replace(strings, (token, index: number) => {
      if (token.length === 1 && '([{'.includes(token)) brackets.push({ token, index });
      if (token.length === 1 && ')]}'.includes(token)) brackets.pop();
      if (!/^[ru]?(?:"""|''')/i.test(token)) return token;
      const tail = content.slice(index + token.length);
      const endOfStatement = /^[ \t]*(?:#|[\r\n]|$)/;
      if (!brackets.length && /^[ \t]*$/.test(content.slice(lineStart(index), index)) && endOfStatement.test(tail)) {
        return blank(token);
      }
      const opening = brackets[0];
      if (brackets.length === 1 && opening.token === '(' &&
          /^[ \t]*$/.test(content.slice(lineStart(opening.index), opening.index)) &&
          /^\s*$/.test(content.slice(opening.index + 1, index))) {
        const closing = /^\s*\)/.exec(tail);
        if (closing && endOfStatement.test(tail.slice(closing[0].length))) return blank(token);
      }
      return token;
    });
  }
  if (/\.json$/i.test(name)) {
    return content.replace(/("(?:description|summary)"\s*:\s*)("(?:\\.|[^"\\])*")|"(?:\\.|[^"\\])*"/gi,
      (match, key?: string, value?: string) => {
        const prose = value && (/^"[a-z]+[ \t]+\S/i.test(value) ||
          /^"\S+[ \t]+(?:is|are|was|were|can|may|should|must|contains?|points?)[ \t]+\S/i.test(value));
        return key && value && prose ? key + blank(value) : match;
      });
  }
  return content;
}
