import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { POST } from '../src/app/api/scan/route.ts';
import { POST as POSTReview } from '../src/app/api/ai-review/route.ts';
import { demoReport } from '../src/lib/demo-report.ts';
import { requestScan, toMarkdown } from '../src/lib/report-display.ts';
import { prepareReview } from '../src/lib/review/context.ts';
import { registerReview } from '../src/lib/review/service.ts';
import { analyzeRepository } from '../src/lib/scan/checks.ts';
import { maxFileBytes, parseRepositoryUrl, readRepositorySnapshot } from '../src/lib/scan/repository.ts';
import { calculateScore } from '../src/lib/scan/score.ts';

const readme = [
  '# Install', 'Install the required Node.js version and use the lock file to install dependencies.',
  '# Usage', 'Start the local server with npm run dev and open the application in a browser.',
  '# Environment', 'Copy the environment template and set the variables required by your deployment.',
].join('\n');

// Assemble synthetic key markers at runtime so repository scans don't flag the test source.
const openSshKeyLabel = 'OPENSSH PRIVATE KEY';
const privateKeyHeader = `-----BEGIN ${openSshKeyLabel}-----`;
const privateKeyFooter = `-----END ${openSshKeyLabel}-----`;

function analyze(files, unreadPaths = []) {
  const checks = analyzeRepository({
    branch: 'main',
    commitHash: '0'.repeat(40),
    files: Object.keys(files).map(path => ({ path })),
    contents: new Map(Object.entries(files).filter(([path]) => !unreadPaths.includes(path))),
    unreadPaths: new Set(unreadPaths),
  });
  return { ...checks, ...calculateScore(checks) };
}

test('normalizes public Git HTTPS roots and rejects unsafe inputs', () => {
  assert.deepEqual(parseRepositoryUrl('https://GitHub.com/octocat/.github.git/'), {
    repoUrl: 'https://github.com/octocat/.github', owner: 'octocat', repoName: '.github',
  });
  assert.equal(parseRepositoryUrl('https://gitlab.com/org/group/project').owner, 'org/group');
  for (const input of [
    'http://github.com/a/b', 'https://github.com/../b', 'https://github.com/a/b;whoami',
    'https://github.com/a/b%0a', 'https://github.com/a/b?x=1', 'https://github.com/a/b#main',
    'https://github.com/a/b/tree/main', 'https://gitlab.com/a/b/-/tree/main',
    'https://github.com@evil.com/a/b', 'https://github.com:443/a/b', 'https://github.com/a/b\n',
    'https://github.com.evil.example/a/b', 'https://127.0.0.1/a/b', 'file:///C:/repo',
  ]) assert.throws(() => parseRepositoryUrl(input), { code: 'INVALID_URL' });
});

test('scores a complete portable project and ignores ordinary comments, URLs and regexes', () => {
  const report = analyze({
    'README.en.md': readme,
    'package.json': '{"scripts":{"build":"tsc"}}',
    '.env.example': 'PORT=3000',
    'src/main.js': [
      "let url = 'https://example.test/home/alice/project';",
      '// Common locations include /home/alice/project',
      'const label = 1; // example /root/work',
      String.raw`const regex = /\/home\/alice\//;`,
    ].join('\n'),
  });
  assert.equal(report.readiness.total, 100);
  assert.deepEqual(Object.values(report.readiness.dimensions).map(item => item.maxPoints), [40, 30, 30]);
  assert.equal(report.scoreBreakdown.length, 8);
  assert.ok(report.scoreBreakdown.every(item => item.reason && item.deductedPoints === 0));
  assert.deepEqual(report.risks, []);
});

