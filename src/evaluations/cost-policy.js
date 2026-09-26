export class LiveEvaluationError extends Error {
  constructor(reason) { super(`Live evaluation stopped: ${reason}.`); this.code=`ERR_LIVE_EVAL_${reason.replaceAll('-','_').toUpperCase()}`; this.reason=reason; }
}
export function ensure(value,reason='invalid-profile') { if(!value)throw new LiveEvaluationError(reason); }
export function capture(value,allowed) {
 ensure(value && typeof value==='object' && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value)));
 const result={};
 for(const key of Reflect.ownKeys(value)) {
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  ensure(typeof key==='string' && allowed.includes(key) && descriptor?.enumerable && Object.hasOwn(descriptor,'value'));
  result[key]=descriptor.value;
 }
 return result;
}
export function resolveCostPolicy(input,provider) {
 const value=capture(input,['kind','accountPolicy','estimatedCostUsd']);
 ensure((value.kind==='account-policy'||(value.kind==='local-compute'&&provider==='ollama')) && typeof value.accountPolicy==='string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value.accountPolicy),'account-policy-required');
 ensure(value.estimatedCostUsd===undefined||value.estimatedCostUsd===null||(Number.isFinite(value.estimatedCostUsd) && value.estimatedCostUsd>0 && value.estimatedCostUsd<=100),'invalid-cost-estimate');
 return Object.freeze({...value,estimatedCostUsd:value.estimatedCostUsd??null,estimateIsLimit:false,hardDollarCapEnforced:false,providerAdvertisedBudgetsUsd:provider==='claude'?Object.freeze({planning:1,worker:2}):null,actualCostUsd:null});
}
