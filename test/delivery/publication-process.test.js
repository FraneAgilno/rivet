import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPublicationProcess } from '../../src/delivery/publication-process.js';

test('publication process bounds timeout cancellation output and leader exit despite escaped inherited pipes',async()=>{
 for(const mode of ['timeout','cancelled','output-limit','leader-exit']) {
  const root=await mkdtemp(join(tmpdir(),'rivet-publish-pipes-'));const path=join(root,'pid');let descendant,timer;
  const controller=new AbortController();const start=performance.now();
  try {
   const script=`const c=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},4000)'],{detached:true,stdio:'inherit'});require('node:fs').writeFileSync(${JSON.stringify(path)},String(c.pid));c.unref();${mode==='output-limit'?"process.stdout.write('secret'.repeat(50000));":''}${mode==='leader-exit'?'process.exit(0)':'setInterval(()=>{},1000)'}`;
   const pending=runPublicationProcess(process.execPath,['-e',script],{cwd:root,env:{PATH:'/usr/bin:/bin'},timeoutMs:500,signal:controller.signal});
   if(mode==='cancelled')timer=setTimeout(()=>controller.abort(),350);
   const result=await pending;descendant=Number(await readFile(path,'utf8'));
   assert.equal(result.reason,mode==='leader-exit'?'timeout':mode);assert.equal(result.cleanup,'uncertain');assert.equal(result.stdout,'');assert(performance.now()-start<2000);
  } finally {
   clearTimeout(timer);if(!descendant)descendant=Number(await readFile(path,'utf8').catch(()=>''));if(Number.isSafeInteger(descendant)&&descendant>1){try{process.kill(-descendant,'SIGKILL');}catch{}}
   await rm(root,{recursive:true,force:true});
  }
 }
});
