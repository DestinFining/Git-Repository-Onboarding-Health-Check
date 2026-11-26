import { X509Certificate } from 'node:crypto';
import { posix } from 'node:path';
import type { CheckResult, RiskFinding, ScanReport } from '../../types/report.ts';
import { maskJavaScriptBlockComments } from './javascript-comments.ts';
import { maskNonFilesystemPaths } from './non-filesystem-paths.ts';
import type { RepositorySnapshot } from './repository.ts';
import { virtualTestPaths } from './virtual-test-paths.ts';

const manifestNames = new Set([
  'package.json', 'requirements.txt', 'pyproject.toml', 'pipfile', 'setup.py', 'environment.yml', 'environment.yaml', 'go.mod', 'cargo.toml',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'gemfile', 'composer.json', 'mix.exs', 'deno.json', 'pubspec.yaml',
]);
const startupNames = new Set([
  'dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml',
  'makefile', 'gnumakefile', 'taskfile.yml', 'taskfile.yaml', 'procfile', 'start.sh', 'run.sh', 'dev.sh', 'entrypoint.sh', 'boot.sh',
]);
const readmeSections = [
  ['安装', /安装|依赖|\b(?:install(?:ation)?|getting started|setup|requirements|dependencies)\b/i],
  ['运行', /运行|启动|用法|使用|\b(?:usage|running|run|start|quickstart|quick start)\b/i],
  ['配置', /配置|环境变量|\b(?:configuration|config|env|environment)\b/i],
] as const;

