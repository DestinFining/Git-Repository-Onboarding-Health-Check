import { posix } from 'node:path';
import ts from 'typescript';

type LiteralRange = { start: number; end: number };

function visit(node: ts.Node, callback: (node: ts.Node) => void) {
  callback(node);
  ts.forEachChild(node, child => visit(child, callback));
}

function propertyName(node: ts.ObjectLiteralElementLike) {
  const name = node.name;
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : undefined;
}

function namedImport(node: ts.Node, checker: ts.TypeChecker) {
  const declaration = checker.getSymbolAtLocation(node)?.declarations?.[0];
  if (!declaration || !ts.isImportSpecifier(declaration)) return undefined;
  const specifier = declaration.parent.parent.parent.moduleSpecifier;
  if (ts.isStringLiteral(specifier)) return { name: (declaration.propertyName ?? declaration.name).text, from: specifier.text };
}

function isNormalize(node: ts.Node, checker: ts.TypeChecker) {
  const imported = namedImport(node, checker);
  return imported?.name === 'normalize' && (imported.from === 'node:path' || imported.from === 'path');
}

function isMapLookup(expression: ts.Expression, files: ts.Symbol, path: ts.Symbol, checker: ts.TypeChecker): boolean {
  if (ts.isParenthesizedExpression(expression)) return isMapLookup(expression.expression, files, path, checker);
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
    return isMapLookup(expression.operand, files, path, checker);
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    return isMapLookup(expression.left, files, path, checker) && isMapLookup(expression.right, files, path, checker);
  }
  if (!ts.isElementAccessExpression(expression) || checker.getSymbolAtLocation(expression.expression) !== files) return false;
  const key = expression.argumentExpression;
  return checker.getSymbolAtLocation(key) === path || (ts.isCallExpression(key) && key.arguments.length === 1 &&
    isNormalize(key.expression, checker) && checker.getSymbolAtLocation(key.arguments[0]) === path);
}

function isMapAccessor(node: ts.ObjectLiteralElementLike, files: ts.Symbol, checker: ts.TypeChecker) {
  if (!ts.isMethodDeclaration(node) || node.parameters.length !== 1 || node.body?.statements.length !== 1) return false;
  const statement = node.body.statements[0];
  const path = checker.getSymbolAtLocation(node.parameters[0].name);
  return !!(path && ts.isReturnStatement(statement) && statement.expression &&
    isMapLookup(statement.expression, files, path, checker));
}

function isDependencyAssertion(reference: ts.Identifier, checker: ts.TypeChecker) {
  const keys = reference.parent;
  if (!ts.isCallExpression(keys) || keys.arguments.length !== 1 || keys.arguments[0] !== reference ||
      !ts.isPropertyAccessExpression(keys.expression) || keys.expression.name.text !== 'keys' ||
      !ts.isIdentifier(keys.expression.expression) || keys.expression.expression.text !== 'Object' ||
      checker.getSymbolAtLocation(keys.expression.expression)) return false;
  let result: ts.Expression = keys;
  const member = keys.parent;
  if (ts.isPropertyAccessExpression(member) && member.name.text === 'map' && ts.isCallExpression(member.parent) &&
      member.parent.expression === member && member.parent.arguments.length === 1 &&
      isNormalize(member.parent.arguments[0], checker)) result = member.parent;
  const assertion = result.parent;
  return ts.isCallExpression(assertion) && assertion.arguments.includes(result) &&
    ts.isPropertyAccessExpression(assertion.expression) && /^(?:toEqual|toStrictEqual)$/.test(assertion.expression.name.text) &&
    ts.isCallExpression(assertion.expression.expression) && ts.isIdentifier(assertion.expression.expression.expression) &&
    assertion.expression.expression.expression.text === 'expect';
}

interface VirtualFileSystem {
  mapParam: number;
  filenameParam: number;
  optionParams: number[];
}

