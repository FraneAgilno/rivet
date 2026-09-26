import { LiveEvaluationError } from './cost-policy.js';

// A UI callback may ignore cancellation or never settle. Stop waiting on the
// runner's signal independently; a late answer cannot resume this operation.
export function waitForApproval(confirm, proposal, signal) {
 return new Promise((resolve,reject)=>{
  let settled=false;
  const finish=(error,value)=>{
   if(settled)return;settled=true;signal.removeEventListener('abort',abort);
   if(error)reject(error);else resolve(value);
  };
  const abort=()=>finish(new LiveEvaluationError('cancelled'));
  if(signal.aborted){abort();return;}
  signal.addEventListener('abort',abort,{once:true});
  Promise.resolve().then(()=>{
   if(signal.aborted)throw new LiveEvaluationError('cancelled');
   return confirm(proposal,{signal});
  }).then(value=>finish(null,value),error=>finish(error));
 });
}
