import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Git 仓库接入体检',
  description: '扫描公开 Git 仓库，查看工程完整度、跨平台兼容性、路径规范及密钥风险。',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
