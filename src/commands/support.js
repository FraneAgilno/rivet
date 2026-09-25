import { collectSupportBundle, resolveSupportProject } from '../support/bundle.js';
import { CliError, EXIT_CODES } from '../cli/output.js';
export async function supportCommand(parsed,dependencies) {
  if(parsed.operands.length||Object.keys(parsed.flags).some(key=>!['project','probe-harnesses','json'].includes(key)))
    throw new CliError('Use rivet support [--project=<path>] [--probe-harnesses] [--json].','INVALID_INPUT');
  const root=await resolveSupportProject(dependencies.cwd(),parsed.flags.project);
  const controller=new AbortController(),abort=()=>controller.abort();
  process.on('SIGINT',abort);process.on('SIGTERM',abort);
  let result;
  try {result=await collectSupportBundle(root,{environment:dependencies.env,signal:controller.signal,probeHarnesses:parsed.flags['probe-harnesses']===true,
    ...(dependencies.support?.diagnose?{diagnose:dependencies.support.diagnose}:{}),...(dependencies.support?.discoverHarnesses?{discoverHarnesses:dependencies.support.discoverHarnesses}:{})});}
  finally {process.off('SIGINT',abort);process.off('SIGTERM',abort)}
  if(parsed.flags.json)dependencies.output.json({ok:true,result});
  else {
    dependencies.output.log(`Support collection: ${result.collection.status}. Configuration: ${result.configuration.status}. Readiness: ${result.readiness.status}.`);
    dependencies.output.log('Save a shareable JSON bundle by redirecting rivet support --json to a file. Add --probe-harnesses to include local CLI capability checks.');
  }
  return EXIT_CODES.SUCCESS;
}