const privateKeyHeader = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/;
const databasePassword = /^(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[\w.-]+:([^:@\s"'<>]{4,})@/i;
const quotedCredential = /^[\w.-]+["']?[ \t]*[:=][ \t]*["']([a-zA-Z0-9/+=._-]{16,})["']/;
const secretPatterns = /\b(?:sk-[\w-]{20,}|sk_live_[a-z\d]{24,}|AKID[a-z\d]{10,40}|LTAI[a-z\d]{12,24}|(?:A3T[a-z\d]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[a-z\d]{16}|gh[pousr]_[a-z\d]{36}|github_pat_[\w]{22,}|AIza[\w-]{35}|xox[baprs]-[a-z\d-]{10,48})(?![\w-])|\bBearer[ \t]+[\w.\-~+/]{20,}=*|\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[\w.-]+:[^:@\s"'<>]{4,}@[\w.-]+|\b(?:api_?key|secret_?key|access_?token|auth_?token|private_?key|db_?password)["']?[ \t]*[:=][ \t]*["'][a-zA-Z0-9/+=._-]{16,}["']/gi;
const standardPath = /(?:^|[\s"'=(,:])(?:\/tmp\/[^\s"'<>()[\]{},;]*|\/(?:dev\/(?:null|stdin)|bin\/(?:sh|bash)|usr\/bin\/env)(?![\w/.-])|\/(?:Users|home)\/(?:username|yourname|user|example|demo|xxx)\/[^\s"'<>()[\]{},;]*|[a-z]:[\\/]+path[\\/]+to[\\/]+[^\s"'<>()[\]{},;]*)/gi;
const uncPath = /(?:^|[\s"'=(,:])\\{2,}[\w.-]+\\+[\w.$-]+/;
const extraWindowsCommand = /(?:^|[\s"'(&|;])(?:(?:pwsh|xcopy|robocopy)(?:\.exe)?(?=$|[\s"';&|])|(?:del\s+\/|rmdir\s+\/s\b))/i;
const windowsCommandPath = /(?:^|[\s"'=])(?:[a-z]:[\\/]|\.{1,2}\\|[\w.-]+\\)[\w.-]+(?:\\[\w.-]+|\.(?:bat|cmd|ps1|exe)\b)/i;

function withoutPublicCertificates(content: string) {
  return content.replace(/^-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]+?)^-----END CERTIFICATE-----[ \t]*(?=\r?$)/gm, (block, body: string) => {
    const encoded = body.replace(/[\r\n]/g, '');
    const der = Buffer.from(encoded, 'base64');
    if (der.toString('base64') !== encoded) return block;
    try {
      return new X509Certificate(der).raw.equals(der) ? block.replace(/[^\r\n]/g, ' ') : block;
    } catch {
      return block;
    }
  });
}

function credentialValue(match: string) {
  return databasePassword.exec(match)?.[1] ?? quotedCredential.exec(match)?.[1];
}

function isContextualCredential(value: string) {
  if (/^(?:example|sample|test|dummy|placeholder|your[_-]|changeme|replace[_-]?me)/i.test(value)) return false;
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  return [...counts.values()].reduce((entropy, count) => {
    const frequency = count / value.length;
    return entropy - frequency * Math.log2(frequency);
  }, 0) >= 3.3;
}
const envFileName = /^\.env(?:\..+)?$/;
const envTemplateSuffix = /\.(?:example|sample|template|dist|defaults?)$/;
const envAssignment = /^[ \t]*(?:export[ \t]+)?([a-z_][a-z0-9_]*)[ \t]*=[ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^'"#\s]+))/i;
const secretEnvName = /(?:^|_)(?:API_KEY|ACCESS_KEY|PRIVATE_KEY|SECRET_KEY|SECRET|TOKEN|PASSWORD|PASSWD)$/i;
const envPlaceholder = /^(?:\$\{[a-z_]\w*\}|(?:sk-|ghp_|github_pat_)?(?:placeholder(?:[-_]?placeholder)*|change[-_]?me|replace[-_]?me|your[-_](?:api[-_]key|token|secret|password)(?:[-_]here)?))$/i;
const windowsCommand = /(?:^|[\s"'(&|;])(?:powershell(?:\.exe)?(?=$|[\s"';&|])|cmd(?:\.exe)?\s+\/c\b|set\s+"?[a-z_][\w]*=|copy(?:\.exe)?[ \t]+\S)/i;
const plainMarkdownCommand = /(?:^|[\s"'(&|;])(?:powershell(?:\.exe)?\s+[-/][a-z]|cmd(?:\.exe)?\s+\/c\b|set\s+"?[a-z_][\w]*=|copy(?:\.exe)?\s+(?:\/[apyb]\b|[^\s]+\.[a-z0-9*?]+[ \t]+\S|[a-z]:[\\/]))/i;
const explicitInlineWindowsCommand = /(?:^|[\s"'(&|;])(?:powershell(?:\.exe)?(?=$|[\s"';&|])|copy\.exe[ \t]+\S)/i;
const windowsPath = /\b[a-z]:[\\/]+[^\s'"<>()[\]{},;]+/i;
const unixPath = /(?:^|[\s"'=(,:])\/(?:Users\/[a-zA-Z0-9._-]+\/|home\/[a-zA-Z0-9._-]+\/|root\/|(?:etc|var|opt|usr\/local|mnt|srv|tmp|workspace)\/[a-zA-Z0-9._-])[^\s'"<>()[\]{},;]*/;
const riskDetailsPerCheck = 100;

function mask(value: string) {
  return value.length > 8 ? value.slice(0, 4) + '****' + value.slice(-4) : '****';
}

function redactSecret(match: string) {
  const value = credentialValue(match);
  if (value) {
    const start = (databasePassword.exec(match)?.[0].length ?? match.length) - value.length - 1;
    return match.slice(0, start) + mask(value) + match.slice(start + value.length);
  }
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
    .replace(standardPath, ' ')
    .replace(/(?:https?|ftp|ssh|git|file):\/\/[^\s"'<>]+/gi, '')
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:\/\/|\/\*|\s#).*$/g, match =>
      match[0] === '"' || match[0] === "'" ? match : '')
    .replace(/(?:^|[=(,:]\s*|\breturn\s+)\/(?:\\.|[^/\\\r\n])+\/[dgimsuvy]*(?=\s*[,;.)\]}]|\s*$)/g, '');
  return windowsPath.test(code) || unixPath.test(code) || uncPath.test(code);
}

function evidence() {
  const paths = new Set<string>();
  const risks: RiskFinding[] = [];
  const severities = { High: 0, Medium: 0, Low: 0 };
  let count = 0;

  return {
    hits: () => count,
    countSeverity: (severity: RiskFinding['severity']) => severities[severity],
    risks,
    add(path: string, finding: Omit<RiskFinding, 'filePath'>) {
      count++;
      severities[finding.severity]++;
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
  const implicitEntries: string[] = [];
  const trackedPaths = new Set(snapshot.files.map(file => file.path));
  const documentedEntries = new Set<string>();
  let bestReadme: { missing: string[]; rank: number } | undefined;
  let readmeUnread = false;
  let packageUnread = false;
  let markdownUnread = false;
  let pathUnread = false;
  let contentSkipped = false;
  const rootNames = new Set(snapshot.files.filter(file => !file.path.includes('/')).map(file => file.path.toLowerCase()));
  const protectedScripts = new Set(snapshot.files.filter(file => /\.(?:sh)$/i.test(file.path)).map(file => file.path.toLowerCase()));
  const hasAlternative = rootNames.has('makefile') || rootNames.has('dockerfile');

  for (const file of snapshot.files) {
    const path = redactText(file.path);
    const name = posix.basename(file.path).toLowerCase();
    const content = snapshot.contents.get(file.path);
    const unread = snapshot.unreadPaths.has(file.path);
    const readme = !file.path.includes('/') && /^readme(?:\.[a-z]{2}(?:-[a-z]{2})?)?(?:\.(?:md|rst|txt|markdown))?$/.test(name);
    const markdown = /\.(?:md|markdown|mdx|mkd|mkdn)$/.test(name);
    const workflow = /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(file.path);
    const makefile = /^(?:makefile|gnumakefile)$/.test(name);
    const inProjectRoot = file.path.split('/').length <= 2;
    if (inProjectRoot && name !== 'package.json' &&
        (manifestNames.has(name) || /^requirements-.+\.txt$|\.csproj$/.test(name))) manifests.push(path);
    if (startupNames.has(name)) startup.push(path);
    if (inProjectRoot && /^(?:main\.py|app\.py|manage\.py|index\.js|server\.js|main\.go)$/.test(name)) implicitEntries.push(path);

    if (readme) {
      readmes.push(path);
      readmeUnread ||= unread;
      if (content !== undefined) {
        const commands = /^[ \t]*(?:\$[ \t]+)?node[ \t]+(?:\.\/)?([\w.-]+(?:\/[\w.-]+)*)[ \t]*\r?$/gm;
        for (const [, target] of content.matchAll(commands)) {
          if (target.split('/').some(part => part === '..' || part === '.')) continue;
          if (!/^(?:examples?\/|(?:.*\/)?(?:app|server|main|index)(?:\.[cm]?js)?$)/i.test(target)) continue;
          const base = posix.join(posix.dirname(file.path), target);
          const candidates = [base];
          if (!posix.extname(base)) candidates.push(base + '.js');
          if (!trackedPaths.has(base + '/package.json')) candidates.push(base + '/index.js');
          const entry = candidates.find(candidate => /\.[cm]?js$/i.test(candidate) && trackedPaths.has(candidate));
          if (entry) documentedEntries.add(redactText(entry));
        }
        const missing = readmeSections.filter(([, pattern]) => !pattern.test(content)).map(([section]) => section);
        const prose = content.replace(/<!--[^]*?-->/g, '').replace(/^\s*#{1,6}\s+/gm, '').trim();
        const longEnough = prose.length >= 150;
        const rank = (readmeSections.length - missing.length) * 4 + (longEnough ? 2 : 0) + (file.path.includes('/') ? 0 : 1);
        if (!bestReadme || rank > bestReadme.rank) bestReadme = { missing, rank };
        if (!longEnough) readmeIssues.add('有效内容不足 150 字符');
        if (missing.length) readmeIssues.add('缺少' + missing.join('、') + '说明');
        if (longEnough && missing.length <= 1) qualifiedReadmes.push(path);
      }
    }

    const env = envFileName.test(name);
    const envTemplate = env && envTemplateSuffix.test(name);
    if (env && !envTemplate) envFiles.add(path, {
      category: 'security', severity: 'High', title: '提交了实际环境文件', lineNumber: null,
      redactedSnippet: null, remediation: '将实际环境文件移出版本控制，用占位符维护环境变量模板，并轮换已暴露的凭据。' +
        (rootNames.has('.gitignore') ? '核对 .gitignore，并取消 Git 对该文件的跟踪。' : '添加 .gitignore 以防再次提交。'),
    });
    if (/^(?:id_(?:rsa|ed25519|dsa)|.*\.(?:p12|pfx|jks))$/.test(name) ||
        (/\.key$/.test(name) && (content === undefined ||
          (!privateKeyHeader.test(content) && withoutPublicCertificates(content).trim().length > 0)))) {
      privateKeys.add(path, {
        category: 'security', severity: 'High', title: '提交了疑似私钥或密钥库文件', lineNumber: null,
        redactedSnippet: null, remediation: '确认文件用途，将私钥或密钥库移出版本控制并轮换相关凭据。',
      });
    }
    if (/^(?:\.pypirc|kubeconfig|credentials\.csv)$/.test(name)) envFiles.add(path, {
      category: 'security', severity: 'High', title: '提交了敏感凭据配置文件', lineNumber: null,
      redactedSnippet: null, remediation: '核对配置是否包含实际凭据，改用凭据管理服务或本地配置。',
    });
    if (/\.(?:bat|cmd|ps1|vbs|wsf|reg)$/.test(name)) windows.add(path, {
      category: 'portability', severity: hasAlternative || protectedScripts.has(file.path.toLowerCase().replace(/\.[^.]+$/, '.sh')) ? 'Low' : 'High',
      title: 'Windows 专用脚本', lineNumber: null,
      redactedSnippet: null, remediation: '提供可在目标操作系统运行的等效入口。',
    });

    if (name === 'package.json') {
      packageUnread ||= unread;
      const scripts = packageScripts(content ?? '');
      if (inProjectRoot && content !== undefined) {
        try {
          const manifest = JSON.parse(content);
          if (['dependencies', 'devDependencies'].some(key => manifest?.[key] && typeof manifest[key] === 'object' &&
              !Array.isArray(manifest[key]) && Object.keys(manifest[key]).length > 0)) manifests.push(path);
        } catch {
          // Unparseable manifests provide no dependency evidence.
        }
      }
      if (['start', 'dev', 'serve', 'build'].some(key => typeof scripts[key] === 'string' && scripts[key].trim())) startup.push(path);
      if (Object.values(scripts).some(value => typeof value === 'string' && value.length <= 1500 &&
          (windowsCommand.test(value) || extraWindowsCommand.test(value) || windowsCommandPath.test(value)))) windows.add(path, {
        category: 'portability', severity: 'Medium', title: 'package.json 脚本含 Windows 专用命令', lineNumber: null,
        redactedSnippet: null, remediation: '使用跨平台命令或为各平台提供独立启动方式。',
      });
    }
    markdownUnread ||= (markdown || makefile || workflow) && unread;
    pathUnread ||= unread;
    if (content === undefined) continue;

    const boundedContent = content.replace(/^[^\r\n]{1501,}/gm, match => {
      contentSkipped = true;
      pathUnread = true;
      markdownUnread ||= markdown || makefile || workflow;
      return ' '.repeat(match.length);
    });
    const lines = boundedContent.split(/\r\n|\n|\r/);
    const pathSource = !markdown && (windowsPath.test(boundedContent) || unixPath.test(boundedContent) || uncPath.test(boundedContent))
      ? maskNonFilesystemPaths(file.path, maskJavaScriptBlockComments(file.path, boundedContent)) : boundedContent;
    const pathLines = pathSource === boundedContent ? lines : pathSource.split(/\r\n|\n|\r/);
    const envPlaceholders = new Map<number, string>();
    let virtualPaths: ReturnType<typeof virtualTestPaths> | undefined;
    let fence: string | undefined;
    let lineNumber = 0;
    let workflowRunIndent: number | undefined;
    for (const line of lines) {
      const pathLine = pathLines[lineNumber];
      lineNumber++;
      if (line.length > 1500) continue;
      if (markdown) {
        const marker = /^\s*(\x60{3,}|~{3,})/.exec(line)?.[1];
        if (marker) {
          if (!fence) fence = marker;
          else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
        } else if (
          (fence && windowsCommand.test(line)) ||
          [...line.matchAll(/\x60([^\x60]+)\x60/g)].some(match =>
            plainMarkdownCommand.test(match[1]) || explicitInlineWindowsCommand.test(match[1])) ||
          plainMarkdownCommand.test(line)
        ) {
          windows.add(path, {
            category: 'portability', severity: 'Medium', title: '文档中的 Windows 专用命令', lineNumber,
            redactedSnippet: null, remediation: '标明平台要求，并给出其他平台可用的命令。',
          });
        }
      }
      let command = makefile && /^\t/.test(line) ? line.trimStart() : undefined;
      if (workflow && line.trim() && !/^\s*#/.test(line)) {
        const indentation = line.length - line.trimStart().length;
        if (workflowRunIndent !== undefined && indentation > workflowRunIndent) command = line.trimStart();
        else workflowRunIndent = undefined;
        const run = /^(\s*(?:-\s*)?)run\s*:\s*(.*)$/.exec(line);
        if (run) {
          command = run[2];
          if (/^[|>][+-]?\d?\s*(?:#.*)?$/.test(command)) workflowRunIndent = run[1].length;
        }
      }
      if (command && (windowsCommand.test(command) || extraWindowsCommand.test(command) || windowsCommandPath.test(command))) {
        windows.add(path, {
          category: 'portability', severity: 'Medium', title: '构建或 CI 脚本中的 Windows 专用命令', lineNumber,
          redactedSnippet: null, remediation: '检查目标运行环境，提供可跨平台运行的命令。',
        });
      }
      if (containsHardcodedPath(pathLine)) {
        virtualPaths ??= virtualTestPaths(file.path, boundedContent);
        const literals = virtualPaths.get(lineNumber);
        const remaining = literals?.reduce((text, { start, end }) =>
          text.slice(0, start) + ' '.repeat(end - start) + text.slice(end), pathLine);
        if (remaining === undefined || containsHardcodedPath(remaining)) {
          hardcoded.add(path, {
            category: 'portability', severity: markdown || /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[^.]+$/i.test(file.path) ? 'Low' : 'Medium',
            title: '硬编码绝对路径', lineNumber,
            redactedSnippet: null, remediation: '改用相对路径、可配置的环境变量或系统目录 API。',
          });
        }
      }
      const serviceKey = /^service-account.*\.json$/.test(name) ? /"private_key"\s*:\s*"([^"]+)"/.exec(line)?.[1] : undefined;
      if (privateKeyHeader.test(line) || (serviceKey && !envPlaceholder.test(serviceKey))) privateKeys.add(path, {
        category: 'security', severity: 'High', title: privateKeyHeader.test(line) ? '检测到私钥头' : '服务账号配置含私钥', lineNumber,
        redactedSnippet: null, remediation: '从版本控制中移除私钥并立即轮换，检查仓库历史及访问记录。',
      });
      if (name === '.npmrc') {
        const token = /^\s*(?:[^\s=]+:)?_authToken\s*=\s*([^\s#;]+)/i.exec(line)?.[1]?.replace(/^['"]|['"]$/g, '');
        if (token && !envPlaceholder.test(token) && !token.match(secretPatterns)) addSecret(lineNumber, mask(token));
      }

      const assignment = env ? envAssignment.exec(line) : null;
      if (assignment) {
        const value = assignment[2] ?? assignment[3] ?? assignment[4];
        const placeholder = envPlaceholder.test(value);
        if (envTemplate && placeholder) envPlaceholders.set(lineNumber, value);
        if (secretEnvName.test(assignment[1]) && !placeholder && /^\S{12,}$/.test(value) && !value.match(secretPatterns)) {
          addSecret(lineNumber, mask(value));
        }
      }
    }

    const lineBreaks = content.matchAll(/\r\n|\n|\r/g);
    let nextBreak = lineBreaks.next();
    lineNumber = 1;
    for (const match of withoutPublicCertificates(boundedContent).matchAll(secretPatterns)) {
      while (!nextBreak.done && nextBreak.value.index! < match.index!) {
        lineNumber++;
        nextBreak = lineBreaks.next();
      }
      const contextualValue = credentialValue(match[0]);
      if (envPlaceholders.get(lineNumber) === match[0] || (contextualValue &&
          (envPlaceholder.test(contextualValue) || (!databasePassword.test(match[0]) &&
            !isContextualCredential(contextualValue) && !contextualValue.match(secretPatterns))))) continue;
      addSecret(lineNumber, redactSecret(match[0]));
    }

    function addSecret(lineNumber: number, redactedSnippet: string) {
      secrets.add(path, {
        category: 'security', severity: 'High', title: '疑似暴露的密钥或 Token', lineNumber,
        redactedSnippet, remediation: '撤销或轮换疑似凭据，改用受控的环境变量或密钥管理服务。',
      });
    }
  }

  const sections = readmeSections.map(([label]): NonNullable<ScanReport['completeness']['readme']['sections']>[number] => ({
    label,
    status: bestReadme && !bestReadme.missing.includes(label) ? 'pass' : readmeUnread ? 'skipped' : 'fail',
  }));
  const completeness: ScanReport['completeness'] = {
    readme: qualifiedReadmes.length
      ? { status: 'pass', summary: 'README 内容达到 150 字符，并覆盖至少两项接入说明。', filePaths: qualifiedReadmes, sections }
      : {
        status: readmeUnread ? 'skipped' : 'fail', filePaths: readmes, sections,
        ...(bestReadme && !readmeUnread ? { points: 5 } : {}),
        summary: readmeUnread ? '部分 README 超过大小或扫描预算，无法确认完整度。'
          : readmes.length === 0 ? '缺少 README。'
            : readmeIssues.size ? 'README ' + [...readmeIssues].join('，') + '。' : 'README 没有可读取的文本。',
      },
    dependencyManifest: manifests.length
      ? { status: 'pass', summary: '找到常见依赖清单。', filePaths: manifests }
      : { status: packageUnread ? 'skipped' : 'fail', summary: packageUnread ? '部分 package.json 未读取，无法核对依赖。' : '缺少可用的依赖清单。', filePaths: [] },
    startupScript: startup.length || documentedEntries.size
      ? { status: 'pass', summary: documentedEntries.size ? 'README 提供了指向仓库内入口文件的 Node 启动命令。' : '找到启动文件或 package.json 的 start、dev、build 脚本。', filePaths: [...new Set([...startup, ...documentedEntries])] }
      : {
        status: packageUnread ? 'skipped' : 'fail', filePaths: implicitEntries,
        summary: packageUnread ? '部分 package.json 超过大小或扫描预算，无法确认启动脚本。'
          : implicitEntries.length ? '仅有代码入口，缺少标准启动入口或命令说明。' : '缺少常见启动文件或脚本。',
      },
  };
  const portability = {
    windowsOnlyScripts: {
      ...windows.result('处 Windows 专用脚本或命令', '未发现 Windows 专用脚本或命令。', packageUnread || markdownUnread),
      ...(windows.hits() > 0 && windows.hits() === windows.countSeverity('Low') ? { points: 12 } : {}),
    },
    hardcodedPaths: {
      ...hardcoded.result('行硬编码绝对路径', '未发现常见硬编码绝对路径。', pathUnread),
      ...(hardcoded.hits() ? { points: Math.max(0, 15 - 4 * hardcoded.countSeverity('Medium') - hardcoded.countSeverity('Low')) } : {}),
    },
  };
  const security = {
    exposedSecrets: secrets.result('处疑似密钥或 Token', '未发现疑似密钥或 Token。', contentSkipped || snapshot.unreadPaths.size > 0),
    privateKeys: privateKeys.result('处私钥风险', '未发现私钥风险。', contentSkipped || snapshot.unreadPaths.size > 0),
    trackedEnvFiles: envFiles.result('个已提交的实际环境或凭据配置文件',
      [...rootNames].some(name => envFileName.test(name) && envTemplateSuffix.test(name))
        ? '找到合规的环境配置模板，未发现已提交的实际环境或凭据配置文件。'
        : '未发现已提交的实际环境或凭据配置文件。'),
  };
  const risks = groups.flatMap(group => group.risks);
  const order = { High: 0, Medium: 1, Low: 2 };
  risks.sort((a, b) => order[a.severity] - order[b.severity] ||
    (a.filePath ?? '').localeCompare(b.filePath ?? '') ||
    (a.lineNumber ?? 0) - (b.lineNumber ?? 0) || a.title.localeCompare(b.title));
  const riskCounts = { High: 0, Medium: 0, Low: 0 };
  for (const group of groups) for (const severity of ['High', 'Medium', 'Low'] as const) riskCounts[severity] += group.countSeverity(severity);
  return { completeness, portability, security, risks, riskCounts, risksTruncated: groups.some(group => group.hits() > group.risks.length) };
}
