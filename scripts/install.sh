#!/bin/sh
# Install an explicitly approved local release artifact. Never fetch a script or latest release.
set -eu
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Rivet bootstrap requires Node.js 22 or newer and npm 10 or newer on PATH.' >&2
  exit 1
fi
exec node --input-type=commonjs - "$@" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const usage = 'Usage: sh scripts/install.sh --artifact <local.tgz> --sha256 <trusted SHA256> [--prefix <npm prefix>]';
let temporary, child, childClosed = Promise.resolve(), stopping = false;
function stop(message) { throw new Error(message); }
function cleanup() { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); }
function signalGroup(running, signal) {
  if (!running?.pid) return;
  try { process.kill(-running.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.on(signal, async () => {
  if (stopping) return;
  stopping = true;
  const running = child, closed = childClosed;
  try {
    if (running) {
      signalGroup(running, signal);
      await new Promise(resolve => setTimeout(resolve, 500));
      // The npm leader may exit first while descendants ignore TERM.
      signalGroup(running, 'SIGKILL');
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 1000))]);
    }
    cleanup();
  } catch { console.error('Interrupted bootstrap cleanup was incomplete; inspect the prefix and temporary directory.'); }
  process.exit(code);
});
function command(executable, args, { inherit = false } = {}) {
  return new Promise((resolve, reject) => {
    if (stopping) { reject(new Error('Bootstrap interrupted.')); return; }
    let output = '', errors = '';
    let closed; childClosed = new Promise(resolve => { closed = resolve; });
    const running = spawn(executable, args, { shell: false, detached: true, stdio: ['ignore', inherit ? 'inherit' : 'pipe', inherit ? 'inherit' : 'pipe'], env: { ...process.env, npm_config_ignore_scripts: 'true', npm_config_update_notifier: 'false' } });
    child = running;
    const timer = setTimeout(() => signalGroup(running, 'SIGKILL'), 180000);
    for (const [stream, isError] of [[running.stdout, false], [running.stderr, true]]) stream?.on('data', data => {
      if (isError) errors += data.toString(); else output += data.toString();
      if (output.length + errors.length > 1024 * 1024) signalGroup(running, 'SIGKILL');
    });
    running.on('error', () => { clearTimeout(timer); child = null; reject(new Error(`${executable} is unavailable on PATH.`)); });
    running.on('close', code => {
      clearTimeout(timer); child = null; closed();
      if (code !== 0 || stopping) reject(new Error(`${executable} ${args[0]} failed. Inspect the installation prefix before retrying.`));
      else resolve(output.trim());
    });
  });
}
function quote(value) { return "'" + value.replaceAll("'", "'\\''") + "'"; }
(async () => {
  const options = Object.create(null), args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--artifact', '--sha256', '--prefix'].includes(key) || Object.hasOwn(options, key)
      || !args[index + 1] || /[\u0000-\u001f\u007f]/.test(args[index + 1])) stop(usage);
    options[key] = args[index + 1];
  }
  if (!options['--artifact'] || !/^[a-fA-F0-9]{64}$/.test(options['--sha256'] ?? '')) stop(usage);
  if (Number(process.versions.node.split('.')[0]) < 22) stop('Rivet bootstrap requires Node.js 22 or newer.');
  const artifact = path.resolve(options['--artifact']);
  const before = fs.lstatSync(artifact);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > 64 * 1024 * 1024) stop('Artifact must be a regular local tarball no larger than 64 MiB.');
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-install-'));
  fs.chmodSync(temporary, 0o700);
  const copied = path.join(temporary, 'approved-release.tgz');
  // Hash the private copy that npm will consume, never a mutable source pathname.
  let sourceFd, copyFd;
  try {
    sourceFd = fs.openSync(artifact, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(sourceFd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) stop('Artifact changed during opening.');
    copyFd = fs.openSync(copied, 'wx', 0o600);
    const buffer = Buffer.alloc(1024 * 1024);
    let total = 0, count;
    while ((count = fs.readSync(sourceFd, buffer, 0, buffer.length, null)) > 0) {
      total += count;
      if (total > 64 * 1024 * 1024) stop('Artifact exceeds 64 MiB.');
      fs.writeFileSync(copyFd, buffer.subarray(0, count));
    }
  } finally {
    if (sourceFd !== undefined) fs.closeSync(sourceFd);
    if (copyFd !== undefined) fs.closeSync(copyFd);
  }
  const bytes = fs.readFileSync(copied);
  if (bytes.length > 64 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== options['--sha256'].toLowerCase()) stop('Artifact checksum mismatch; npm was not invoked. Obtain the expected SHA256 through a trusted release channel.');
  const members = (await command('tar', ['-tzf', copied])).split('\n');
  if (members.length > 20000 || new Set(members).size !== members.length
    || members.some(member => !member.startsWith('package/') || member.includes('//') || /[\u0000-\u001f\u007f\\]/.test(member)
      || member.split('/').some(part => part === '.' || part === '..'))
    || members.filter(member => member === 'package/package.json').length !== 1) stop('Artifact has unsafe or duplicate package metadata members.');
  let expectedPackage;
  try { expectedPackage = JSON.parse(await command('tar', ['-xOzf', copied, 'package/package.json'])); }
  catch { stop('Artifact package metadata could not be read unambiguously.'); }
  const validIdentity = pkg => pkg?.name === '@agilno/rivet'
    && typeof pkg.version === 'string' && pkg.version.length <= 128
    && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(pkg.version)
    && pkg.bin && typeof pkg.bin === 'object' && !Array.isArray(pkg.bin)
    && Object.keys(pkg.bin).length === 1 && ['bin/cli.js', './bin/cli.js'].includes(pkg.bin.rivet);
  if (!validIdentity(expectedPackage)) stop('Artifact package identity must be @agilno/rivet with a release version and the Rivet entry point.');
  const npmVersion = await command('npm', ['--version']);
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+].*)?$/.test(npmVersion) || Number(npmVersion.split('.')[0]) < 10) stop('Rivet bootstrap requires npm 10 or newer.');
  await command('git', ['--version']);
  const configuredPrefix = options['--prefix'] === undefined ? await command('npm', ['prefix', '--global']) : path.resolve(options['--prefix']);
  if (!path.isAbsolute(configuredPrefix) || /[\u0000-\u001f\u007f]/.test(configuredPrefix)) stop('npm returned an invalid global prefix.');
  console.log(`Installing verified Rivet artifact into: ${configuredPrefix}`);
  await command('npm', ['install', '--global', '--prefix', configuredPrefix, '--ignore-scripts', '--install-links', '--no-audit', '--no-fund', copied], { inherit: true });
  const installed = path.join(configuredPrefix, 'lib', 'node_modules', '@agilno', 'rivet');
  if (!fs.lstatSync(installed).isDirectory() || fs.lstatSync(installed).isSymbolicLink()) stop('Installed Rivet package is not a materialized directory.');
  const pkg = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
  if (!validIdentity(pkg) || pkg.version !== expectedPackage.version || pkg.bin.rivet !== expectedPackage.bin.rivet) stop('Installed package identity differs from the verified artifact.');
  const executable = path.join(configuredPrefix, 'bin', 'rivet');
  if (path.relative(fs.realpathSync(installed), fs.realpathSync(path.join(installed, 'bin', 'cli.js'))) !== path.join('bin', 'cli.js')
    || fs.realpathSync(executable) !== fs.realpathSync(path.join(installed, 'bin', 'cli.js'))) stop('Installed Rivet executable points outside the installed package.');
  const help = await command(executable, ['--help']);
  if (!/rivet/i.test(help)) stop('Installed Rivet help verification failed.');
  console.log(`Verified Rivet installation: ${executable}`);
  console.log(`If rivet is not on PATH, run: export PATH=${quote(path.join(configuredPrefix, 'bin'))}:"$PATH"`);
  console.log('From your project, run rivet setup, review its preview, then rivet setup --write. No shell profile was changed.');
})().catch(error => { if (!stopping) { console.error(`Rivet bootstrap stopped: ${error.message}`); process.exitCode = 1; } })
  .finally(() => { if (stopping) return; try { cleanup(); } catch { console.error('Could not remove bootstrap temporary files; inspect your temporary directory.'); process.exitCode = 1; } });
NODE
