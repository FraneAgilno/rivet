import { createTrustedDeliveryExecutor } from './service.js';
import { ensure, exact, hash, sha, factsDigest } from './contract.js';
import { publicationRef } from './publication-transport.js';
export function publicationPayload(target) {return {destinationUrl:target.repository.url+'.git',ref:publicationRef(target.sourceBranch),headSha:target.headSha};}
export function createBranchPublicationExecutor({repository,transport}) {
  ensure(transport&&typeof transport.readRefs==='function'&&typeof transport.push==='function');
  const validate=op=>{ensure(op.action==='branch-publish'&&hash(op.candidate.repository)===hash(repository));ensure(hash(op.payload)===hash(publicationPayload(op.candidate)),'invalid-publication');};
  const inspect=async target=>{
    ensure(hash(target.repository)===hash(repository));const refs=await transport.readRefs(target);exact(refs,['sourceSha','baseSha']);sha(refs.baseSha);if(refs.sourceSha!==null)sha(refs.sourceSha);return refs;
  };
  const receipt=(op,refs)=>({status:'succeeded',operationDigest:op.digest,headSha:op.candidate.headSha,commitSha:op.candidate.headSha,resourceUrl:repository.url,evidenceDigest:hash({assurance:'publication-requirement-satisfied',publication:op.payload,remoteSha:refs.sourceSha})});
  async function observe(target) {
      const refs=await inspect(target);const policy={headSha:target.headSha,policy:'unknown',satisfied:null,evidenceDigest:hash({publication:refs})};
      return {repositoryUrl:repository.url,sourceBranch:target.sourceBranch,targetBranch:target.targetBranch,headSha:target.headSha,baseSha:refs.baseSha,review:null,checks:policy,reviews:policy,observedAt:new Date().toISOString(),publication:{destinationUrl:repository.url+'.git',ref:publicationRef(target.sourceBranch),remoteSha:refs.sourceSha}};
    }
  return createTrustedDeliveryExecutor({provider:repository.provider,capabilities:[{action:'branch-publish',conditionalHead:true,reconcile:true}],observe,
    async dispatch(op,context) {
      validate(op);const current=await observe(op.candidate);ensure(current.publication.remoteSha===null,'branch-exists');ensure(factsDigest(current)===op.factsDigest,'changed-facts');
      await transport.push(op.candidate,context);const refs=await inspect(op.candidate);ensure(refs.sourceSha===op.candidate.headSha,'publication-outcome-uncertain');return receipt(op,refs);
    },
    async reconcile(op) {validate(op);const refs=await inspect(op.candidate);return refs.sourceSha===op.candidate.headSha?{status:'succeeded',receipt:receipt(op,refs)}:{status:'unknown'};},
  });
}
