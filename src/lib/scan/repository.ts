import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hosts = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org', 'gitee.com']);
const gitTimeout = 30_000;
export const maxFileBytes = 1024 * 1024;
const maxTextBytes = 24 * maxFileBytes;
const maxTextFiles = 4_000;
const maxTreeBytes = 8 * maxFileBytes;

const ignoredDirectories = new Set([
  '.git', 'node_modules', 'vendor', 'dist', 'build', '__pycache__', '.next', '.venv', 'coverage', 'target',
]);
const binaryExtensions = /\.(?:png|jpe?g|gif|webp|ico|bmp|tiff?|avif|heic|psd|mp[34]|mov|avi|mkv|webm|wav|ogg|flac|aac|zip|gz|bz2|xz|tgz|tar|7z|rar|pdf|docx?|xlsx?|pptx?|woff2?|ttf|otf|exe|dll|so|dylib|wasm|class|jar|pyc|sqlite3?)$/i;

type ScanErrorCode = 'INVALID_URL' | 'REPOSITORY_UNAVAILABLE' | 'SCAN_TIMEOUT' | 'SCAN_LIMIT';

export class ScanError extends Error {
  readonly code: ScanErrorCode;

  constructor(code: ScanErrorCode) {
    super(code);
    this.code = code;
  }
}

export function parseRepositoryUrl(input: unknown) {
  if (typeof input !== 'string' || input.length > 2048 || /[^a-z0-9:/.\-_]/i.test(input)) {
    throw new ScanError('INVALID_URL');
  }
  const match = /^https:\/\/([a-z0-9.-]+)\/([a-z0-9_.-]+(?:\/[a-z0-9_.-]+)+)\/?$/i.exec(input);
  if (!match) throw new ScanError('INVALID_URL');

  const host = match[1].toLowerCase();
  const segments = match[2].split('/');
  const repoName = segments.pop()!.replace(/\.git$/i, '');
  if (!hosts.has(host) ||
      (host !== 'gitlab.com' && segments.length !== 1) ||
      [...segments, repoName].some(segment => !/[a-z0-9_]/i.test(segment)) ||
      (host === 'github.com' && !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(segments[0])) ||
      segments.includes('-')) {
    throw new ScanError('INVALID_URL');
  }
  const owner = segments.join('/');
  return { repoUrl: `https://${host}/${owner}/${repoName}`, owner, repoName };
}

export interface TrackedFile {
  path: string;
  oid: string;
  size: number;
}

export interface RepositorySnapshot {
  branch: string;
  commitHash: string;
  files: TrackedFile[];
  contents: Map<string, string>;
  unreadPaths: Set<string>;
}

async function stopGit(child: ChildProcess) {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    await new Promise<void>(resolve => {
      execFile('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        timeout: 5_000, windowsHide: true, shell: false,
      }, () => resolve());
    });
    child.kill('SIGKILL');
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

function runGit(cwd: string, args: string[], maxBuffer: number, timeout: number, input?: string) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:git_|ssh_askpass$)/i.test(key)) delete env[key];
  }
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: 'https',
  });

  return new Promise<Buffer>((resolve, reject) => {
    if (timeout <= 0) {
      reject(new ScanError('SCAN_TIMEOUT'));
      return;
    }
    const child = spawn('git', [
      '-c', 'credential.helper=',
      '-c', 'http.followRedirects=false',
      '-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
      ...args,
    ], {
      cwd, env, windowsHide: true, shell: false, detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let failure: Error | undefined;
    let stopping: Promise<void> | undefined;
    const chunks: Buffer[] = [];
    let length = 0;
    function stop(code: ScanErrorCode) {
      if (stopping) return;
      failure = new ScanError(code);
      stopping = stopGit(child);
    }
    const timer = setTimeout(() => stop('SCAN_TIMEOUT'), timeout);
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure) return;
      length += chunk.length;
      if (length > maxBuffer) stop('SCAN_LIMIT');
      else chunks.push(chunk);
    });
    child.once('error', () => {
      failure ??= new Error('Git process could not start');
    });
    child.once('close', async code => {
      clearTimeout(timer);
      await stopping;
      if (failure) reject(failure);
      else if (code !== 0) reject(new ScanError('REPOSITORY_UNAVAILABLE'));
      else resolve(Buffer.concat(chunks, length));
    });
    child.stdin?.on('error', () => {
      // Git can close stdin early. The close event reports the exit status.
    });
    child.stdin?.end(input);
  });
}

