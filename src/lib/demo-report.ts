import type { CheckResult, ScanReport } from '../types/report.ts';
import { calculateScore } from './scan/score.ts';

const pass = (summary: string, ...filePaths: string[]): CheckResult => ({ status: 'pass', summary, filePaths });
const fail = (summary: string, ...filePaths: string[]): CheckResult => ({ status: 'fail', summary, filePaths });

const checks: Pick<ScanReport, 'completeness' | 'portability' | 'security'> = {
  completeness: {
    readme: { ...pass('README 包含安装、运行和配置说明。', 'README.md'), sections: [
      { label: '安装', status: 'pass' }, { label: '运行', status: 'pass' }, { label: '配置', status: 'pass' },
    ] },
    dependencyManifest: pass('找到 Node.js 依赖清单。', 'package.json'),
    startupScript: pass('找到容器启动入口。', 'Dockerfile'),
  },
  portability: {
    windowsOnlyScripts: pass('未发现 Windows 专用脚本或命令。'),
    hardcodedPaths: fail('发现 2 行硬编码绝对路径。', 'config/paths.ts', 'scripts/bootstrap.sh'),
  },
  security: {
    exposedSecrets: fail('发现 1 处疑似密钥或 Token。', 'src/services/client.ts'),
    privateKeys: pass('未发现私钥头。'),
    trackedEnvFiles: pass('未发现已提交的实际环境文件。'),
  },
};

export const demoReport: ScanReport = {
  repository: {
    repoUrl: 'https://github.com/demo-labs/starter-kit', owner: 'demo-labs', repoName: 'starter-kit',
    branch: 'main', commitHash: 'a8f42c1e9b713c0d429b93f2a88c9165e0b76d21', scannedAt: '2026-11-25T08:42:10.000Z',
  },
  ...checks,
  ...calculateScore(checks),
  risksTruncated: false,
  risks: [
    { category: 'security', severity: 'High', title: '疑似暴露的 API 密钥', filePath: 'src/services/client.ts',
      lineNumber: 18, redactedSnippet: 'sk-d****9a2f', remediation: '立即轮换该密钥，并将应用改为从环境变量或密钥管理服务读取。' },
    { category: 'portability', severity: 'Medium', title: '配置中使用了硬编码绝对路径', filePath: 'config/paths.ts',
      lineNumber: 7, redactedSnippet: null, remediation: '使用基于项目根目录的相对路径，或通过环境变量配置。' },
    { category: 'portability', severity: 'Medium', title: '启动脚本依赖固定用户目录', filePath: 'scripts/bootstrap.sh',
      lineNumber: 12, redactedSnippet: null, remediation: '使用脚本目录或用户的 HOME 环境变量构建路径。' },
  ],
};
