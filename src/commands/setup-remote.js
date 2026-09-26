import { CliError } from '../cli/output.js';
import { discoverGit } from '../discovery/git.js';
import { discoverRepositoryRemotes, parseRepositoryRemote, selectConfiguredRepositoryRemote } from '../repositories/index.js';
import { defaultIntegrationSetupPrompt } from '../cli/integration-setup-prompt.js';

const failure = () => new CliError('Repository remote is missing, ambiguous or changed. Review local Git remotes and use setup --remote=<name> to select the intended repository.', 'REPOSITORY_CONFLICT');
export async function prepareSetupRemote(root, flags, dependencies, preference) {
  const read = async () => {
    const git = await (dependencies.gitDiscovery ?? discoverGit)(root,{runner:dependencies.runner});
    if (!git.repository) return [];
    try { return await (dependencies.repositories?.discoverRemotes ?? discoverRepositoryRemotes)(root,{runner:dependencies.runner}); }
    catch { throw failure(); }
  };
  const remotes = await read();
  const choices = remotes.flatMap(remote => {
    try { const selected=selectConfiguredRepositoryRemote([remote]);return [{name:selected.remoteName,url:selected.url}]; }
    catch { return []; }
  });
  let selected;
  if (flags.remote !== undefined || preference) {
    try { const found=selectConfiguredRepositoryRemote(remotes,preference,flags.remote);selected={name:found.remoteName,url:found.url}; }
    catch { throw failure(); }
  } else if (choices.length === 1) selected=choices[0];
  else if (choices.length > 1 && flags.write) {
    if (flags.json || !(dependencies.terminalIsInteractive?.() ?? false)) throw failure();
    const prompt=dependencies.setupRemotePrompt ?? defaultIntegrationSetupPrompt;
    const name=await prompt({type:'select',message:'Choose the repository remote for inspection and delivery:',choices:choices.map(choice=>({value:choice.name,label:`${choice.name}: ${choice.url}`}))});
    selected=choices.find(choice=>choice.name===name);
    if (!selected) throw new CliError('Repository selection cancelled. No setup files were written.','REPOSITORY_CONFLICT');
  }
  const verify = async () => {
    const current=await read();
    if (selected) {
      try { selectConfiguredRepositoryRemote(current,selected); } catch { throw failure(); }
    } else {
      const safe=current.flatMap(remote=>{try{return [{name:remote.name,url:parseRepositoryRemote(remote.url).url}];}catch{return [];}});
      if (JSON.stringify(safe)!==JSON.stringify(choices)) throw failure();
    }
  };
  return {selected,choices,status:selected?'selected':choices.length?'selection-required':'local-only',verify};
}
