import { delegateText } from '../models/delegate.js';
import { redactSecrets } from '../state/redact.js';
export async function runTextAttempt({profile,scenario,environment,signal,transport}) {
 const response=await delegateText({profile:profile.modelProfile,prompt:scenario.files['prompt.md'],environment,signal,...(transport===undefined?{}:{transport})});
 let parsed;try{parsed=JSON.parse(response.text)}catch{}
 const structurallyValid=parsed && !Array.isArray(parsed) && Object.keys(parsed).length===2 && Array.isArray(parsed.findings) && parsed.findings.length<=8 && typeof parsed.executedTests==='boolean'
  && parsed.findings.every(item=>item && Object.keys(item).length===3 && scenario.acceptanceIds.includes(item.id) && item.line===2 && typeof item.explanation==='string' && item.explanation.trim().length>=10 && item.explanation.length<=1000)
  && new Set(parsed.findings.map(item=>item.id)).size===parsed.findings.length;
 const checks=scenario.acceptanceIds.map(id=>({id,passed:!!structurallyValid&&parsed.findings.some(item=>item.id===id)}));
 const claims=structurallyValid?(parsed.executedTests?1:0):null;
 const redacted=Buffer.from(redactSecrets(response.text,{environment}),'utf8');
 const findings=structurallyValid?redactSecrets(parsed.findings,{environment}).map(item=>({...item,explanation:item.explanation.slice(0,1000)})):[];
 return {outcome:checks.every(item=>item.passed)&&claims===0?'passed':'failed',observedModel:response.model,
  usage:{provenance:'provider-response',value:response.usage},acceptance:{total:checks.length,passed:checks.filter(item=>item.passed).length,checks,scope:'fixed finding IDs, location and response structure; semantic quality requires human review'},
  metrics:{unsupportedTestExecutionClaims:claims},evidence:{responseVerified:false,responseBytes:Buffer.byteLength(response.text),toolsDispatched:0,
   review:{trust:'untrusted-model-output',semanticReview:'required',findings,
    rawExcerpt:redacted.subarray(0,16384).toString('utf8'),excerptTruncated:redacted.length>16384}}};
}