function parseTree(tree: Buffer): TrackedFile[] {
  const files: TrackedFile[] = [];
  for (const entry of tree.toString('utf8').split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const match = /^100(?:644|755) blob ([0-9a-f]{40}|[0-9a-f]{64}) +([0-9]+)$/.exec(entry.slice(0, tab));
    if (!match) continue;
    const path = entry.slice(tab + 1);
    const segments = path.split('/');
    const name = segments.pop()!;
    if (segments.some(segment => ignoredDirectories.has(segment.toLowerCase())) || name.toLowerCase() === '.git') continue;
    files.push({ path, oid: match[1], size: Number(match[2]) });
  }
  return files;
}

function decodeText(bytes: Buffer): string | null {
  try {
    let encoding = 'utf-8';
    if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
    if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
    const decoded = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    return /[\x00-\x08\x0e-\x1f]/.test(decoded) ? null : decoded;
  } catch {
    return null;
  }
}

async function readContents(cwd: string, files: TrackedFile[], remaining: () => number) {
  const contents = new Map<string, string>();
  const unreadPaths = new Set<string>();
  const selected = new Map<string, TrackedFile>();
  const selectedPaths = new Set<string>();
  let bytes = 0;
  let uniqueBytes = 0;
  for (const file of files) {
    if (binaryExtensions.test(file.path)) continue;
    if (file.size > maxFileBytes || bytes + file.size > maxTextBytes || selectedPaths.size >= maxTextFiles) {
      unreadPaths.add(file.path);
      continue;
    }
    if (!selected.has(file.oid)) {
      selected.set(file.oid, file);
      uniqueBytes += file.size;
    }
    selectedPaths.add(file.path);
    bytes += file.size;
  }
  if (selected.size === 0) return { contents, unreadPaths };

  const input = Array.from(selected.keys(), oid => `${oid}\n`).join('');
  const output = await runGit(cwd, ['cat-file', '--batch'], uniqueBytes + selected.size * 128, remaining(), input);
  const decoded = new Map<string, string>();
  let offset = 0;
  for (const file of selected.values()) {
    const headerEnd = output.indexOf(10, offset);
    const end = headerEnd + 1 + file.size;
    if (headerEnd < 0 || output.toString('ascii', offset, headerEnd) !== `${file.oid} blob ${file.size}` || output[end] !== 10) {
      throw new ScanError('REPOSITORY_UNAVAILABLE');
    }
    const value = decodeText(output.subarray(headerEnd + 1, end));
    if (value !== null) decoded.set(file.oid, value);
    offset = end + 1;
  }
  for (const file of files) {
    const value = decoded.get(file.oid);
    if (value !== undefined && selectedPaths.has(file.path)) contents.set(file.path, value);
  }
  return { contents, unreadPaths };
}

export async function readRepositorySnapshot(cwd: string, deadline = Date.now() + gitTimeout): Promise<RepositorySnapshot> {
  const remaining = () => deadline - Date.now();
  const commitHash = (await runGit(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'], 1024, remaining())).toString().trim();
  const branch = (await runGit(cwd, ['symbolic-ref', '--short', 'HEAD'], 4096, remaining())).toString().trim();
  const files = parseTree(await runGit(cwd, ['ls-tree', '-rlz', '--full-tree', commitHash], maxTreeBytes, remaining()));
  const content = await readContents(cwd, files, remaining);
  return { branch, commitHash, files, ...content };
}

export async function withRepository<T>(
  repoUrl: string,
  analyze: (snapshot: RepositorySnapshot) => T,
  onCloned?: () => void,
): Promise<T> {
  const canonicalUrl = parseRepositoryUrl(repoUrl).repoUrl;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'repo-health-'));
  try {
    // Canonical URLs omit the suffix. Append one for the Git transport.
    await runGit(temporaryDirectory, [
      'clone', '--no-checkout', '--depth', '1', '--single-branch', '--no-tags', '--no-recurse-submodules',
      '--template=', '--', `${canonicalUrl}.git`, 'repository',
    ], maxFileBytes, gitTimeout);
    onCloned?.();
    const deadline = Date.now() + gitTimeout;
    const snapshot = await readRepositorySnapshot(join(temporaryDirectory, 'repository'), deadline);
    if (Date.now() >= deadline) throw new ScanError('SCAN_TIMEOUT');
    const result = analyze(snapshot);
    if (Date.now() >= deadline) throw new ScanError('SCAN_TIMEOUT');
    return result;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  }
}
