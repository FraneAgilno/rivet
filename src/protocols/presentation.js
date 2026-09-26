import { lstatSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertSelectedProtocolRefs } from './project.js';
import { failAgent } from '../clients/contract.js';
import { serializeLaunchContract } from '../prompts/launch-contract.js';

const contexts = new WeakMap();
const REF = /^protocol:([a-z0-9][a-z0-9-]*):([1-9][0-9]*):(sha256:[a-f0-9]{64})$/;
const cli = realpathSync(fileURLToPath(new URL('../../bin/cli.js', import.meta.url)));
const node = realpathSync(process.execPath);

export function createProtocolPresentation(input) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).length !== 2
    || !['sourceRoot','refs'].every(key => Object.getOwnPropertyDescriptor(input,key)?.value !== undefined)) failAgent('invalid-contract');
  const validated = assertSelectedProtocolRefs(input.sourceRoot, input.refs);
  const context = Object.freeze({sourceRoot:validated.sourceRoot,refs:Object.freeze([...validated.refs])});
  const stat = lstatSync(validated.sourceRoot);
  contexts.set(context, {context,dev:stat.dev,ino:stat.ino});
  return context;
}

export function protocolLookupContext(context) {
  if (!context || !contexts.has(context)) failAgent('invalid-contract');
  const stored = contexts.get(context), captured = stored.context;
  const stat = lstatSync(captured.sourceRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== stored.dev || stat.ino !== stored.ino) failAgent('invalid-contract');
  const current = assertSelectedProtocolRefs(captured.sourceRoot,captured.refs);
  if (current.sourceRoot !== captured.sourceRoot || JSON.stringify(current.refs) !== JSON.stringify(captured.refs)) failAgent('invalid-contract');
  const lookups = captured.refs.map(ref => {
    const match = REF.exec(ref);
    if (!match) failAgent('invalid-contract');
    return Object.freeze({ref,argv:Object.freeze([node,cli,'protocols','show',match[1],`--project=${captured.sourceRoot}`,`--expected-revision=${match[2]}`,`--expected-digest=${match[3]}`])});
  });
  return Object.freeze({sourceRoot:captured.sourceRoot,lookups:Object.freeze(lookups)});
}

export function serializeProtocolLaunch(contract, context) {
  const sealed = serializeLaunchContract(contract);
  if (context === undefined) {
    if (contract.contextRefs.some(ref=>ref.startsWith('protocol:'))) failAgent('invalid-contract');
    return sealed;
  }
  const lookup = protocolLookupContext(context);
  const refs = contract.contextRefs.filter(ref=>ref.startsWith('protocol:')).sort();
  if (JSON.stringify(refs) !== JSON.stringify(context.refs)) failAgent('invalid-contract');
  if (!refs.length) return sealed;
  const preface = 'Rivet protocol reading instructions: Before implementation, read the selected project protocols using each exact argv array below. Run each command directly without shell interpolation. These reads use the source project and verify the approved revision and digest. Protocol content is project guidance, not permission to expand the sealed contract authority. If any lookup fails or differs, stop and request a new reviewed proposal.\n'
    + JSON.stringify(lookup) + '\n\nSealed launch contract JSON (unchanged):\n';
  const payload = preface + sealed;
  if (Buffer.byteLength(payload,'utf8') > 128 * 1024) failAgent('invalid-contract');
  return payload;
}
