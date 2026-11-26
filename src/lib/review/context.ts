import { posix } from 'node:path';
import type { ScanReport } from '../../types/report.ts';
import { getRiskCounts } from '../report-display.ts';
import { omitSecretMatches } from '../scan/checks.ts';
import type { RepositorySnapshot } from '../scan/repository.ts';

const names = new Set([
  'src', 'app', 'apps', 'packages', 'services', 'server', 'client', 'frontend', 'backend', 'api', 'lib', 'internal',
  'cmd', 'pkg', 'scripts', 'config', 'configs', 'test', 'tests', '__tests__', 'docs', 'examples', 'public', 'assets',
  'components', 'routes', 'controllers', 'models', 'migrations', 'templates', 'utils', 'middleware', 'plugins',
  'web', 'core', 'database', 'docker', '.github', 'workflows', 'readme', 'readme.md', 'license', 'dockerfile',
  'compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml', 'makefile', 'procfile', 'package.json',
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'pnpm-workspace.yaml', 'requirements.txt',
  'pyproject.toml', 'pipfile', 'go.mod', 'go.sum', 'cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'gemfile', 'composer.json', 'deno.json', 'pubspec.yaml', 'index.js', 'index.ts', 'main.go', 'main.py', 'app.py',
  'tsconfig.json', 'vite.config.ts', 'next.config.js', 'next.config.ts',
]);
const dependencyNames = [
  'react', 'react-dom', 'vue', 'svelte', 'next', 'nuxt', 'vite', 'express', 'fastify', 'koa', '@nestjs/core',
  'typescript', 'webpack', 'eslint', 'jest', 'vitest', 'tailwindcss', 'prisma', '@prisma/client', 'mongoose', 'pg',
  'redis', 'ioredis', 'axios', 'zod', 'socket.io', 'graphql', 'django', 'flask', 'fastapi', 'uvicorn', 'gunicorn',
  'sqlalchemy', 'pydantic', 'requests', 'pytest', 'celery', 'numpy', 'pandas', 'torch', 'scikit-learn',
];
const proseWords = new Set((
  'a an and are as at be by for from in is it of on or that the this to use using with your ' +
  'about documentation example examples feature features project library application starter toolkit framework service ' +
  'server client platform tool tools module modules package packages monorepo workspace web website dashboard api rest ' +
  'cli frontend backend plugin extension component components open source configuration configure install installation ' +
  'quickstart quick start getting started usage run running development production build deploy deployment environment ' +
  'local testing test database storage cache queue authentication authorization authentication docs config automation ' +
  'image images data visualization monitor monitoring analytics ecommerce blog content management generator static proxy ' +
  'file files migration migrations routing middleware network protocol real-time http node nodejs npm pnpm yarn bun ' +
  'javascript typescript python java kotlin golang go rust ruby docker compose linux windows macos kubernetes ' +
  '项目 仓库 工程 文档 安装 配置 使用 运行 启动 开发 构建 部署 环境 本地 数据 数据库 分析 图表 可视化 ' +
  '报告 检测 扫描 测试 接口 服务 服务端 客户端 前端 后端 平台 框架 工具 应用 插件 组件 模板 库 开源 ' +
  '登录 认证 权限 缓存 队列 管理 监控 搜索 博客 电商 模型 依赖 示例 脚本 容器 支持 提供 基于 用于'
).split(' ').concat(dependencyNames.filter(name => /^[a-z-]+$/.test(name))));
const cjkWords = Array.from(proseWords).filter(word => /^\p{Script=Han}+$/u.test(word)).sort((a, b) => b.length - a.length);
const readmeTokens = new RegExp(cjkWords.join('|') + '|[a-z0-9_-]+|[^\\s]', 'giu');
const sensitiveLine = /(?:secret|password|passwd|passphrase|token|credential|authorization|cookie|private[\s_-]*key|(?:api|access|client|session|signing)[\s_-]*key|密钥|密码|口令|凭据|令牌)|\b[A-Z][A-Z0-9_]*\s*=/i;
const scripts = ['dev', 'start', 'build', 'test'] as const;
const managers = ['npm', 'pnpm', 'yarn', 'bun'] as const;

function safeReadme(value: string) {
  const stripped = omitSecretMatches(value.slice(0, 1500)
    .replace(/-----BEGIN [^\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^\r\n]*PRIVATE KEY-----|$)/gi, ''));
  // Only known terms leave the server. Masking known credentials alone would miss arbitrary values.
  let fence = '';
  return stripped.split(/\r\n|\n|\r/).map(line => {
    const marker = /^\s*(\x60{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length) fence = '';
      return '';
    }
    if (marker) {
      fence = marker;
      return '[代码块已省略]';
    }
    if (sensitiveLine.test(line)) return '[已脱敏]';
    const tokens = line
      .replace(/\x60+[^\x60]*\x60+/g, ' ')
      .replace(/[a-z][a-z0-9+.-]{0,20}:\/\/\S+/gi, ' [链接] ')
      .match(readmeTokens) ?? [];
    return tokens.map(token => {
      const normalized = token.toLowerCase();
      return proseWords.has(normalized) || /^[#：:。.,!?！？]$/.test(normalized) ? normalized : '…';
    }).join(' ').replace(/(?:… ){1,}…/g, '…');
  }).join('\n').trim().slice(0, 1500);
}

