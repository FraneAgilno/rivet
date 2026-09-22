import { spawn } from 'node:child_process';

export const SUPPORTED_NODE_MAJOR = 18;
export const RECOMMENDED_NODE_MAJOR = 22;
export const DEFAULT_COMMAND_TIMEOUT_MS = 3_000;
export const DEFAULT_COMMAND_OUTPUT_BYTES = 16 * 1024;

function safeResult(result = {}) {
  return {
    code: Number.isInteger(result.code) ? result.code : 1,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    timedOut: result.timedOut === true,
    truncated: {
      stdout: result.truncated?.stdout === true,
      stderr: result.truncated?.stderr === true,
    },
  };
}

function decodeValidUtf8Prefix(buffer) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let length = buffer.byteLength; length >= 0; length -= 1) {
    try {
      return decoder.decode(buffer.subarray(0, length));
    } catch {}
  }
  return '';
}

export function runArgv(command, args, options = {}) {
  if (typeof command !== 'string' || !Array.isArray(args) || args.some(value => typeof value !== 'string')) {
    throw new TypeError('Command execution requires an executable and argv array');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_COMMAND_OUTPUT_BYTES;
  const maxStreamOutputBytes = options.maxStreamOutputBytes ?? maxOutputBytes;
  return new Promise(resolvePromise => {
    const output = { stdout: [], stderr: [] };
    const streamBytes = { stdout: 0, stderr: 0 };
    const truncated = { stdout: false, stderr: false };
    let totalBytes = 0;
    let settled = false;
    let timedOut = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(safeResult({
        ...result,
        stdout: decodeValidUtf8Prefix(Buffer.concat(output.stdout)),
        stderr: decodeValidUtf8Prefix(Buffer.concat(output.stderr)),
        timedOut,
        truncated,
      }));
    };
    const collect = stream => chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const available = Math.max(0, Math.min(
        maxStreamOutputBytes - streamBytes[stream],
        maxOutputBytes - totalBytes,
      ));
      const accepted = buffer.subarray(0, available);
      if (accepted.byteLength > 0) output[stream].push(accepted);
      streamBytes[stream] += accepted.byteLength;
      totalBytes += accepted.byteLength;
      if (accepted.byteLength < buffer.byteLength) truncated[stream] = true;
    };
    child.stdout?.on('data', collect('stdout'));
    child.stderr?.on('data', collect('stderr'));
    child.once('error', () => finish({ code: 1, stdout: '' }));
    child.once('close', code => finish({ code: code ?? 1, stdout: output }));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();
  });
}

function normalizeVersion(stdout) {
  const match = String(stdout).match(/(?:^|\s)v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return match ? `${match[1]}.${match[2] ?? '0'}.${match[3] ?? '0'}` : null;
}

async function inspect(executable, args, runner, cwd) {
  try {
    const result = safeResult(await runner(executable, args, {
      cwd,
      shell: false,
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_COMMAND_OUTPUT_BYTES,
    }));
    const version = result.code === 0 ? normalizeVersion(result.stdout) : null;
    return { present: result.code === 0 && version !== null, version };
  } catch {
    return { present: false, version: null };
  }
}

export async function discoverTools(context = {}, options = {}) {
  const runner = options.runner ?? runArgv;
  const cwd = options.cwd;
  const packageManager = context.packageManager ?? 'npm';
  const platform = options.platform ?? process.platform;
  const managerExecutable = platform === 'win32'
    ? ({ npm: 'npm.cmd', pnpm: 'pnpm.cmd', yarn: 'yarn.cmd', bun: 'bun.exe' }[packageManager] ?? packageManager)
    : packageManager;
  const [node, manager, git] = await Promise.all([
    inspect('node', ['--version'], runner, cwd),
    inspect(managerExecutable, ['--version'], runner, cwd),
    inspect('git', ['--version'], runner, cwd),
  ]);
  const nodeMajor = node.version ? Number.parseInt(node.version, 10) : null;
  node.supported = node.present && nodeMajor >= SUPPORTED_NODE_MAJOR;
  node.compatible = node.supported;
  node.recommended = node.present && nodeMajor >= RECOMMENDED_NODE_MAJOR;
  manager.supported = manager.present;
  manager.compatible = manager.supported;
  git.supported = git.present;
  git.compatible = git.supported;
  return {
    node,
    [packageManager]: manager,
    git,
    playwright: {
      relevant: context.playwright === true,
      available: context.playwright === true && manager.present,
    },
    storybook: {
      relevant: context.storybook === true,
      available: context.storybook === true && manager.present,
    },
    thresholds: {
      nodeSupportedMajor: SUPPORTED_NODE_MAJOR,
      nodeRecommendedMajor: RECOMMENDED_NODE_MAJOR,
    },
  };
}
