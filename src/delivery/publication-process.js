import { spawn } from 'node:child_process';
import { ensure } from './contract.js';

// Internal argv runner: publication supplies the executable, argv and environment.
// A killed process group does not prove escaped descendants stopped. Release pipes
// after a bounded grace and report uncertainty instead of waiting on close forever.
export async function runPublicationProcess(executable, args, {cwd, env, timeoutMs = 10000, signal, maxOutputBytes = 65536} = {}) {
  ensure(['darwin','linux'].includes(process.platform), 'unsupported-platform');
  ensure(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000);
  ensure(Number.isSafeInteger(maxOutputBytes) && maxOutputBytes > 0 && maxOutputBytes <= 1048576);
  return new Promise(resolve => {
    let child, timer, grace, settled = false, reason = null, stdout = '', size = 0;
    const finish = code => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(grace); signal?.removeEventListener('abort', abort);
      resolve({code: code ?? null, reason, cleanup: reason ? 'uncertain' : 'not-required', stdout: reason ? '' : stdout});
    };
    const stop = why => {
      if (reason || settled) return; reason = why;
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      grace = setTimeout(() => {child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish(null);},100);
    };
    const abort = () => stop('cancelled');
    if (signal?.aborted) {reason='cancelled';finish(null);return;}
    try {child=spawn(executable,args,{cwd,env,shell:false,detached:true,stdio:['ignore','pipe','pipe']});}
    catch {reason='launch-failed';finish(null);return;}
    timer=setTimeout(()=>stop('timeout'),timeoutMs);signal?.addEventListener('abort',abort,{once:true});
    for (const [stream,capture] of [[child.stdout,true],[child.stderr,false]]) stream.on('data',data=>{
      if(reason) return;size+=data.length;if(size>maxOutputBytes) stop('output-limit');else if(capture) stdout+=data.toString('utf8');
    });
    child.on('error',()=>{reason='launch-failed';finish(null);});child.on('close',finish);
  });
}