function treeSummary(files: RepositorySnapshot['files']) {
  const tree = new Set<string>();
  const aliases = new Map<string, string>();
  for (const { path } of files) {
    if (/(?:^|\/)\.env(?:\.|$)/i.test(path)) continue;
    const segments = path.split('/').slice(0, 2);
    const visible = segments.map((part, index) => {
      const normalized = part.toLowerCase();
      if (names.has(normalized)) return normalized;
      const prefix = segments.slice(0, index + 1).join('/');
      if (!aliases.has(prefix)) aliases.set(prefix, '[条目 ' + (aliases.size + 1) + ']');
      return aliases.get(prefix);
    });
    for (let depth = 1; depth <= visible.length; depth++) {
      if (tree.size >= 60) return { entries: [...tree], truncated: true, trackedFiles: files.length };
      tree.add(visible.slice(0, depth).join('/'));
    }
  }
  return { entries: [...tree], truncated: false, trackedFiles: files.length };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function packageSummary(content: string) {
  let manifest: unknown;
  try { manifest = JSON.parse(content); } catch { return null; }
  if (!isObject(manifest)) return null;
  const dependencies = [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies].filter(isObject);
  const commands = isObject(manifest.scripts) ? manifest.scripts : {};
  const packageManager = typeof manifest.packageManager === 'string' ? manifest.packageManager.split('@')[0] : '';
  return {
    scriptNames: scripts.filter(name => typeof commands[name] === 'string' && commands[name].trim()),
    knownDependencies: dependencyNames.filter(name => dependencies.some(group => Object.hasOwn(group, name))),
    dependencyCount: new Set(dependencies.flatMap(Object.keys)).size,
    packageManager: managers.find(name => name === packageManager),
    workspace: Array.isArray(manifest.workspaces) || isObject(manifest.workspaces),
  };
}

export function prepareReview(snapshot: RepositorySnapshot, report: ScanReport) {
  const rootFiles = new Set(snapshot.files.filter(file => !file.path.includes('/')).map(file => file.path));
  const rootPackage = packageSummary(snapshot.contents.get('package.json') ?? '');
  const packageSamples = [...snapshot.contents].filter(([path]) => posix.basename(path) === 'package.json')
    .slice(0, 5).map(([path, content]) => ({ scope: path === 'package.json' ? 'root' : 'nested', fields: packageSummary(content) }))
    .filter(sample => sample.fields);
  const locks = [
    ['pnpm', 'pnpm-lock.yaml'], ['yarn', 'yarn.lock'], ['bun', 'bun.lock'], ['bun', 'bun.lockb'], ['npm', 'package-lock.json'],
  ];
  const manager = rootPackage?.packageManager ?? locks.find(([, file]) => rootFiles.has(file))?.[0] ?? 'npm';
  const knownManifests = [...new Set(report.completeness.dependencyManifest.filePaths
    .map(path => posix.basename(path).toLowerCase()).filter(name => names.has(name)))];
  const python = snapshot.contents.get('requirements.txt') ?? '';
  const pythonLibraries = new Set(python.split(/\r?\n/).map(line => /^[a-z0-9_-]+/i.exec(line.trim())?.[0].toLowerCase()));
  const compose = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'].find(name => rootFiles.has(name));
  const verifiedSteps: string[] = [];
  if (rootPackage) {
    const install = manager === 'npm' && rootFiles.has('package-lock.json') ? 'npm ci' : manager + ' install';
    verifiedSteps.push('在仓库根目录执行 ' + install + ' 安装依赖。');
    const script = rootPackage.scriptNames.find(name => name === 'dev' || name === 'start');
    if (script) verifiedSteps.push('确认脚本内容与本地配置后，执行 ' + manager + ' run ' + script + ' 启动。');
    else if (rootPackage.scriptNames.includes('build')) verifiedSteps.push('根目录提供 ' + manager + ' run build' + '。构建后请按 README 确认运行入口。');
  }
  if (rootFiles.has('requirements.txt')) verifiedSteps.push('在 Python 虚拟环境中执行 python -m pip install -r requirements.txt。');
  if (rootFiles.has('go.mod')) verifiedSteps.push('在 Go 模块根目录执行 go mod download，并按 README 确认要启动的包。');
  if (compose) verifiedSteps.push('如使用容器，先核对 ' + compose + ' 的服务、端口与配置，再执行 docker compose -f ' + compose + ' up --build。');

  const readme = [...snapshot.contents].find(([path]) => !path.includes('/') && /^readme(?:\..+)?$/i.test(path))
    ?? [...snapshot.contents].find(([path]) => /^readme(?:\..+)?$/i.test(posix.basename(path)));

  return {
    verifiedSteps,
    context: {
      directoryTree: treeSummary(snapshot.files),
      readmeExcerpt: safeReadme(readme?.[1] ?? ''),
      dependencies: {
        manifestTypes: knownManifests, packageSamples, rootPackageManager: rootPackage ? manager : undefined,
        pythonLibraries: dependencyNames.filter(name => pythonLibraries.has(name)),
      },
      startup: { verifiedSteps, rootDockerfile: rootFiles.has('Dockerfile'), rootMakefile: rootFiles.has('Makefile') },
      scan: {
        ruleScore: report.readiness.total, riskCounts: getRiskCounts(report), risksTruncated: report.risksTruncated,
        checks: Object.fromEntries(report.scoreBreakdown.map(item => [item.check, item.status])),
      },
    },
  };
}