test('finds path, Windows and environment risks and masks every supported secret pattern', () => {
  const tokens = [
    'sk-' + 'o'.repeat(23), 'AKID' + 't'.repeat(12), 'LTAI' + 'a'.repeat(12), 'AKIA' + '7'.repeat(16),
    'b'.repeat(25), 'ghp_' + 'g'.repeat(36), 'github_pat_' + 'p'.repeat(25),
  ];
  const report = analyze({
    'README.md': readme + '\n\n' + 'Run with ' + String.fromCharCode(96) + 'cmd /c setup.cmd' + String.fromCharCode(96),
    'package.json': JSON.stringify({ scripts: { start: 'set MODE=local && powershell -File setup.ps1' } }),
    'scripts/setup.bat': '@echo off',
    'scripts/setup.cmd': '@echo off',
    'scripts/setup.ps1': 'Write-Output hello',
    'scripts/setup.vbs': 'WScript.Echo "hello"',
    '.env.local': tokens.slice(0, 4).join('\n'),
    '.env.production.example': 'PLACEHOLDER=unset',
    'config/settings.json': JSON.stringify({ output: 'D:\\project\\output', root: '/Users/alice/app', cache: '/root/cache' }, null, 2),
    'src/client.js': ['Bearer', ...tokens.slice(4), privateKeyHeader].join('\n'),
    ['nested/' + tokens[0] + '.txt']: 'text',
  });
  assert.equal(report.readiness.total, 40);
  assert.equal(report.scoreBreakdown.reduce((sum, item) => sum + item.deductedPoints, 0), 60);
  assert.deepEqual(report.portability.hardcodedPaths.filePaths, ['config/settings.json']);
  assert.equal(report.risks.filter(risk => risk.title === '硬编码绝对路径').length, 3);
  assert.equal(report.risks.filter(risk => risk.category === 'portability').length, 9);
  assert.deepEqual(report.security.trackedEnvFiles.filePaths, ['.env.local']);
  assert.equal(report.risks[0].severity, 'High');
  const json = JSON.stringify(report);
  for (const token of tokens) {
    assert.ok(!json.includes(token));
    assert.ok(json.includes(token.slice(0, 4) + '****' + token.slice(-4)));
  }
  assert.deepEqual(report.security.privateKeys.filePaths, ['src/client.js']);
  assert.ok(!json.includes(privateKeyHeader));
  assert.ok(report.risks.some(risk => risk.lineNumber === 1 && risk.redactedSnippet === 'Bearer bbbb****bbbb'));
});

test('reports missing documentation and skips checks with incomplete scan coverage', () => {
  const empty = analyze({});
  assert.equal(empty.completeness.readme.status, 'fail');
  assert.equal(empty.readiness.total, 60);
  const partial = analyze({ 'README.md': 'too large', 'package.json': 'too large' }, ['README.md', 'package.json']);
  assert.equal(partial.completeness.readme.status, 'skipped');
  assert.equal(partial.completeness.startupScript.status, 'skipped');
  assert.equal(partial.security.exposedSecrets.status, 'skipped');
  assert.equal(partial.security.trackedEnvFiles.status, 'pass');
  const weak = analyze({ 'README.md': '# Install\nnpm install' });
  assert.equal(weak.completeness.readme.status, 'fail');
  assert.match(weak.completeness.readme.summary, /运行、配置/);
  assert.deepEqual(weak.completeness.readme.sections.map(section => section.status), ['pass', 'fail', 'fail']);
});

