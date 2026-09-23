import { resolveConfiguredProject } from '../cli/project-discovery.js';
import { withTerminalInterruption } from '../cli/interrupt.js';
import { CLAUDE_ADAPTER_SYNTAX } from '../clients/claude.js';
import { CODEX_ADAPTER_SYNTAX } from '../clients/codex.js';
import { CliError, EXIT_CODES, observeOutputErrors } from '../cli/output.js';
import { invokeFeature } from './feature.js';

const KINDS = new Set(['claude', 'codex']);
const SUPPORTED = Object.freeze({
  claude: CLAUDE_ADAPTER_SYNTAX.observedVersion,
  codex: CODEX_ADAPTER_SYNTAX.observedVersion,
});

function fail(message, code = 'INVALID_INPUT') { throw new CliError(message, code); }

function visible(value) {
  return String(value).replace(/[\u0000-\u001f\u007f\u009b]/g, character => {
    if (character === '\n') return '\n';
    if (character === '\t') return '\t';
    return `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`;
  });
}

export function normalizedTask(value) {
  if (typeof value !== 'string' || value.length < 1 || Buffer.byteLength(value, 'utf8') > 4_000
    || !value.trim() || /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    || value.normalize('NFKC') !== value) fail('Task text is invalid or too long.');
  const task = value.trim();
  if (/^#\s+\S/m.test(task) && /^#{2,6}\s+Acceptance Criteria\s*$/im.test(task)) return task;
  if (/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(task)) {
    fail('A ticket ID alone does not include its acceptance criteria. Use the ticket intake command or describe the task.');
  }
  const criterion = task.replace(/\s+/g, ' ');
  return `# User request\n\n${task}\n\n## Acceptance Criteria\n- ${criterion}\n`;
}

function commandSteps(config, id) {
  const command = config.project.commands[id];
  if (!command) return ['not configured'];
  const steps = Array.isArray(command) ? [{ cwd: '.', argv: command }] : command.steps;
  return steps.map(step => `${step.cwd}: ${step.argv.join(' ')}`);
}

function reviewLines(project, task, harness, proposal) {
  const request = proposal.workRequest;
  const plan = proposal.featurePlan;
  if (!request || !plan || !Array.isArray(plan.nodes) || !Array.isArray(request.acceptanceCriteria)
    || typeof proposal.proposalDigest !== 'string' || !Number.isSafeInteger(proposal.version)) {
    fail('Rivet returned an invalid proposal.', 'INTERNAL_ERROR');
  }
  const lines = [
    'Review this exact Rivet plan before activation:',
    `Summary: ${proposal.summary ?? 'Ready for review.'}`,
    `Project: ${project.root}`,
    `Harness: ${harness.kind} (${harness.version})`,
    `Executable: ${harness.executable}`,
    `Base commit: ${plan.baselineCommit}`,
    `Providers: ${(plan.providerRefs ?? []).join(', ') || 'none'}`,
    ...(plan.clientProfile ? [`Client limits: ${JSON.stringify(plan.clientProfile)}`] : []),
    'Request:', task,
    'Acceptance criteria:', ...request.acceptanceCriteria.map(item => `  - ${item}`),
    'Work and scope:',
  ];
  for (const node of plan.nodes) {
    lines.push(`  ${node.role} (${node.id}): ${node.objective}`);
    for (const path of node.ownedPaths ?? []) lines.push(`    path: ${path}`);
    for (const dependency of node.dependencies ?? []) lines.push(`    after: ${dependency}`);
    for (const criterion of node.acceptanceCriteria ?? []) lines.push(`    accepts: ${criterion}`);
    for (const scope of node.authorityScopes ?? []) lines.push(`    authority: ${scope}`);
    for (const command of node.commandIds ?? []) lines.push(`    command: ${command}`);
    for (const evidence of node.requiredEvidenceTypes ?? []) lines.push(`    evidence: ${evidence}`);
    if (node.budget) lines.push(`    budget: ${JSON.stringify(node.budget)}`);
    if (node.approvalGate) lines.push(`    human gate: ${node.approvalGate}`);
  }
  lines.push('Required checks:');
  for (const gate of project.config.quality.commandGates.filter(item => item.required)) {
    lines.push(`  ${gate.command}:`);
    for (const step of commandSteps(project.config, gate.command)) lines.push(`    ${step}`);
  }
  for (const ref of request.contextRefs ?? []) lines.push(`Context/protocol: ${ref}`);
  lines.push('Stop conditions: a blocked worker, interrupted run, failed required check, or final human approval gate.');
  return lines.map(visible);
}

function resultCode(result) {
  if (result.status === 'awaiting-final-approval') return EXIT_CODES.SUCCESS;
  if (result.status === 'blocked') {
    return /quality gate|configured check/i.test(result.summary ?? '')
      ? EXIT_CODES.FAILED_GATE : EXIT_CODES.REPOSITORY_CONFLICT;
  }
  return EXIT_CODES.REPOSITORY_CONFLICT;
}

export async function humanRunCommand(parsed, dependencies) {
  if (parsed.command !== 'run' || parsed.subcommand !== null || parsed.operands.length !== 1
    || Object.keys(parsed.flags).some(key => !['project', 'harness'].includes(key))) {
    fail('Use rivet run "task" [--harness=claude|codex] [--project=<path>].');
  }
  if (dependencies.terminalIsInteractive?.() !== true) {
    fail('rivet run needs an interactive terminal for plan review and approval. Use feature/work JSON commands for automation.');
  }
  return withTerminalInterruption(signal => runInteractive(parsed, dependencies, signal));
}

async function runInteractive(parsed, dependencies, signal) {
  const project = await resolveConfiguredProject(dependencies.cwd(), parsed.flags.project, { env: dependencies.env });
  const harnesses = dependencies.harnesses;
  if (!harnesses || typeof harnesses.discover !== 'function' || typeof harnesses.select !== 'function') {
    fail('Harness discovery is unavailable.', 'MISSING_CONFIGURATION');
  }
  const requested = parsed.flags.harness;
  if (requested !== undefined && !KINDS.has(requested)) fail('Use --harness=claude or --harness=codex.');
  const discovered = await harnesses.discover(project.root, { signal });
  const eligible = discovered.filter(item => item.executable);
  let choice;
  if (requested) {
    choice = eligible.find(item => item.kind === requested);
    if (!choice) {
      const reason = discovered.find(item => item.kind === requested)?.reason;
      const interpreterHelp = reason === 'interpreter-required'
        ? ` This CLI is a script; set RIVET_${requested.toUpperCase()}_INTERPRETER to its canonical native interpreter path.` : '';
      fail(`The ${requested} adapter needs ${SUPPORTED[requested]} and an installed, authenticated CLI.${interpreterHelp} Check ${requested} --version. You can use the Rivet skill in your coding harness meanwhile.`, 'PROVIDER_UNAVAILABLE');
    }
  } else if (eligible.length === 1) choice = eligible[0];
  else if (eligible.length === 0) {
    const scripts = discovered.filter(item => item.reason === 'interpreter-required').map(item => `RIVET_${item.kind.toUpperCase()}_INTERPRETER`);
    const interpreterHelp = scripts.length ? ` Script CLIs need a canonical native interpreter path in ${scripts.join(' or ')}.` : '';
    fail(`No compatible CLI was found. Validated versions: Claude ${SUPPORTED.claude}; Codex ${SUPPORTED.codex}.${interpreterHelp} Check claude --version or codex --version, or use the Rivet skill in your coding harness.`, 'PROVIDER_UNAVAILABLE');
  } else fail('Both Claude and Codex are available. Choose --harness=claude or --harness=codex.');
  let selected;
  try { selected = await harnesses.select(choice.kind, project.root, { signal }); }
  catch { fail(`The ${choice.kind} adapter changed during discovery. Check the installed CLI and retry.`, 'PROVIDER_UNAVAILABLE'); }
  const task = normalizedTask(parsed.operands[0]);
  const feature = dependencies.feature;
  if (!feature || ['propose', 'start', 'watch', 'status'].some(name => typeof feature[name] !== 'function')) {
    fail('Feature workflow is unavailable.', 'MISSING_CONFIGURATION');
  }
  const proposal = await invokeFeature(feature, 'propose', {
    project: project.root, source: { kind: 'inline', value: task }, client: choice.kind,
  }, { signal });
  if (proposal.status !== 'proposed') {
    const existing = await invokeFeature(feature, 'status', { project: project.root, runId: proposal.runId });
    dependencies.output.log(`This exact request already has a ${visible(existing.status)} run. Use rivet task status to inspect it.`);
    return existing.status === 'awaiting-final-approval' ? EXIT_CODES.SUCCESS : EXIT_CODES.REPOSITORY_CONFLICT;
  }
  let outputFailed = false;
  const unobserve = observeOutputErrors(dependencies.output, () => { outputFailed = true; });
  let approved = false;
  try {
    try {
      for (const line of reviewLines(project, parsed.operands[0], selected, proposal)) dependencies.output.log(line);
    } catch { fail('Could not display the complete plan. The task was not activated.', 'REPOSITORY_CONFLICT'); }
    if (outputFailed) fail('Could not display the complete plan. The task was not activated.', 'REPOSITORY_CONFLICT');
    if (signal.aborted) fail('Task interrupted before activation.', 'REPOSITORY_CONFLICT');
    try { approved = await dependencies.confirmFeatureActivation(proposal, { signal }) === true; } catch { /* EOF is a decline. */ }
    if (outputFailed) fail('Plan output failed before approval. The task was not activated.', 'REPOSITORY_CONFLICT');
  } finally { unobserve?.(); }
  if (!approved) {
    dependencies.output.log('Plan not activated. The proposal remains available for review.');
    return EXIT_CODES.SUCCESS;
  }
  if (signal.aborted) fail('Task interrupted before activation.', 'REPOSITORY_CONFLICT');
  const started = await invokeFeature(feature, 'start', {
    project: project.root, runId: proposal.runId,
    expectedVersion: proposal.version, proposalDigest: proposal.proposalDigest,
  });
  const result = await invokeFeature(feature, 'watch', {
    project: project.root, runId: proposal.runId, expectedVersion: started.version,
  }, { signal });
  dependencies.output.log(`Rivet task: ${visible(result.status)}.`);
  if (result.summary) dependencies.output.log(visible(result.summary));
  dependencies.output.log('Use rivet task status to inspect the checkout and verification evidence.');
  return resultCode(result);
}
