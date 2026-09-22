const byId = id => document.getElementById(id);

function element(tag, text, className) {
  const value = document.createElement(tag);
  if (text !== undefined) value.textContent = String(text);
  if (className) value.className = className;
  return value;
}

function duration(milliseconds) {
  const minutes = Math.floor((milliseconds ?? 0) / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

function rows(target, values, render, empty = 'None') {
  const children = values.length ? values.map(render) : [element('p', empty, 'muted')];
  target.replaceChildren(...children);
}

function card(title, detail, status) {
  const value = element('div', undefined, 'row');
  const copy = element('div');
  copy.append(element('strong', title), element('small', detail));
  value.append(copy, element('span', status, `badge status-${status}`));
  return value;
}

function render(model) {
  byId('goal-heading').textContent = model.goal.id;
  byId('stage').textContent = model.currentStage
    ? `Current stage: ${model.currentStage.nodeId} · ${model.currentStage.status}`
    : 'No active stage';
  const metrics = [
    ['State', model.goal.status], ['Elapsed', duration(model.budget.elapsedMs)],
    ['Tokens', model.budget.usage.tokens], ['Cost', `$${model.budget.usage.costUsd}`],
    ['Heartbeat', model.latestHeartbeatAt ? new Date(model.latestHeartbeatAt).toLocaleTimeString() : '—'],
  ];
  byId('metrics').replaceChildren(...metrics.map(([label, value]) => {
    const metric = element('div', undefined, 'metric');
    metric.append(element('span', label), element('strong', value));
    return metric;
  }));
  rows(byId('graph'), model.graph.nodes, node => card(
    node.id,
    `${node.role} · parent ${node.parentId ?? 'root'} · depends on ${node.dependencies.join(', ') || 'none'}`,
    node.status,
  ));
  rows(byId('agents'), model.agents, agent => card(agent.id, `${agent.role} · ${agent.currentNodeId} · ${duration(agent.elapsedMs)}`, agent.status));
  rows(byId('worktrees'), model.worktrees, worktree => card(
    worktree.nodeId,
    `${worktree.ownerId} · ${worktree.displayPath}`,
    worktree.status,
  ), 'No owned worktrees');
  rows(byId('gates'), model.gates, gate => card(gate.id, gate.requiredEvidence.join(' · '), gate.status), 'No human gates');
  rows(byId('corrective'), model.correctiveWork, item => card(item.nodeId, `Attempt ${item.attempt}${item.reason ? ` · ${item.reason}` : ''}`, item.status), 'No corrective work');
  rows(byId('evidence'), model.evidence, item => {
    const value = card(item.id, `${item.type} · ${item.nodeId ?? 'goal'}`, item.approvalState);
    if (item.url) {
      const link = element('a', 'Open evidence', 'evidence-link');
      link.href = item.url;
      link.rel = 'noreferrer noopener';
      value.append(link);
    }
    return value;
  }, 'No evidence recorded');
  rows(byId('decisions'), model.humanDecisions, item => card(item.gateId, `${item.actorId} · ${new Date(item.decidedAt).toLocaleTimeString()}`, item.decision), 'No human decisions');
  rows(byId('events'), model.events.slice(-20).reverse(), item => card(item.type, `${item.nodeId ?? 'goal'} · #${item.sequence}`, item.actor.role), 'No events');
}

async function refresh() {
  const response = await fetch('/api/state', { cache: 'no-store' });
  if (!response.ok) throw new Error('status unavailable');
  render(await response.json());
}

function connect() {
  const source = new EventSource('/events');
  source.onopen = () => {
    byId('connection').textContent = 'Live';
    byId('connection-dot').className = 'connected';
  };
  source.addEventListener('status', () => { void refresh(); });
  source.addEventListener('reset', () => { void refresh(); });
  source.addEventListener('unavailable', () => {
    byId('connection').textContent = 'Reconnecting';
    byId('connection-dot').className = '';
  });
  source.onerror = () => {
    byId('connection').textContent = 'Reconnecting';
    byId('connection-dot').className = '';
  };
}

refresh().catch(() => { byId('connection').textContent = 'Unavailable'; });
connect();
