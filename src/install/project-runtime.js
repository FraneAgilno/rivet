import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { CliError } from '../cli/output.js';
import { createMutationGuard, ensureContainedDirectory, findProjectRoot, withPinnedTargetDirectory } from '../commands/install.js';
import { inspectManagedInstall, managedInstall } from './managed.js';
import { acquireLock, recoverAbandonedLock, StaleLockError } from '../state/lock.js';
import integrity from './runtime-integrity.cjs';
import { launcher, reference, runtimeSkill } from './project-reference.js';
const { runtimeIntegrity } = integrity;
const NAME = '.rivet.cjs', HASH = /^[a-f0-9]{64}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new CliError(message, 'REPOSITORY_CONFLICT'); };
function regular(file, fs, maximum = 16 * 1024 * 1024) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) fail('Project runtime contains an unsafe file.');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd), bytes = Buffer.alloc(before.size + 1), length = fs.readSync(fd, bytes, 0, bytes.length, 0), after = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || length !== before.size || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail('Project runtime file changed during validation.');
    return bytes.subarray(0, length);
  } finally { fs.closeSync(fd); }
}
function sourceSnapshot(packageRoot, fs) {
  const metadataBytes = regular(join(packageRoot, 'package.json'), fs, 65536), pkg = JSON.parse(metadataBytes);
  if (pkg.name !== '@agilno/rivet' || typeof pkg.version !== 'string' || !Array.isArray(pkg.files)
    || !['bin/cli.js', './bin/cli.js'].includes(pkg.bin?.rivet)
    || ['prepare', 'prepack', 'postpack'].some(key => Object.hasOwn(pkg.scripts ?? {}, key))) fail('The running Rivet package cannot be safely pinned.');
  const files = new Map([['package.json', { bytes: metadataBytes, mode: 0o644 }]]); let total = metadataBytes.length;
  const visit = ref => {
    if (typeof ref !== 'string' || !ref || isAbsolute(ref) || /[\u0000-\u001f\u007f\\*?]/.test(ref)
      || ref.split('/').some(part => !part || part === '.' || part === '..' || part === 'node_modules' || part === '.git')) fail('Unsupported runtime package file selection.');
    const file = join(packageRoot, ref), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) fail('The running Rivet package contains unsupported links.');
    if (stat.isDirectory()) { for (const child of fs.readdirSync(file).sort()) visit(ref + '/' + child); return; }
    const bytes = regular(file, fs);total += bytes.length;
    if (files.size >= 20000 || total > 64 * 1024 * 1024) fail('The running Rivet package exceeds snapshot limits.');
    files.set(ref, { bytes, mode: stat.mode & 0o111 ? 0o755 : 0o644 });
  };
  for (const ref of pkg.files) visit(ref.replace(/\/$/, ''));
  const entries = [...files].sort(([a],[b]) => Buffer.compare(Buffer.from(a),Buffer.from(b)));
  return { pkg, files: entries, id: hash(JSON.stringify(entries.map(([path, file]) => ({ path, mode: file.mode, sha256: hash(file.bytes) })))) };
}
async function command(executable, args, options) {
  return new Promise((resolveCommand, reject) => {
    let output = '', errors = '';const child = spawn(executable, args, { cwd: options.cwd, env: options.env, shell: false, detached: true, stdio: ['ignore','pipe','pipe'] });
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(kill, 180000);const abort = () => kill();options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) kill();
    child.stdout.on('data', bytes => { output += bytes; if (output.length > 2 * 1024 * 1024) kill(); });
    child.stderr.on('data', bytes => { errors += bytes; if (errors.length > 2 * 1024 * 1024) kill(); });
    child.on('error', reject);child.on('close', code => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); if (code !== 0 || options.signal?.aborted) reject(new Error('Private runtime package preparation failed or was interrupted.')); else resolveCommand(output); });
  });
}
async function lock(path) {
  try { return await acquireLock(path); }
  catch (error) { if (!(error instanceof StaleLockError)) throw error; await recoverAbandonedLock(path); return acquireLock(path); }
}
function verifyReference(root, before, fs) {
  const after = reference(root, fs);
  if (Boolean(before) !== Boolean(after) || (before && (before.id !== after.id || before.dev !== after.dev || before.ino !== after.ino))) fail('Project runtime reference changed during installation.');
}
export async function projectRuntimeInstall(parsed, dependencies) {
  if (Number.parseInt(process.versions.node.split('.')[0], 10) < 22) throw new CliError('Node.js 22 or newer is required for a project runtime. Select a supported Node runtime and retry installation.', 'INVALID_INPUT');
  const { fs } = dependencies;
  if (parsed.operands?.length || parsed.flags.global || parsed.flags.all || Object.keys(parsed.flags).some(key => !['project-runtime','minimal','project','target','claude','codex','json'].includes(key))) throw new CliError('Use install/uninstall --project-runtime [--project=<path>] [--target=both|claude|codex].', 'INVALID_INPUT');
  const selected = parsed.flags.project === undefined ? findProjectRoot(dependencies.cwd(), fs) : resolve(dependencies.cwd(), parsed.flags.project);
  if (!selected || fs.lstatSync(selected).isSymbolicLink() || !fs.lstatSync(selected).isDirectory()) fail('Select an existing project directory.');
  const root = fs.realpathSync(selected), home = fs.realpathSync(dependencies.home());
  const projectGuard = createMutationGuard(root, root, fs), rootIdentity = fs.lstatSync(root);
  const cache = join(home,'.cache','rivet','project-runtimes'), cacheGuard = createMutationGuard(home,cache,fs);
  const before = reference(root, fs), source = sourceSnapshot(dependencies.packageRoot,fs);
  const skillBytes = regular(join(dependencies.packageRoot,'templates','harness','SKILL.md'),fs,512*1024);
  const managedParsed = { ...parsed, flags: { ...parsed.flags, minimal: true, project: root } };
  const quiet = {log(){},error(){},json(){}};
  // Validate every selected owned target before any package installation.
  inspectManagedInstall(managedParsed,{...dependencies,managedSkillBytes:runtimeSkill(skillBytes,before?.id ?? source.id)});
  const controller = new AbortController(), abort=()=>controller.abort();process.on('SIGINT',abort);process.on('SIGTERM',abort);
  let projectLock, cacheLock, stage;
  const completed = await (async () => {
  try {
    projectGuard.assertPath(root);projectLock = await lock(join(root,'.rivet-project-runtime.lock'));
    verifyReference(root,before,fs);
    if (parsed.command === 'uninstall') {
      await managedInstall(managedParsed,{...dependencies,output:quiet});
      // A remaining managed harness still needs the reference.
      const keep = ['.claude','.agents'].some(target=>fs.existsSync(join(root,target,'skills','rivet','.rivet-install.json')));
      if (!keep && before) withPinnedTargetDirectory(root,rootIdentity,fs,()=>{verifyReference(root,before,fs);fs.unlinkSync(NAME);});
      const result={scope:'project',runtimeReference:keep?'retained':'removed',cache:'retained'};
      return result;
    }
    const cacheIdentity=ensureContainedDirectory(cacheGuard,fs);fs.chmodSync(cache,0o700);cacheLock=await lock(join(cache,'.install.lock'));
    cacheGuard.assertPath(cache);
    const indexFile=join(cache,`source-${source.id}-${process.platform}-${process.arch}.json`);
    let runtime;
    if(fs.existsSync(indexFile)){
      const id=JSON.parse(regular(indexFile,fs,1024)).runtimeId;if(!HASH.test(id))fail('Private runtime cache index is invalid.');
      runtime=runtimeIntegrity(join(cache,id),id,source.id);if(runtime.metadata.sourceDigest!==source.id)fail('Private runtime source identity changed.');
    }else{
      stage=join(cache,`.stage-${randomUUID()}`);fs.mkdirSync(stage,{mode:0o700});const snapshot=join(stage,'source'),destination=join(stage,'runtime');fs.mkdirSync(snapshot);fs.mkdirSync(destination);
      for(const [ref,file] of source.files){const target=join(snapshot,ref);fs.mkdirSync(dirname(target),{recursive:true});fs.writeFileSync(target,file.bytes,{flag:'wx',mode:file.mode});}
      const env={...dependencies.env,PATH:dependencies.env?.PATH??process.env.PATH,npm_config_ignore_scripts:'true',npm_config_update_notifier:'false'};
      const run=dependencies.runtimeCommand??command, options={cwd:'.',env,signal:controller.signal};
      const packed=JSON.parse(await withPinnedTargetDirectory(snapshot,fs.lstatSync(snapshot),fs,()=>run('npm',['pack','--ignore-scripts','--json','--pack-destination','..'],options)));
      if(!Array.isArray(packed)||packed.length!==1||typeof packed[0].filename!=='string'||!/^[A-Za-z0-9._-]+\.tgz$/.test(packed[0].filename))fail('Private package preparation returned an invalid artifact.');
      const artifact=join(stage,packed[0].filename),artifactDigest=hash(regular(artifact,fs,64*1024*1024));
      await withPinnedTargetDirectory(stage,fs.lstatSync(stage),fs,()=>run('npm',['install','--prefix','runtime','--omit=dev','--ignore-scripts','--install-links','--no-audit','--no-fund','./'+packed[0].filename],options));
      if(controller.signal.aborted)fail('Project runtime installation was interrupted; existing reference preserved.');
      const metadata={schemaVersion:1,sourceDigest:source.id,artifactDigest,package:{name:source.pkg.name,version:source.pkg.version},platform:process.platform,architecture:process.arch};
      fs.writeFileSync(join(destination,'.rivet-runtime.json'),JSON.stringify(metadata)+'\n',{flag:'wx',mode:0o600});runtime=runtimeIntegrity(destination);
      withPinnedTargetDirectory(cache,cacheIdentity,fs,()=>{
        cacheGuard.assertPath(cache);if(fs.existsSync(runtime.id))runtimeIntegrity(join(cache,runtime.id),runtime.id);else fs.renameSync(join(relative(cache,stage),'runtime'),runtime.id);
        if(fs.existsSync(basename(indexFile)))fail('Private runtime cache index changed during preparation.');
        const indexStage=join(relative(cache,stage),'index.json');
        fs.writeFileSync(indexStage,JSON.stringify({runtimeId:runtime.id})+'\n',{flag:'wx',mode:0o600});fs.renameSync(indexStage,basename(indexFile));
      });
    }
    const managedDependencies={...dependencies,managedSkillBytes:runtimeSkill(skillBytes,source.id),output:quiet};
    verifyReference(root,before,fs);inspectManagedInstall(managedParsed,managedDependencies);
    // Reference first: any partial skill update still has a working pinned command.
    withPinnedTargetDirectory(root,rootIdentity,fs,()=>{
      verifyReference(root,before,fs);const name=`.rivet-reference-${randomUUID()}.tmp`;
      try{fs.writeFileSync(name,launcher(source.id),{flag:'wx',mode:0o644});fs.renameSync(name,NAME);}finally{if(fs.existsSync(name))fs.unlinkSync(name);}
    });
    try{await managedInstall(managedParsed,managedDependencies);}catch(error){throw new CliError('Pinned runtime reference is installed, but harness instruction installation is incomplete. Existing user edits were preserved; retry after resolving the reported conflict.','REPOSITORY_CONFLICT',{cause:error});}
    const result={scope:'project',runtimeId:runtime.id,sourceDigest:source.id,reference:join(root,NAME),cache:join(cache,runtime.id),invocation:'node .rivet.cjs'};
    return result;
  }catch(error){if(error instanceof CliError)throw error;throw new CliError('Project runtime installation stopped. Existing application files are preserved. Inspect the private cache or installation lock before retrying.','REPOSITORY_CONFLICT',{cause:error});}
  finally{
    let cleanupError;
    if(stage){try{cacheGuard.assertPath(stage);fs.rmSync(stage,{recursive:true,force:true});}catch(error){cleanupError=error;}}
    try{await cacheLock?.release();}catch(error){cleanupError??=error;}
    try{await projectLock?.release();}catch(error){cleanupError??=error;}
    process.off('SIGINT',abort);process.off('SIGTERM',abort);
    if(cleanupError)throw new CliError('Project runtime operation may have completed, but private staging or lock cleanup is incomplete. Inspect the project reference and private cache before retrying.','REPOSITORY_CONFLICT',{cause:cleanupError});
  }
  })();
  if(parsed.flags.json)dependencies.output.json({ok:true,command:parsed.command,result:completed});
  else dependencies.output.log(parsed.command==='uninstall'?'Removed selected owned project runtime instructions. Shared runtime cache retained.':'Pinned project runtime installed. From the project root: node .rivet.cjs setup. No global Rivet installation is required.');
  return 0;
}