function isTypeCacheIteration(reference: ts.Identifier, checker: ts.TypeChecker) {
  const loop = reference.parent;
  if (!ts.isForInStatement(loop) || loop.expression !== reference || !ts.isBlock(loop.statement) ||
      loop.statement.statements.length !== 1 || !ts.isVariableDeclarationList(loop.initializer)) return false;
  const statement = loop.statement.statements[0];
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression) ||
      statement.expression.arguments.length !== 1) return false;
  const imported = namedImport(statement.expression.expression, checker);
  const binding = checker.getSymbolAtLocation(loop.initializer.declarations[0].name);
  return imported?.name === 'invalidateTypeCache' && /(?:^|\/)script\/resolveType(?:\.[cm]?ts)?$/.test(imported.from) &&
    !!binding && checker.getSymbolAtLocation(statement.expression.arguments[0]) === binding;
}

function virtualFileSystem(helper: ts.FunctionDeclaration, checker: ts.TypeChecker): VirtualFileSystem | undefined {
  if (!helper.body) return undefined;
  const params = helper.parameters.map(param => checker.getSymbolAtLocation(param.name));
  let filenameReference: ts.Identifier | undefined;
  let filenameParam = -1;
  let mapParam = -1;
  let fileSystem: ts.ObjectLiteralExpression | undefined;
  let multipleFileSystems = false;
  let optionParams: number[] = [];
  visit(helper.body, node => {
    if (!ts.isPropertyAssignment(node) || !ts.isObjectLiteralExpression(node.parent)) return;
    const argument = node.parent.parent;
    if ((!ts.isCallExpression(argument) && !ts.isNewExpression(argument)) || !argument.arguments?.includes(node.parent)) return;
    const name = propertyName(node);
    if (name === 'filename' && ts.isIdentifier(node.initializer)) {
      filenameParam = params.indexOf(checker.getSymbolAtLocation(node.initializer));
      filenameReference = node.initializer;
    }
    if (name !== 'fs' || !ts.isObjectLiteralExpression(node.initializer) || node.initializer.properties.length !== 2) return;
    const exists = node.initializer.properties.find(method => propertyName(method) === 'fileExists');
    const read = node.initializer.properties.find(method => propertyName(method) === 'readFile');
    if (!exists || !read) return;
    const options = node.parent.properties.filter(ts.isSpreadAssignment).map(spread =>
      params.indexOf(checker.getSymbolAtLocation(spread.expression)));
    if (options.includes(-1) || node.parent.properties.some(prop => !ts.isSpreadAssignment(prop) &&
        (propertyName(prop) === undefined || (propertyName(prop) === 'fs' && prop !== node)))) return;
    const parameter = params.findIndex(param => param && isMapAccessor(exists, param, checker) && isMapAccessor(read, param, checker));
    if (parameter < 0) return;
    multipleFileSystems ||= fileSystem !== undefined;
    mapParam = parameter;
    optionParams = options;
    fileSystem = node.initializer;
  });
  if (multipleFileSystems || !fileSystem) return undefined;
  const start = fileSystem.getStart();
  const end = fileSystem.getEnd();
  let mapEscapes = false;
  visit(helper.body, node => {
    if (!ts.isIdentifier(node)) return;
    const symbol = checker.getSymbolAtLocation(node);
    if (symbol && symbol === params[filenameParam] && node !== filenameReference) filenameParam = -1;
    if (symbol !== params[mapParam] || isTypeCacheIteration(node, checker)) return;
    if (node.getStart() < start || node.getEnd() > end) mapEscapes = true;
  });
  return mapEscapes ? undefined : { mapParam, filenameParam, optionParams };
}

function preservesFileSystem(value: ts.Expression | undefined) {
  return !value || (ts.isObjectLiteralExpression(value) && value.properties.every(prop =>
    propertyName(prop) !== undefined && propertyName(prop) !== 'fs'));
}

