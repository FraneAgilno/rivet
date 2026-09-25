import { execFile } from 'node:child_process';
import { access, lstat, realpath } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { types } from 'node:util';
import metadata from '../../package.json' with { type: 'json' };
import { diagnoseDoctor } from '../commands/doctor.js';
import { discoverHarnesses } from '../runtime/harness-discovery.js';
import { CliError } from '../cli/output.js';
const TOOLS = ['node','npm','pnpm','yarn','bun','git'];
const PLATFORM = new Set(['aix','darwin','freebsd','linux','openbsd','sunos','win32']);
const INTEGRATION_READINESS = ['disabled','out-of-scope','unsupported-transport','host-unavailable','authentication-unavailable','unsupported-tools','host-observed','credentials-present'];
const ARCH = new Set(['arm','arm64','ia32','loong64','mips','mipsel','ppc','ppc64','riscv64','s390','s390x','x64']);
const BAD = () => { throw new Error('Invalid diagnostic data'); };
function snapshot(input) {
  let nodes=0,bytes=0;
  function copy(value,depth=0) {
    if (++nodes>20000 || depth>20 || types.isProxy(value)) BAD();
    if (value===null || typeof value==='boolean')return value;
    if (typeof value==='string') { bytes+=Buffer.byteLength(value); if(bytes>1024*1024 || value.length>65536)BAD(); return value; }
    if (typeof value==='number') {if(!Number.isSafeInteger(value))BAD();return value;}
    if (!value || typeof value!=='object')BAD();
    const array=Array.isArray(value);
    if(![Object.prototype,null,...(array?[Array.prototype]:[])].includes(Object.getPrototypeOf(value)))BAD();
    const keys=Reflect.ownKeys(value);if(keys.length>2048)BAD();
    const result=array?[]:{};
    for(const key of keys) {
      if(array&&key==='length')continue;
      const descriptor=Object.getOwnPropertyDescriptor(value,key);
      if(typeof key!=='string'||key==='__proto__'||!descriptor?.enumerable||!Object.hasOwn(descriptor,'value'))BAD();
      if(array&&(!/^(?:0|[1-9][0-9]*)$/.test(key)||Number(key)>=value.length))BAD();
      result[key]=copy(descriptor.value,depth+1);
    }
    if(array&&(result.length!==value.length||Object.keys(result).length!==value.length))BAD();
    return result;
  }
  return copy(input);
}
function environmentSnapshot(environment) {
  if(!environment||typeof environment!=='object'||Array.isArray(environment)||types.isProxy(environment))BAD();
  const values=Object.create(null),keys=Reflect.ownKeys(environment);if(keys.length>1024)BAD();
  for(const key of keys) {
    const descriptor=Object.getOwnPropertyDescriptor(environment,key);
    if(typeof key!=='string'||!descriptor?.enumerable||!Object.hasOwn(descriptor,'value')||typeof descriptor.value!=='string'||descriptor.value.length>65536)BAD();
    values[key]=descriptor.value;
  }
  return Object.freeze(values);
}
function version(value, forbidden=[]) {
  if(typeof value!=='string'||value.length>1024)return null;
  const match=/^(?:v|codex-cli |git version )?(\d{1,6}\.\d{1,6}\.\d{1,6})(?:[-+][A-Za-z0-9.-]+)?(?: \(Claude Code\))?$/.exec(value);
  const core=match?.[1]??null;
  return core&&forbidden.some(secret=>secret&&secret.includes(core))?null:core;
}
const count=(items,predicate)=>Array.isArray(items)?Math.min(2048,items.filter(predicate).length):0;
function normalDoctor(input,environment) {
  const report=snapshot(input);
  if(!report||typeof report!=='object'||Array.isArray(report)||!['pass','warn','fail'].includes(report.status)
    ||!report.checks||!['pass','fail'].includes(report.checks.configuration?.status))BAD();
  const checks=report.checks;
  for(const key of ['credentials','providers','integrations'])if(checks[key]!==undefined&&!Array.isArray(checks[key]))BAD();
  const forbidden=(Array.isArray(checks.credentials)?checks.credentials:[]).map(item=>typeof item.name==='string'?environment[item.name]:'').filter(Boolean);
  return {
    configuration:{status:checks.configuration.status==='pass'?'valid':'missing-or-invalid'},
    readiness:{status:report.status,
      credentials:{required:count(checks.credentials,item=>item.required===true),missing:count(checks.credentials,item=>item.required===true&&item.present===false)},
      providers:{configured:count(checks.providers,()=>true),unavailable:count(checks.providers,item=>['unavailable','timeout','error'].includes(item.connectivity)),disabled:count(checks.providers,item=>item.readiness==='disabled')},
      commands:{status:checks.commands?.ready===true?'ready':checks.commands?.ready===false?'not-ready':'unknown',unready:count(checks.commands?.steps,item=>item.status!=='ready')},
      integrations:{configured:Array.isArray(checks.integrations)?Math.min(checks.integrations.length,2048):0,
        readiness:Object.fromEntries([...INTEGRATION_READINESS,'unknown'].map(state=>[state,count(checks.integrations,item=>state==='unknown'?!INTEGRATION_READINESS.includes(item.readiness):item.readiness===state)]))}},
    tools:TOOLS.filter(name=>Object.hasOwn(checks.tools??{},name)).map(name=>{
      const tool=checks.tools[name];if(!tool||typeof tool!=='object'||Array.isArray(tool)
        ||(tool.present!==undefined&&typeof tool.present!=='boolean')||(tool.supported!==undefined&&typeof tool.supported!=='boolean')
        ||(tool.version!==undefined&&tool.version!==null&&typeof tool.version!=='string'))BAD();
      return {name,present:tool.present===true,supported:tool.supported===true,version:version(tool.version,forbidden)};
    }),
    forbidden,
  };
}
function normalHarnesses(input,forbidden) {
  const rows=snapshot(input);if(!Array.isArray(rows)||rows.length!==2)BAD();
  const seen=new Set();
  return rows.map(row=>{
    if(!row||!['claude','codex'].includes(row.kind)||seen.has(row.kind))BAD();seen.add(row.kind);
    const present=typeof row.executable==='string'&&row.executable.length>0;
    const reasons=new Set(['not-installed','capability-probe-failed','interpreter-required','interpreter-unneeded','interpreter-unavailable','interpreter-incompatible','executable-unsafe']);
    const reason=present?'available':typeof row.reason==='string'&&row.reason.startsWith('missing-options:')?'missing-options':reasons.has(row.reason)?row.reason:'probe-failed';
    return {kind:row.kind,present,supported:present,version:version(row.version,forbidden),reason};
  });
}
export async function resolveSupportProject(cwd,explicit) {
  if(typeof cwd!=='string'||!isAbsolute(cwd)||/[\0\r\n]/.test(cwd)
    ||(explicit!==undefined&&(typeof explicit!=='string'||!explicit||/[\0\r\n]/.test(explicit))))throw new CliError('Project directory is invalid.','INVALID_INPUT');
  let selected;
  try {selected=await realpath(resolve(cwd,explicit??'.'));if(!(await lstat(selected)).isDirectory())throw new Error();}
  catch {throw new CliError('Project directory is unavailable.','INVALID_INPUT');}
  if(explicit!==undefined)return selected;
  let current=selected;
  for(let depth=0;depth<64;depth++) {
    for(const marker of ['.rivet','.git']) {
      try {await lstat(join(current,marker));return current;}catch(error){if(error.code!=='ENOENT')throw new CliError('Project discovery is unavailable.','INVALID_INPUT');}
    }
    const parent=dirname(current);if(parent===current)break;current=parent;
  }
  return selected;
}
function versionRunner(signal,environment,projectRoot) {
  const outside = path => { const rel=relative(projectRoot,path);return rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel); };
  let directoriesPromise;
  const directories = () => directoriesPromise ??= (async()=>{
    const choices=[...(environment.PATH??'').split(delimiter).slice(0,128),'/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin'];
    const safe=[];
    for(const path of choices) {
      if(signal.aborted)break;
      if(!isAbsolute(path)||/[\0\r\n]/.test(path))continue;
      try {const canonical=await realpath(path);if(outside(canonical)&&(await lstat(canonical)).isDirectory()&&!safe.includes(canonical))safe.push(canonical);}catch{}
    }
    return safe;
  })();
  return async (command,args,options={})=>{
    const unavailable={code:1,stdout:'',stderr:'',timedOut:false};
    if(signal.aborted||!TOOLS.includes(command)||!Array.isArray(args)||args.length!==1||args[0]!=='--version')return unavailable;
    const paths=await directories();let executable;
    for(const directory of paths) {
      if(signal.aborted)return unavailable;
      try {
        const candidate=await realpath(join(directory,command));
        if(!outside(candidate)||!(await lstat(candidate)).isFile())continue;
        await access(candidate,1);executable=candidate;break;
      }catch{}
    }
    if(!executable||signal.aborted)return unavailable;
    const probeEnvironment=Object.fromEntries(['LANG','LC_ALL','TZ','TERM','HOME','USER','LOGNAME','TMPDIR','SystemRoot','WINDIR']
      .filter(key=>environment[key]!==undefined).map(key=>[key,environment[key]]));
    probeEnvironment.PATH=paths.join(delimiter);
    // A globally installed Yarn/Corepack shim can still redirect from a project
    // packageManager/yarnPath setting. Probe from the system root instead, disable
    // project redirection and downloads, and never permit automatic project pins.
    Object.assign(probeEnvironment, {
      YARN_IGNORE_PATH: '1', COREPACK_ENABLE_PROJECT_SPEC: '0',
      COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_AUTO_PIN: '0',
      COREPACK_DEFAULT_TO_LATEST: '0',
    });
    const probeCwd=parse(process.execPath).root;
    return new Promise(resolvePromise=>{
      execFile(executable,args,{cwd:probeCwd,env:probeEnvironment,shell:false,timeout:3000,maxBuffer:16384,signal,killSignal:'SIGKILL'},(error,stdout)=>{
        resolvePromise({code:error?1:0,stdout:typeof stdout==='string'?stdout:'',stderr:'',timedOut:error?.killed===true});
      });
    });
  };
}
export async function collectSupportBundle(projectRoot,options={}) {
  const controller=new AbortController(),abort=()=>controller.abort();
  let timer,timedOut=false,environment,forbidden=[];
  const bundle={schemaVersion:1,versions:{rivet:version(metadata.version),node:version(process.version),platform:PLATFORM.has(process.platform)?process.platform:'unknown',architecture:ARCH.has(process.arch)?process.arch:'unknown'},
    collection:{status:'complete',errors:[]},configuration:{status:'unknown'},readiness:{status:'unknown'},tools:[],harnesses:{status:'not-requested',results:[]}};
  const incomplete=reason=>{bundle.collection.status='incomplete';if(!bundle.collection.errors.includes(reason))bundle.collection.errors.push(reason)};
  const bounded=operation=>new Promise((resolvePromise,reject)=>{
    if(controller.signal.aborted){reject(new Error());return;}
    const cancel=()=>reject(new Error());controller.signal.addEventListener('abort',cancel,{once:true});
    Promise.resolve().then(()=>{if(controller.signal.aborted)throw new Error();return operation()}).then(resolvePromise,reject)
      .finally(()=>controller.signal.removeEventListener('abort',cancel));
  });
  try {
    environment=environmentSnapshot(options.environment??process.env);
    if(options.signal!==undefined){
      const getter=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted').get;
      if(Reflect.apply(getter,options.signal,[]))abort();
      Reflect.apply(EventTarget.prototype.addEventListener,options.signal,['abort',abort,{once:true}]);
    }
    const timeoutMs=options.timeoutMs??15000;
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>15000)BAD();
    timer=setTimeout(()=>{timedOut=true;abort()},timeoutMs);
    let unsafe=false;
    try {const marker=await lstat(join(projectRoot,'.rivet'));unsafe=marker.isSymbolicLink()||!marker.isDirectory();}catch(error){if(error.code!=='ENOENT')unsafe=true;}
    if(unsafe)bundle.configuration.status='unsafe';
    else try {
      const diagnostic=await bounded(()=>(options.diagnose??diagnoseDoctor)(projectRoot,{env:environment,runner:versionRunner(controller.signal,environment,projectRoot),providerProbe:undefined}));
      const normalized=normalDoctor(diagnostic,environment);forbidden=normalized.forbidden;delete normalized.forbidden;Object.assign(bundle,normalized);
      bundle.versions.rivet=version(metadata.version,forbidden);bundle.versions.node=version(process.version,forbidden);
    }catch {incomplete(controller.signal.aborted?(timedOut?'timeout':'cancelled'):'doctor-failed')}
    if(options.probeHarnesses===true){
      bundle.harnesses.status='failed';
      try {
        const rows=await bounded(()=>(options.discoverHarnesses??discoverHarnesses)({env:environment,projectRoot,signal:controller.signal}));
        bundle.harnesses={status:'complete',results:normalHarnesses(rows,forbidden)};
      }catch {incomplete(controller.signal.aborted?(timedOut?'timeout':'cancelled'):'harness-probe-failed')}
    }
    if(controller.signal.aborted)incomplete(timedOut?'timeout':'cancelled');
  }catch {incomplete('collector-failed')}
  finally {
    clearTimeout(timer);controller.abort();
    if(options.signal!==undefined)try{Reflect.apply(EventTarget.prototype.removeEventListener,options.signal,['abort',abort])}catch{}
  }
  return Object.freeze(bundle);
}
