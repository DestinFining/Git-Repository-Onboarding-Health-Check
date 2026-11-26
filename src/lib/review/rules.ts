import type { ProjectReview, ScanReport } from '../../types/report.ts';

type ReviewChecks = Pick<ScanReport, 'completeness' | 'security' | 'portability' | 'readiness'>;

export function ruleReview(report: ReviewChecks, message: string, verifiedSteps: string[] = []): ProjectReview {
  const { completeness, security, portability, readiness } = report;
  const manifests = completeness.dependencyManifest.filePaths;
  const has = (name: string) => manifests.some(path => path.toLowerCase().split('/').at(-1) === name);
  const ecosystems = [
    [has('package.json'), 'Node.js'],
    [has('requirements.txt') || has('pyproject.toml'), 'Python'],
    [has('go.mod'), 'Go'],
    [has('cargo.toml'), 'Rust'],
    [has('pom.xml') || has('build.gradle') || has('build.gradle.kts'), 'JVM'],
    [has('gemfile'), 'Ruby'],
    [has('composer.json'), 'PHP'],
  ].filter(([found]) => found).map(([, label]) => label).join('、');
  const priorities: string[] = [];
  if (security.exposedSecrets.status === 'fail' || security.privateKeys.status === 'fail') {
    priorities.push('轮换疑似泄露的密钥或私钥，检查提交历史与访问记录，改用安全的凭据注入方式。');
  }
  if (security.trackedEnvFiles.status === 'fail') priorities.push('移除已跟踪的实际环境文件，保留只含占位符的环境模板。');
  if (Object.values(security).some(check => check.status === 'skipped')) priorities.push('补查因大小或扫描预算跳过的文件，确认环境变量和凭据的管理方式。');
  if (portability.windowsOnlyScripts.status === 'fail' || portability.hardcodedPaths.status === 'fail') {
    priorities.push('替换硬编码绝对路径与平台专用命令，并在目标操作系统上验证启动流程。');
  }
  if (completeness.startupScript.status !== 'pass') priorities.push('提供可重复执行的启动入口，注明运行时版本、配置和验证方法。');
  if (completeness.readme.status !== 'pass') priorities.push('补齐 README 的安装、运行和配置说明，并给出最小可用示例。');
  if (completeness.dependencyManifest.status !== 'pass') priorities.push('补齐依赖清单与版本约束，以便在干净环境中复现安装。');
  priorities.push('在干净环境中复跑安装与启动流程，记录所需版本和外部服务。', '添加最小冒烟测试验证启动和关键流程。', '维护环境变量模板并说明各项配置用途。');

  const difficulty = readiness.total >= 80 ? 'low' : readiness.total >= 60 ? 'medium' : 'high';
  return {
    source: 'rules',
    positioning: ecosystems ? '检测到 ' + ecosystems + ' 工程，具体用途请结合 README 和应用入口确认。' : '请从 README 和主入口确认项目用途与接入边界。',
    architecture: ecosystems ? '可先以依赖清单定位构建边界，再核对启动入口与运行时配置；模块之间的依赖关系仍需结合源码确认。' : '项目技术栈或模块边界需要从构建文件和入口进一步确认。',
    difficulty,
    difficultyReason: '依据静态规则评分 ' + readiness.total + '/100 及工程、兼容性和安全检查结果估算。',
    aiScore: null,
    startupSteps: [
      '进入仓库根目录，阅读 README 的安装和配置说明，并核对运行时版本。先检查仓库脚本和安装钩子。',
      '查找环境变量模板，按需填写本地配置，并确认数据库等外部服务的可用性。',
      ...(verifiedSteps.length ? verifiedSteps : [
        ecosystems ? '通过 ' + ecosystems + ' 的依赖清单确认安装方式和版本要求。' : '先确认项目的技术栈和依赖安装方式。',
        completeness.startupScript.status === 'pass'
          ? '在报告列出的启动入口中选择适用方式，按仓库说明执行。'
          : '向维护者确认启动入口和参数后再执行。',
      ]),
      '确认进程正常启动，并检查日志、预期端口或仓库提供的冒烟测试。',
    ],
    priorities: [priorities[0], priorities[1], priorities[2]],
    message,
  };
}
