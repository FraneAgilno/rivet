import { createHash } from 'node:crypto';
export function reportDigest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function evaluationReport({profile,scenario,source,startedAt,elapsedMs,result,injected}) {
 return Object.freeze({schemaVersion:1,mode:'live',measurement:injected?'injected-client-rehearsal':'live-attempt',scenario:scenario.id,fixtureDigest:scenario.digest,source,
  profileId:profile.id,profileDigest:reportDigest(profile),startedAt,elapsedMs,retryCount:0,retryScope:'model-dispatch',runtimeRetryCount:null,limits:profile.limits,timeoutSemantics:'abort deadline; cleanup can extend return latency',costPolicy:profile.cost,
  actualCostUsd:null,actualCostProvenance:'not-observed',model:{requested:profile.models,observed:result.observedModel??null},
  harness:result.harness??null,usage:result.usage??{provenance:'not-observed',value:null},outcome:result.outcome,
  acceptance:result.acceptance??{total:scenario.acceptanceIds.length,passed:null,checks:[]},gates:result.gates??[],
  metrics:{unsupportedClaims:null,humanInterventions:null,...result.metrics},evidence:result.evidence??{},
  ...(result.reason?{reason:result.reason}:{}),qualification:{freshUserPilot:false,sharedMemory:'not-implemented',sharedMemoryScope:'post-MVP',deliveryProvider:'not-evaluated'}});
}
