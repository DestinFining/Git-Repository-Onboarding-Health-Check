import { posix } from 'node:path';
import type { CheckResult, RiskFinding, ScanReport } from '../../types/report.ts';
import type { RepositorySnapshot } from './repository.ts';

const manifestNames = new Set([
  'package.json', 'requirements.txt', 'pyproject.toml', 'pipfile', 'setup.py', 'go.mod', 'cargo.toml',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'gemfile', 'composer.json', 'mix.exs', 'deno.json', 'pubspec.yaml',
]);
const startupNames = new Set([
  'dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml',
  'makefile', 'gnumakefile', 'procfile',
]);
const readmeSections = [
  ['安装', /安装|\b(?:install(?:ation)?|getting started)\b/i],
  ['运行', /运行|启动|用法|使用|\b(?:usage|running|run|quickstart|quick start)\b/i],
  ['配置', /配置|环境变量|\b(?:configuration|config|env|environment)\b/i],
] as const;

const privateKeyHeader = /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/;
const secretPatterns = /sk-[a-zA-Z0-9_-]{20,}|AKID[a-zA-Z0-9]{10,}|LTAI[a-zA-Z0-9]{10,}|AKIA[0-9A-Z]{16}|Bearer\s+[a-zA-Z0-9._-]{15,}|ghp_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]+/gi;
const windowsCommand = /(?:^|[\s"'(&|;])(?:powershell(?:\.exe)?(?=$|[\s"';&|])|cmd(?:\.exe)?\s+\/c\b|set\s+"?[a-z_][\w]*=|copy(?:\.exe)?[ \t]+\S)/i;
const plainMarkdownCommand = /(?:^|[\s"'(&|;])(?:powershell(?:\.exe)?\s+[-/][a-z]|cmd(?:\.exe)?\s+\/c\b|set\s+"?[a-z_][\w]*=|copy(?:\.exe)?\s+(?:\/[apyb]\b|[^\s]+\.[a-z0-9*?]+[ \t]+\S|[a-z]:\\))/i;
const windowsPath = /\b[a-z]:\\+[^\s'"<>()[\]{},;]+/i;
const unixPath = /(?:^|[\s"'=(,:])\/(?:Users\/[a-zA-Z0-9._-]+\/|home\/[a-zA-Z0-9._-]+\/|root\/|(?:etc|var|opt|usr\/local|mnt|srv|tmp|workspace)\/[a-zA-Z0-9._-])[^\s'"<>()[\]{},;]*/;
const riskDetailsPerCheck = 100;

function mask(value: string) {
  return value.length > 8 ? value.slice(0, 4) + '****' + value.slice(-4) : '****';
}

function redactSecret(match: string) {
  const bearer = /^Bearer\s+/i.exec(match);
  return bearer ? 'Bearer ' + mask(match.slice(bearer[0].length)) : mask(match);
}

export function redactText(value: string): string {
  return value.replace(secretPatterns, redactSecret).replace(
    new RegExp(privateKeyHeader.source, 'g'),
    mask,
  );
}

export function omitSecretMatches(value: string): string {
  return value.replace(secretPatterns, '[已脱敏]');
}

function isEnvFile(name: string) {
  return /^\.env(?:\..+)?$/.test(name) && !/\.(?:example|sample|template|dist|defaults?)$/.test(name);
}

function packageScripts(content: string): Record<string, unknown> {
  try {
    const scripts: unknown = JSON.parse(content)?.scripts;
    if (scripts && typeof scripts === 'object' && !Array.isArray(scripts)) {
      return scripts as Record<string, unknown>;
    }
  } catch {
    // An invalid manifest still counts as a dependency manifest.
  }
  return {};
}

function containsHardcodedPath(line: string) {
  if (/^\s*(?:\/\/|\/\*|\*|#|<!--|;)/.test(line)) return false;
  const code = line
    .replace(/(?:https?|ftp|ssh|git|file):\/\/[^\s"'<>]+/gi, '')
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:\/\/|\/\*|\s#).*$/g, match =>
      match[0] === '"' || match[0] === "'" ? match : '')
    .replace(/(?:^|[=(,:]\s*|\breturn\s+)\/(?:\\.|[^/\\\r\n])+\/[dgimsuvy]*(?=\s*[,;.)\]}]|\s*$)/g, '');
  return windowsPath.test(code) || unixPath.test(code);
}

function evidence() {
  const paths = new Set<string>();
  const risks: RiskFinding[] = [];
  let count = 0;

  return {
    hits: () => count,
    risks,
    add(path: string, finding: Omit<RiskFinding, 'filePath'>) {
      count++;
      if (paths.size < 4_000) paths.add(path);
      if (risks.length < riskDetailsPerCheck) risks.push({ ...finding, filePath: path });
    },
    result(found: string, clean: string, unread = false): CheckResult {
      if (count) return { status: 'fail', summary: '发现 ' + count + ' ' + found + '。', filePaths: [...paths] };
      if (unread) return { status: 'skipped', summary: '部分文件超过大小或扫描预算，无法确认此项。', filePaths: [] };
      return { status: 'pass', summary: clean, filePaths: [] };
    },
  };
}

export function analyzeRepository(snapshot: RepositorySnapshot): Omit<ScanReport, 'repository' | 'readiness' | 'scoreBreakdown'> {
  const windows = evidence();
  const hardcoded = evidence();
  const secrets = evidence();
  const privateKeys = evidence();
  const envFiles = evidence();
  const groups = [windows, hardcoded, secrets, privateKeys, envFiles];
  const readmes: string[] = [];
  const qualifiedReadmes: string[] = [];
  const readmeIssues = new Set<string>();
  const manifests: string[] = [];
  const startup: string[] = [];
  let bestReadme: { missing: string[]; rank: number } | undefined;
  let readmeUnread = false;
  let packageUnread = false;
  let markdownUnread = false;
  let pathUnread = false;

  for (const file of snapshot.files) {
    const path = redactText(file.path);
    const name = posix.basename(file.path).toLowerCase();
    const content = snapshot.contents.get(file.path);
    const unread = snapshot.unreadPaths.has(file.path);
    const readme = /^readme(?:\..+)?$/.test(name);
    const markdown = /\.(?:md|markdown|mdx|mkd|mkdn)$/.test(name);
    if (manifestNames.has(name)) manifests.push(path);
    if (startupNames.has(name)) startup.push(path);

    if (readme) {
      readmes.push(path);
      readmeUnread ||= unread;
      if (content !== undefined) {
        const missing = readmeSections.filter(([, pattern]) => !pattern.test(content)).map(([section]) => section);
        const longEnough = content.trim().length >= 200;
        const rank = (readmeSections.length - missing.length) * 4 + (longEnough ? 2 : 0) + (file.path.includes('/') ? 0 : 1);
        if (!bestReadme || rank > bestReadme.rank) bestReadme = { missing, rank };
        if (!longEnough) readmeIssues.add('有效内容不足 200 字符');
        if (missing.length) readmeIssues.add('缺少' + missing.join('、') + '说明');
        if (longEnough && missing.length === 0) qualifiedReadmes.push(path);
      }
    }

    const env = isEnvFile(name);
    if (env) envFiles.add(path, {
      category: 'security', severity: 'High', title: '提交了实际环境文件', lineNumber: null,
      redactedSnippet: null, remediation: '将实际环境文件移出版本控制，用占位符维护环境变量模板，并轮换已暴露的凭据。',
    });
    if (/\.(?:bat|cmd|ps1|vbs)$/.test(name)) windows.add(path, {
      category: 'portability', severity: 'Medium', title: 'Windows 专用脚本', lineNumber: null,
      redactedSnippet: null, remediation: '提供可在目标操作系统运行的等效入口。',
    });

    if (name === 'package.json') {
      packageUnread ||= unread;
      const scripts = packageScripts(content ?? '');
      if (['start', 'dev', 'build'].some(key => typeof scripts[key] === 'string' && scripts[key].trim())) startup.push(path);
      if (Object.values(scripts).some(value => typeof value === 'string' && windowsCommand.test(value))) windows.add(path, {
        category: 'portability', severity: 'Medium', title: 'package.json 脚本含 Windows 专用命令', lineNumber: null,
        redactedSnippet: null, remediation: '使用跨平台命令或为各平台提供独立启动方式。',
      });
    }
    markdownUnread ||= markdown && unread;
    pathUnread ||= !markdown && unread;
    if (content === undefined) continue;

    let fence: string | undefined;
    let lineNumber = 0;
    for (const line of content.split(/\r\n|\n|\r/)) {
      lineNumber++;
      if (markdown) {
        const marker = /^\s*(\x60{3,}|~{3,})/.exec(line)?.[1];
        if (marker) {
          if (!fence) fence = marker;
          else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
        } else if (
          (fence && windowsCommand.test(line)) ||
          [...line.matchAll(/\x60([^\x60]+)\x60/g)].some(match => windowsCommand.test(match[1])) ||
          plainMarkdownCommand.test(line)
        ) {
          windows.add(path, {
            category: 'portability', severity: 'Medium', title: '文档中的 Windows 专用命令', lineNumber,
            redactedSnippet: null, remediation: '标明平台要求，并给出其他平台可用的命令。',
          });
        }
      } else if (containsHardcodedPath(line)) {
        hardcoded.add(path, {
          category: 'portability', severity: 'Medium', title: '硬编码绝对路径', lineNumber,
          redactedSnippet: null, remediation: '改用相对路径、可配置的环境变量或系统目录 API。',
        });
      }
      if (privateKeyHeader.test(line)) privateKeys.add(path, {
        category: 'security', severity: 'High', title: '检测到私钥头', lineNumber,
        redactedSnippet: mask(privateKeyHeader.exec(line)![0]), remediation: '从版本控制中移除私钥并立即轮换，检查仓库历史及访问记录。',
      });
    }

    const lineBreaks = content.matchAll(/\r\n|\n|\r/g);
    let nextBreak = lineBreaks.next();
    lineNumber = 1;
    for (const match of content.matchAll(secretPatterns)) {
      while (!nextBreak.done && nextBreak.value.index! < match.index!) {
        lineNumber++;
        nextBreak = lineBreaks.next();
      }
      secrets.add(path, {
        category: 'security', severity: 'High', title: '疑似暴露的密钥或 Token', lineNumber,
        redactedSnippet: redactSecret(match[0]), remediation: '撤销或轮换疑似凭据，改用受控的环境变量或密钥管理服务。',
      });
    }
  }

  const sections = readmeSections.map(([label]): NonNullable<ScanReport['completeness']['readme']['sections']>[number] => ({
    label,
    status: bestReadme && !bestReadme.missing.includes(label) ? 'pass' : readmeUnread ? 'skipped' : 'fail',
  }));
  const completeness: ScanReport['completeness'] = {
    readme: qualifiedReadmes.length
      ? { status: 'pass', summary: 'README 内容达到 200 字符，包含安装、运行和配置说明。', filePaths: qualifiedReadmes, sections }
      : {
        status: readmeUnread ? 'skipped' : 'fail', filePaths: readmes, sections,
        summary: readmeUnread ? '部分 README 超过大小或扫描预算，无法确认完整度。'
          : readmes.length === 0 ? '缺少 README。'
            : readmeIssues.size ? 'README ' + [...readmeIssues].join('，') + '。' : 'README 没有可读取的文本。',
      },
    dependencyManifest: manifests.length
      ? { status: 'pass', summary: '找到常见依赖清单。', filePaths: manifests }
      : { status: 'fail', summary: '缺少常见依赖清单。', filePaths: [] },
    startupScript: startup.length
      ? { status: 'pass', summary: '找到启动文件或 package.json 的 start、dev、build 脚本。', filePaths: startup }
      : {
        status: packageUnread ? 'skipped' : 'fail', filePaths: [],
        summary: packageUnread ? '部分 package.json 超过大小或扫描预算，无法确认启动脚本。' : '缺少常见启动文件或脚本。',
      },
  };
  const portability = {
    windowsOnlyScripts: windows.result('处 Windows 专用脚本或命令', '未发现 Windows 专用脚本或命令。', packageUnread || markdownUnread),
    hardcodedPaths: hardcoded.result('行硬编码绝对路径', '未发现常见硬编码绝对路径。', pathUnread),
  };
  const security = {
    exposedSecrets: secrets.result('处疑似密钥或 Token', '未发现匹配常见模式的密钥或 Token。', snapshot.unreadPaths.size > 0),
    privateKeys: privateKeys.result('处私钥头', '未发现私钥头。', snapshot.unreadPaths.size > 0),
    trackedEnvFiles: envFiles.result('个已提交的实际环境文件', '未发现已提交的实际环境文件。'),
  };
  const risks = groups.flatMap(group => group.risks);
  const order = { High: 0, Medium: 1, Low: 2 };
  risks.sort((a, b) => order[a.severity] - order[b.severity] ||
    (a.filePath ?? '').localeCompare(b.filePath ?? '') ||
    (a.lineNumber ?? 0) - (b.lineNumber ?? 0) || a.title.localeCompare(b.title));
  const riskCounts = { High: secrets.hits() + privateKeys.hits() + envFiles.hits(), Medium: windows.hits() + hardcoded.hits(), Low: 0 };
  return { completeness, portability, security, risks, riskCounts, risksTruncated: groups.some(group => group.hits() > group.risks.length) };
}
