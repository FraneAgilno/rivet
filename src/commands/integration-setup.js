import { CliError, EXIT_CODES } from '../cli/output.js';
import { resolveConfiguredProject } from '../cli/project-discovery.js';
import { prepareProviderAppend } from './init.js';
import { createIntegrationRegistry } from '../integrations/registry.js';

const KINDS=['jira','linear','figma','confluence'];
const CAPS={jira:'issues-read',linear:'issues-read',figma:'files-read',confluence:'pages-read'};
class Cancelled extends Error {}
function fail(message,code='INVALID_INPUT'){throw new CliError(message,code);}
function text(value){if(typeof value!=='string'||!value.length||value.length>2048||/[\u0000-\u001f\u007f]/.test(value))fail('Enter a bounded configuration value. Secret values must never be entered.');return value.trim();}
function envName(value){const name=text(value);if(!/^[A-Z][A-Z0-9_]{1,127}$/.test(name))fail('Enter an environment variable NAME such as JIRA_API_TOKEN, never a credential value.');return name;}
function csv(value,pattern){const values=text(value).split(',').map(item=>item.trim());if(values.length>64||values.some(item=>!pattern.test(item))||new Set(values).size!==values.length)fail('Enter unique comma-separated values in the requested format.');return values;}
function endpoint(kind,value){
  const result=text(value);let url;try{url=new URL(result);}catch{fail('Enter the HTTPS source origin only.');}
  const host=kind==='linear'?url.hostname==='linear.app':kind==='figma'?['figma.com','www.figma.com'].includes(url.hostname):/^[a-z0-9][a-z0-9-]*\.atlassian\.net$/.test(url.hostname);
  if(!host||url.protocol!=='https:'||url.username||url.password||url.port||url.pathname!=='/'||url.search||url.hash)fail('Use the supported HTTPS source origin with no credentials, path or query.');return url.origin;
}
export async function integrationSetup(parsed,dependencies){
  if(parsed.operands.length||Object.keys(parsed.flags).some(key=>key!=='project'))fail('Use rivet integrations setup [--project=<path>] in an interactive terminal.');
  if(dependencies.terminalIsInteractive?.()!==true||typeof dependencies.integrationSetupPrompt!=='function')fail('Run rivet integrations setup in an interactive terminal to preview and approve local settings.');
  const project=await resolveConfiguredProject(dependencies.cwd(),parsed.flags.project,{env:dependencies.env,runner:dependencies.runGit});
  let captured;try{captured=await prepareProviderAppend(project.root,{fs:dependencies.fs});}catch{fail('Existing project configuration is missing, invalid or unsafe. Run rivet setup first; existing files were preserved.','REPOSITORY_CONFLICT');}
  const ask=async question=>{let answer;try{answer=await dependencies.integrationSetupPrompt(question);}catch{throw new Cancelled();}if(answer===null||answer===undefined)throw new Cancelled();return answer;};
  const select=async(id,message,choices)=>{const answer=await ask({id,type:'select',message,choices});if(!choices.some(choice=>choice.value===answer))fail('Choose one of the displayed options.');return answer;};
  const input=(id,message,defaultValue)=>ask({id,type:'input',message,...(defaultValue?{defaultValue}:{})});
  const existing=captured.config.providers.providers,projectId=captured.config.project.id;
  dependencies.output.log(`Project: ${projectId}\nExisting integrations preserved: ${existing.map(p=>p.id).join(', ')}`);
  dependencies.output.log('This guide appends read-only local settings. It never requests credential values, authenticates tools or calls providers. Figma and Confluence are harness-MCP context sources in this workflow.');
  try{
    const kinds=await ask({id:'providers',type:'multi',message:'Which integrations would you like to add?',choices:KINDS.map(value=>({value,label:value==='confluence'?'Confluence context':value==='figma'?'Figma context':value==='jira'?'Jira tracker':'Linear tracker'}))});
    if(!Array.isArray(kinds)||kinds.length>4||new Set(kinds).size!==kinds.length||kinds.some(kind=>!KINDS.includes(kind)))fail('Select the displayed integrations.');
    if(!kinds.length)throw new Cancelled();
    const added=[],ids=new Set(existing.map(p=>p.id));
    for(const kind of kinds){
      const transport=await select(kind+'.transport',`How will ${kind} be read?`,[
        {value:'harness-mcp',label:'Connected harness tools (MCP)'},...(['jira','linear'].includes(kind)?[{value:'direct-api',label:'Direct API using environment references'}]:[])]);
      if(transport==='direct-api'&&existing.some(p=>p.kind===kind&&(p.transport??'direct-api')==='direct-api'&&p.mode!=='disabled'&&p.capabilities.includes('issues-read')&&(!p.projectIds?.length||p.projectIds.includes(projectId))))fail(`An enabled direct ${kind} issue reader already matches this project. Adding another would make ticket intake ambiguous. Review the existing descriptor; the guide will not replace it.`,'REPOSITORY_CONFLICT');
      const prefix=kind+(transport==='direct-api'?'-direct':'-mcp');let id=prefix,index=2;while(ids.has(id))id=prefix+'-'+index++;ids.add(id);
      const descriptor={id,kind,mode:'read-only',transport,capabilities:[CAPS[kind]],projectIds:[projectId]};
      if(kind==='linear'&&transport==='direct-api')descriptor.endpoint='https://api.linear.app';
      else descriptor.endpoint=endpoint(kind,await input(kind+'.endpoint',`${kind} HTTPS source origin (no path, query or credentials)`,kind==='linear'?'https://linear.app':kind==='figma'?'https://www.figma.com':undefined));
      const scope=await select(kind+'.scope',`Resource access for ${id} within project ${projectId}`,[{value:'selected',label:'Specific resource IDs'},{value:'all',label:'All provider-accessible resources for this project'}]);
      descriptor.resourceIds=scope==='all'?[]:csv(await input(kind+'.resources',kind==='jira'||kind==='linear'?'Issue keys, comma-separated (for example DEMO-1, DEMO-2)':kind==='confluence'?'Confluence page IDs, comma-separated':'Figma file keys, comma-separated'),['jira','linear'].includes(kind)?/^[A-Z][A-Z0-9]{0,31}-[1-9][0-9]{0,15}$/:kind==='confluence'?/^[1-9][0-9]{0,19}$/:/^[A-Za-z0-9_-]{1,200}$/);
      if(transport==='harness-mcp')descriptor.tools=csv(await input(kind+'.tools','Exact read tool names exposed by your harness, comma-separated; tool availability is not inferred'),/^[A-Za-z0-9_.:-]{1,128}$/);
      else descriptor.credentials=kind==='jira'?{
        usernameEnv:envName(await input(kind+'.usernameEnv','Environment variable NAME for your Jira email (never the email value)','JIRA_USERNAME')),
        apiTokenEnv:envName(await input(kind+'.apiTokenEnv','Environment variable NAME for the Jira API token (never the token value)','JIRA_API_TOKEN')),
      }:{apiTokenEnv:envName(await input(kind+'.apiTokenEnv','Environment variable NAME for the Linear API key (never the key value)','LINEAR_API_KEY'))};
      added.push(descriptor);
    }
    let proposal;try{
      const config={...captured.config,providers:{...captured.config.providers,providers:[...existing,...added]}};
      createIntegrationRegistry({config,projectId});proposal=captured.propose(added);
    }catch{fail('The proposed provider settings failed configuration validation. No files were written.');}
    dependencies.output.log('Exact providers.yaml preview (existing descriptor values are preserved):\n'+proposal.providersYaml);
    for(const provider of added)dependencies.output.log(`${provider.id}: project ${projectId}; ${provider.resourceIds.length?'only resource IDs: '+provider.resourceIds.join(', '):'all provider-accessible resources in this project; no resource ID filter'}. ${provider.transport==='harness-mcp'?'Tool names configured; current authenticated host inventory is still required.':'Credential references configured; environment values were not inspected.'}`);
    dependencies.output.log('No network access or authentication was checked. Only .rivet/providers.yaml content changes; the other configuration files retain their exact bytes.');
    const confirmed=await ask({id:'confirm',type:'confirm',message:'Write these local provider settings?'});
    if(confirmed!==true)throw new Cancelled();
    let cleanup;try{cleanup=await proposal.commit();}catch(error){throw new CliError('Provider settings were not committed safely. Inspect concurrent edits, initialization locks or transaction recovery; do not force an overwrite.','REPOSITORY_CONFLICT',{cause:error});}
    dependencies.output.log('Local provider settings written. Review and commit the configuration, then run rivet integrations check. Connected tool inventory and credentials remain separate.');
    if(cleanup.residueCount)dependencies.output.log(cleanup.warning??cleanup.remediation);
    return EXIT_CODES.SUCCESS;
  }catch(error){if(error instanceof Cancelled){dependencies.output.log('Integration setup cancelled. No configuration changes were written.');return EXIT_CODES.SUCCESS;}throw error;}
}