export function virtualTestPaths(path: string, content: string): Map<number, LiteralRange[]> {
  if (!/\.[cm]?[jt]sx?$/i.test(path) || !/(?:\.(?:spec|test)\.[^.]+$|(?:^|\/)__tests__\/)/i.test(path) ||
      !content.includes('fileExists') || !content.includes('readFile') || /[\u2028\u2029]/.test(content)) return new Map();
  try {
    return findLiteralRanges(posix.basename(path), content);
  } catch (error) {
    // Deeply nested source can exceed the parser stack. Keep the original findings for that file.
    if (error instanceof RangeError) return new Map();
    throw error;
  }
}

function findLiteralRanges(filename: string, content: string) {
  const ranges = new Map<number, LiteralRange[]>();
  // Bind only this source file. The scanned repository's imports and compiler settings are never loaded.
  const source = ts.createSourceFile(filename, content, ts.ScriptTarget.Latest, true);
  const program = ts.createProgram([filename], { allowJs: true, noLib: true, noResolve: true, types: [] }, {
    getSourceFile: name => name === filename ? source : undefined,
    fileExists: name => name === filename,
    readFile: name => name === filename ? content : undefined,
    getDefaultLibFileName: () => '',
    getCurrentDirectory: () => '',
    getCanonicalFileName: name => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    writeFile: () => undefined,
  });
  if (program.getSyntacticDiagnostics(source).length) return ranges;
  const checker = program.getTypeChecker();
  const helpers = new Map<ts.FunctionDeclaration, VirtualFileSystem | undefined>();
  const fixtures = new Map<ts.Symbol, { keys: ts.StringLiteral[]; filenames: ts.StringLiteral[] }>();
  const names = new Set<string>();
  const verifiedArguments = new Set<ts.Identifier>();
  visit(source, node => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.arguments.some(ts.isSpreadElement)) return;
    const helper = checker.getSymbolAtLocation(node.expression)?.valueDeclaration;
    if (!helper || !ts.isFunctionDeclaration(helper)) return;
    if (!helpers.has(helper)) helpers.set(helper, virtualFileSystem(helper, checker));
    const fs = helpers.get(helper);
    if (!fs || !fs.optionParams.every(index => preservesFileSystem(node.arguments[index] ?? helper.parameters[index].initializer))) return;
    const map = node.arguments[fs.mapParam];
    if (!map || !ts.isIdentifier(map)) return;
    const symbol = checker.getSymbolAtLocation(map);
    const declaration = symbol?.valueDeclaration;
    if (!symbol || !declaration || !ts.isVariableDeclaration(declaration) ||
        !(declaration.parent.flags & ts.NodeFlags.Const) || !declaration.initializer ||
        !ts.isObjectLiteralExpression(declaration.initializer)) return;
    const keys = declaration.initializer.properties.flatMap(prop => ts.isPropertyAssignment(prop) &&
      ts.isStringLiteral(prop.name) ? [prop.name] : []);
    if (!keys.length) return;
    const fixture = fixtures.get(symbol) ?? { keys, filenames: [] };
    const name = node.arguments[fs.filenameParam];
    if (name && ts.isStringLiteral(name)) fixture.filenames.push(name);
    fixtures.set(symbol, fixture);
    names.add(map.text);
    verifiedArguments.add(map);
  });
  visit(source, node => {
    if (!ts.isIdentifier(node) || !names.has(node.text) || verifiedArguments.has(node)) return;
    const symbol = checker.getSymbolAtLocation(node);
    if (symbol && fixtures.has(symbol) && symbol.valueDeclaration !== node.parent && !isDependencyAssertion(node, checker)) {
      fixtures.delete(symbol);
    }
  });
  for (const { keys, filenames } of fixtures.values()) {
    for (const literal of [...keys, ...filenames]) {
      const start = source.getLineAndCharacterOfPosition(literal.getStart(source));
      const end = source.getLineAndCharacterOfPosition(literal.getEnd());
      if (start.line !== end.line) continue;
      const line = start.line + 1;
      const span = { start: start.character, end: end.character };
      const existing = ranges.get(line);
      if (existing) existing.push(span);
      else ranges.set(line, [span]);
    }
  }
  return ranges;
}
