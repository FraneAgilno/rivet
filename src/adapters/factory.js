import { createJiraAdapter } from './jira.js';
import { createLinearAdapter } from './linear.js';
import { providerCredentialStatus } from '../config/load.js';

const TRACKERS = new Set(['jira', 'linear']);
const ENV_NAME = /^[A-Z][A-Z0-9_]{1,127}$/;

export class TrackerProviderFactoryError extends Error {
  constructor() {
    super('Tracker provider configuration is missing, ambiguous, or invalid.');
    this.name = 'TrackerProviderFactoryError';
    this.code = 'ERR_TRACKER_PROVIDER_CONFIGURATION';
    this.safeMessage = this.message;
  }
}

function fail() { throw new TrackerProviderFactoryError(); }

function snapshotInput(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail();
    const allowed = new Set(['config', 'environment', 'transport', 'clock']);
    const keys = Reflect.ownKeys(input);
    if (keys.some(key => typeof key !== 'string' || !allowed.has(key))
      || !['config', 'environment', 'transport'].every(key => keys.includes(key))) fail();
    const output = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
      output[key] = descriptor.value;
    }
    return output;
  } catch (error) {
    if (error instanceof TrackerProviderFactoryError) throw error;
    fail();
  }
}

function envValue(environment, reference) {
  if (typeof reference !== 'string' || !ENV_NAME.test(reference)) fail();
  let value;
  try { value = environment[reference]; } catch { fail(); }
  if (typeof value !== 'string' || value.length < 1 || value.length > 8192 || /[\u0000\r\n]/.test(value)) fail();
  return value;
}

function selectProvider(providers, tracker, projectId) {
  if (tracker !== undefined && !TRACKERS.has(tracker)) fail();
  const candidates = providers.filter(provider => provider && typeof provider === 'object' && !Array.isArray(provider)
    && (!provider.projectIds?.length || provider.projectIds.includes(projectId))
    && (provider.transport === undefined || provider.transport === 'direct-api')
    && TRACKERS.has(provider.kind) && provider.mode !== 'disabled'
    && Array.isArray(provider.capabilities) && provider.capabilities.includes('issues-read')
    && (tracker === undefined || provider.kind === tracker));
  if (candidates.length !== 1) fail();
  return candidates[0];
}

function credentialsFor(provider, environment) {
  const credentials = provider.credentials;
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) fail();
  if (provider.kind === 'jira') {
    const username = envValue(environment, credentials.usernameEnv);
    const token = envValue(environment, credentials.apiTokenEnv);
    return Object.freeze({ authorization: `Basic ${Buffer.from(`${username}:${token}`, 'utf8').toString('base64')}`, accept: 'application/json' });
  }
  return Object.freeze({ authorization: envValue(environment, credentials.apiTokenEnv), accept: 'application/json' });
}

export function createTrackerProviderFactory(input) {
  const captured = snapshotInput(input);
  const providers = captured.config?.providers?.providers;
  if (!Array.isArray(providers) || providers.length < 1 || providers.length > 64
    || !captured.environment || typeof captured.environment !== 'object' || Array.isArray(captured.environment)
    || !captured.transport || typeof captured.transport !== 'object'
    || (captured.clock !== undefined && typeof captured.clock !== 'function')) fail();

  const credentialStatus = () => {
    try {
      return providerCredentialStatus(captured.config, captured.environment)
        .filter(item => providers.some(provider => provider.id === item.provider && TRACKERS.has(provider.kind)));
    } catch { fail(); }
  };

  return Object.freeze({
    credentialStatus,
    create(options = {}) {
      try {
        if (!options || typeof options !== 'object' || Array.isArray(options)) fail();
        const keys = Reflect.ownKeys(options);
        if (keys.some(key => key !== 'tracker')) fail();
        if (keys.includes('tracker')) {
          const descriptor = Object.getOwnPropertyDescriptor(options, 'tracker');
          if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
        }
        const selected = selectProvider(providers, options.tracker, captured.config.project?.id);
        if (typeof selected.endpoint !== 'string') fail();
        const common = {
          transport: captured.transport,
          baseUrl: selected.endpoint,
          headers: credentialsFor(selected, captured.environment),
          ...(captured.clock === undefined ? {} : { clock: captured.clock }),
        };
        return selected.kind === 'jira' ? createJiraAdapter(common) : createLinearAdapter(common);
      } catch (error) {
        if (error instanceof TrackerProviderFactoryError) throw error;
        fail();
      }
    },
  });
}
