import { gitExecutable, resolveConfiguredProject } from '../cli/project-discovery.js';
import { runArgv } from '../discovery/tools.js';
import { CliError, EXIT_CODES } from '../cli/output.js';
import { createNodeProviderTransport } from '../adapters/node-transport.js';
import { createRepositoryProvider, discoverRepositoryRemotes, selectConfiguredRepositoryRemote } from '../repositories/index.js';

const ENDPOINTS = Object.freeze({github:'https://api.github.com',bitbucket:'https://api.bitbucket.org/2.0',gitlab:'https://gitlab.com/api/v4'});
const ENV_NAME = /^[A-Z][A-Z0-9_]{1,127}$/;
function fail(message, code) { throw new CliError(message, code); }

function selectProvider(config, repository, flags) {
  const candidates = config.providers.providers.filter(provider => provider.kind === 'git-ci'
    && provider.mode !== 'disabled' && (provider.transport ?? 'direct-api') === 'direct-api'
    && provider.capabilities.includes('repository-read')
    && (flags.review === undefined || provider.capabilities.includes('checks-read'))
    && (!provider.projectIds?.length || provider.projectIds.includes(config.project.id))
    && (!provider.resourceIds?.length || provider.resourceIds.includes(repository.fullName))
    && typeof provider.endpoint === 'string'
    && provider.endpoint.replace(/\/$/,'') === ENDPOINTS[repository.provider]
    && (flags.provider === undefined || provider.id === flags.provider));
  if (candidates.length !== 1) fail('Configure one applicable git-ci provider with repository-read, the correct API endpoint and repository scope. Review inspection also requires checks-read. Use --provider=<id> when several match.', 'MISSING_CONFIGURATION');
  return candidates[0];
}

function headers(provider, environment) {
  const credentials = provider.credentials ?? {};
  const keys = Object.keys(credentials);
  if (keys.length !== 1 || !['tokenEnv','accessTokenEnv','apiTokenEnv'].includes(keys[0])
    || !ENV_NAME.test(credentials[keys[0]])) {
    fail('Configure one token environment reference for repository reads.', 'MISSING_CONFIGURATION');
  }
  const token = environment[credentials[keys[0]]];
  if (typeof token !== 'string' || !token || token.length > 8192 || /[\s\u0000-\u001f\u007f]/.test(token)) {
    fail('The configured repository token is missing or invalid. Set its environment variable and retry.', 'PROVIDER_UNAVAILABLE');
  }
  // This CLI accepts bearer credentials only; it never reads host application credentials.
  return {authorization:`Bearer ${token}`,accept:'application/json'};
}

export async function repositoriesCommand(parsed, dependencies) {
  const {subcommand,operands,flags} = parsed;
  if(subcommand !== 'inspect' || operands.length
    || Object.keys(flags).some(key=>!['project','json','remote','provider','review'].includes(key))
    || (flags.review !== undefined && (!/^[1-9][0-9]{0,8}$/.test(flags.review)))
    || (flags.provider !== undefined && !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(flags.provider))) {
    fail('Use rivet repositories inspect [--review=<number>] [--remote=<name>] [--provider=<id>] [--project=<path>] [--json].','INVALID_INPUT');
  }
  const project = await resolveConfiguredProject(dependencies.cwd(),flags.project,{runner:dependencies.runGit,env:dependencies.env});
  let repository;
  try {
    const executable = await gitExecutable(dependencies.env);
    const runner = (_command, args, options) => (dependencies.runGit ?? runArgv)(executable, args, options);
    const remotes = await (dependencies.repositories?.discoverRemotes ?? discoverRepositoryRemotes)(project.root, {runner});
    repository = selectConfiguredRepositoryRemote(remotes, project.config.project.repository.remote, flags.remote);
  } catch {
    fail('Repository remote is missing, ambiguous, changed or unsupported. Review setup --remote=<name>, or choose a GitHub.com, Bitbucket Cloud or GitLab.com remote with --remote=<name>.','REPOSITORY_CONFLICT');
  }
  const provider = selectProvider(project.config,repository,flags);
  const auth = headers(provider,dependencies.env);
  let data;
  try {
    const adapter = createRepositoryProvider({repository,headers:auth,
      transport:dependencies.repositories?.transport ?? createNodeProviderTransport()});
    data = flags.review === undefined ? await adapter.read({kind:'repository'}) : await adapter.inspect({number:Number(flags.review)});
  } catch(error) {
    if(error?.code === 'ERR_PROVIDER_STATE_CONFLICT') fail('The review head changed during inspection. Retry to capture a consistent snapshot.','REPOSITORY_CONFLICT');
    fail('Repository inspection failed. Check token access, repository or review existence, rate limits and provider availability.','PROVIDER_UNAVAILABLE');
  }
  const result = {repository,providerId:provider.id,networkChecked:true,observation:data};
  if(flags.json) dependencies.output.json({ok:true,result});
  else {
    dependencies.output.log(`${repository.fullName} (${repository.provider}, remote ${repository.remoteName})`);
    dependencies.output.log(JSON.stringify(data,null,2).replace(/[\u0000-\u0008\u000b-\u001f\u007f\u009b]/g,c=>`\\u${c.codePointAt(0).toString(16).padStart(4,'0')}`));
    dependencies.output.log('Read-only observation. This does not authorize merge or deployment.');
  }
  return EXIT_CODES.SUCCESS;
}
