function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const CONFIG_DIRECTORY = '.rivet';
export const PROTOCOL_DIRECTORY = 'protocols';
export const MAX_CONFIG_FILE_BYTES = 256 * 1024;

export const CONFIG_FILES = deepFreeze({
  project: 'project.yaml',
  providers: 'providers.yaml',
  orchestration: 'orchestration.yaml',
  quality: 'quality.yaml',
});

export const SCHEMA_FILES = deepFreeze({
  project: 'project.schema.json',
  providers: 'providers.schema.json',
  orchestration: 'orchestration.schema.json',
  quality: 'quality.schema.json',
  goalGraph: 'goal-graph.schema.json',
  event: 'event.schema.json',
  evidence: 'evidence.schema.json',
});

export const EVIDENCE_TYPES = deepFreeze([
  'commit',
  'test',
  'journey',
  'screenshot',
  'report',
  'review',
  'human-approval',
  'external-update',
]);

export const DEFAULT_CONFIG = deepFreeze({
  orchestration: {
    enabled: false,
  },
  externalWrites: {
    enabled: false,
    requireHumanApproval: true,
  },
  activation: {
    automatic: false,
    requireHumanApproval: true,
  },
});

export { deepFreeze };