test('reads an actual Git commit with filtering, binary detection and no working-tree reads', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'repo-health-test-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
  try {
    git('init', '--initial-branch=scan-test', '--template=');
    git('config', 'core.autocrlf', 'false');
    const fixture = {
      'README.md': readme,
      'Makefile': 'start:\n\t@echo start\n',
      'go.mod': 'module fixture\n',
      'node_modules/pkg/ignored.ps1': 'ignored',
      'vendor/.env': 'ignored',
      'dist/bundle.js': 'ignored',
      'build/output.js': 'ignored',
      '__pycache__/ignored.pyc': 'ignored',
      'image.png': 'content should still be ignored',
      'unknown.data': Buffer.from([0, 1, 2, 0xff]),
      'boundary.txt': Buffer.alloc(maxFileBytes, 'x'),
      'large.txt': Buffer.alloc(maxFileBytes + 1, 'x'),
      'utf16.ps1': Buffer.from('\uFEFFWrite-Output hello', 'utf16le'),
    };
    for (const [path, content] of Object.entries(fixture)) {
      const absolutePath = join(cwd, path);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content);
    }
    git('add', '--force', '--all');
    const blob = git('hash-object', '-w', 'README.md');
    git('update-index', '--add', '--cacheinfo', '120000,' + blob + ',ignored-link');
    git('-c', 'user.name=Scan Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Fixture');
    await writeFile(join(cwd, 'README.md'), 'uncommitted replacement');
    await writeFile(join(cwd, 'untracked.cmd'), 'untracked');
    const snapshot = await readRepositorySnapshot(cwd);
    assert.equal(snapshot.branch, 'scan-test');
    assert.equal(snapshot.commitHash, git('rev-parse', 'HEAD'));
    assert.equal(snapshot.contents.get('README.md'), readme);
    assert.equal(snapshot.contents.get('utf16.ps1'), 'Write-Output hello');
    assert.equal(snapshot.contents.get('boundary.txt').length, maxFileBytes);
    assert.deepEqual([...snapshot.unreadPaths], ['large.txt']);
    for (const path of ['image.png', 'unknown.data', 'large.txt']) assert.equal(snapshot.contents.has(path), false);
    for (const path of Object.keys(fixture).filter(path => path.includes('/')).concat('untracked.cmd', 'ignored-link')) {
      assert.ok(!snapshot.files.some(file => file.path === path));
    }
    assert.deepEqual(analyzeRepository(snapshot).portability.windowsOnlyScripts.filePaths, ['utf16.ps1']);
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('POST returns stable errors for invalid JSON, invalid URLs and oversized bodies', async () => {
  for (const [body, code] of [
    ['{', 'INVALID_REQUEST'],
    [JSON.stringify({ repoUrl: 12 }), 'INVALID_REQUEST'],
    [JSON.stringify({ repoUrl: 'https://github.com/a/b?token=untrusted' }), 'INVALID_URL'],
    [JSON.stringify({ repoUrl: 'x'.repeat(5000) }), 'INVALID_REQUEST'],
  ]) {
    const response = await POST(new Request('http://localhost/api/scan', { method: 'POST', body }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, code);
  }
});

test('the report client handles split UTF-8 events and retains server error messages', async t => {
  const phase = 'clone';
  const data = new TextEncoder().encode([
    JSON.stringify({ type: 'phase', phase }),
    JSON.stringify({ type: 'report', report: demoReport }),
  ].join('\n'));
  const chunks = new ReadableStream({ start(controller) {
    for (let start = 0; start < data.length; start += 17) controller.enqueue(data.slice(start, start + 17));
    controller.close();
  } });
  const headers = { 'Content-Type': 'application/x-ndjson' };
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(chunks, { headers }));
  const phases = [];
  const report = await requestScan(demoReport.repository.repoUrl, value => phases.push(value));
  assert.deepEqual(phases, [phase]);
  assert.deepEqual(report, demoReport);
  assert.match(toMarkdown(report, true), /示例报告[\s\S]*75\/100[\s\S]*sk-d\*{4}9a2f/);

  fetch.mock.mockImplementation(async () => new Response(JSON.stringify({ type: 'error', error: { message: '克隆或扫描超时。' } }), { headers }));
  await assert.rejects(requestScan(demoReport.repository.repoUrl, () => {}), /克隆或扫描超时/);
});

test('AI context projects repository content onto safe facts before external transmission', () => {
  const knownKey = 'sk-' + 'q'.repeat(30);
  const privateName = 'InternalName123';
  const unknownKey = 'local-secret-example-QxZ!';
  const files = {
    'README.md': ['# Express web framework', knownKey, 'Password: server', unknownKey, 'postgres://root:somepass@localhost/db',
      privateKeyHeader, 'privatekeybody8865', privateKeyFooter,
      '_'.repeat(1500), 'analytics'].join('\n'),
    'package.json': JSON.stringify({
      name: privateName, scripts: { dev: 'node server.js --token ' + unknownKey },
      dependencies: { express: 'https://root:' + unknownKey + '@example.test', [unknownKey]: '1' },
    }),
    'package-lock.json': '',
    ['src/' + privateName + '/deep-nested.ts']: '',
    '.env.production': 'TOKEN=' + unknownKey,
  };
  const prepared = prepareReview({
    files: Object.keys(files).map(path => ({ path })), contents: new Map(Object.entries(files)),
  }, analyze(files));
  const json = JSON.stringify(prepared.context);
  for (const value of [knownKey, privateName, unknownKey, 'somepass', 'privatekeybody8865', 'deep-nested', '.env.production', 'analytics', 'node server.js']) {
    assert.ok(!json.includes(value), value);
  }
  assert.doesNotMatch(prepared.context.readmeExcerpt, /server/);
  assert.match(prepared.context.readmeExcerpt, /express web framework/);
  assert.deepEqual(prepared.context.dependencies.packageSamples[0].fields.knownDependencies, ['express']);
  assert.equal(prepared.context.scan.riskCounts.High, 3);
  assert.ok(prepared.verifiedSteps.some(step => step.includes('npm ci')));
  assert.ok(prepared.verifiedSteps.some(step => step.includes('npm run dev')));
});

test('review API handles missing key, invalid output, concurrent requests and a compatible provider', async t => {
  const fields = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'];
  const old = fields.map(field => process.env[field]);
  t.after(() => fields.forEach((field, index) => {
    if (old[index] === undefined) delete process.env[field];
    else process.env[field] = old[index];
  }));
  const prepared = prepareReview({ files: [], contents: new Map() }, demoReport);
  const reviewId = registerReview(demoReport, prepared);
  const call = (id = reviewId) => POSTReview(new Request('http://localhost/api/ai-review', {
    method: 'POST', body: JSON.stringify({ reviewId: id }),
  }));
  assert.equal((await call('invalid')).status, 400);
  assert.equal((await call(randomUUID())).status, 404);
  delete process.env.OPENAI_API_KEY;
  const rules = await (await call()).json();
  assert.equal(rules.source, 'rules');
  assert.equal(rules.aiScore, null);
  assert.match(rules.message, /未配置 AI Key/);
  assert.equal(rules.priorities.length, 3);

  process.env.OPENAI_API_KEY = 'test-provider-key-fixture';
  process.env.OPENAI_BASE_URL = 'https://provider.example.test/api/v4/';
  process.env.OPENAI_MODEL = 'compatible-test-model';
  const provider = t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ message: { content: '{}' } }] }));
  assert.equal((await (await call()).json()).source, 'rules');
  const expected = {
    positioning: 'Web 项目', architecture: '服务与依赖分离。', difficulty: 'medium', difficultyReason: '需要配置环境。',
    aiScore: 82, startupSteps: ['检查 README。', '运行已记录的入口。'], priorities: ['优先修复泄露。', '移除硬编码。', '补齐验证。'],
  };
  provider.mock.mockImplementation(async (url, options) => {
    assert.equal(url.href, 'https://provider.example.test/api/v4/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer ' + process.env.OPENAI_API_KEY);
    assert.ok(!options.body.includes(process.env.OPENAI_API_KEY));
    assert.equal(JSON.parse(options.body).model, 'compatible-test-model');
    assert.equal(options.redirect, 'error');
    return Response.json({ choices: [{ message: { content: JSON.stringify(expected) } }] });
  });
  const [first, second] = await Promise.all([call(), call()]);
  assert.deepEqual(await first.json(), { source: 'ai', ...expected });
  assert.deepEqual(await second.json(), { source: 'ai', ...expected });
  assert.equal(provider.mock.callCount(), 2);
});
