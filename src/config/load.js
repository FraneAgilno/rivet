import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { parseAllDocuments, visit } from 'yaml';

import {
  CONFIG_DIRECTORY,
  CONFIG_FILES,
  DEFAULT_CONFIG,
  MAX_CONFIG_FILE_BYTES,
  deepFreeze,
} from './defaults.js';
import { ConfigurationError, validateProjectConfiguration } from './validate.js';

const DEFAULT_FILE_SYSTEM = Object.freeze({
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
});

function parseYaml(source, filename) {
  let documents;
  try {
    documents = parseAllDocuments(source, {
      maxAliasCount: 0,
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
      version: '1.2',
    });
  } catch {
    throw new ConfigurationError(`/${filename}`, 'yaml-parse');
  }
  if (documents.length !== 1) throw new ConfigurationError(`/${filename}`, 'yaml-document-count');
  const [document] = documents;
  if (document.errors.length || document.warnings.length) throw new ConfigurationError(`/${filename}`, 'yaml-parse');

  let unsafe = false;
  visit(document, {
    Alias() {
      unsafe = true;
      return visit.BREAK;
    },
    Pair(_key, pair) {
      if (pair.key?.value === '<<') {
        unsafe = true;
        return visit.BREAK;
      }
      return undefined;
    },
  });
  if (unsafe) throw new ConfigurationError(`/${filename}`, 'yaml-alias');

  let value;
  try {
    value = document.toJS({ maxAliasCount: 0, mapAsMap: false });
  } catch {
    throw new ConfigurationError(`/${filename}`, 'yaml-conversion');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigurationError(`/${filename}`, 'yaml-root');
  return value;
}

function sameIdentity(first, second) {
  return first.dev === second.dev && first.ino === second.ino;
}

function readRegularConfigFile(filename, fs) {
  let metadata;
  try {
    metadata = fs.lstatSync(filename);
  } catch {
    throw new ConfigurationError(`/${filename}`, 'missing-file');
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new ConfigurationError(`/${filename}`, 'not-regular-file');
  if (metadata.size > MAX_CONFIG_FILE_BYTES) throw new ConfigurationError(`/${filename}`, 'file-too-large');

  let descriptor;
  try {
    descriptor = fs.openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedMetadata = fs.fstatSync(descriptor);
    if (!sameIdentity(metadata, openedMetadata)) {
      throw new ConfigurationError(`/${filename}`, 'file-identity-changed');
    }
    if (!openedMetadata.isFile() || openedMetadata.size > MAX_CONFIG_FILE_BYTES) {
      throw new ConfigurationError(`/${filename}`, 'invalid-opened-file');
    }
    const data = Buffer.alloc(MAX_CONFIG_FILE_BYTES + 1);
    let offset = 0;
    while (offset < data.length) {
      const bytesRead = fs.readSync(descriptor, data, offset, data.length - offset, null);
      if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > data.length - offset) {
        throw new ConfigurationError(`/${filename}`, 'invalid-read');
      }
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_CONFIG_FILE_BYTES) throw new ConfigurationError(`/${filename}`, 'file-too-large');
    return data.subarray(0, offset).toString('utf8');
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(`/${filename}`, 'read-failed');
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        throw new ConfigurationError(`/${filename}`, 'close-failed');
      }
    }
  }
}

function readTrackedConfiguration(configRoot, fs) {
  let configRootMetadata;
  try {
    configRootMetadata = fs.lstatSync(configRoot);
  } catch {
    throw new ConfigurationError(`/${CONFIG_DIRECTORY}`, 'missing-directory');
  }
  if (configRootMetadata.isSymbolicLink() || !configRootMetadata.isDirectory()) {
    throw new ConfigurationError(`/${CONFIG_DIRECTORY}`, 'invalid-directory');
  }

  const originalCwd = process.cwd();
  let changedDirectory = false;
  try {
    process.chdir(configRoot);
    changedDirectory = true;
    const anchoredMetadata = fs.statSync('.');
    if (!anchoredMetadata.isDirectory() || !sameIdentity(configRootMetadata, anchoredMetadata)) {
      throw new ConfigurationError(`/${CONFIG_DIRECTORY}`, 'directory-identity-changed');
    }
    const expectedFiles = Object.values(CONFIG_FILES).sort();
    const actualFiles = fs.readdirSync('.').sort();
    if (actualFiles.length !== expectedFiles.length || actualFiles.some((entry, index) => entry !== expectedFiles[index])) {
      throw new ConfigurationError(`/${CONFIG_DIRECTORY}`, 'unexpected-entry');
    }
    const parsed = {};
    for (const [name, filename] of Object.entries(CONFIG_FILES)) {
      parsed[name] = parseYaml(readRegularConfigFile(filename, fs), filename);
    }
    return parsed;
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(`/${CONFIG_DIRECTORY}`, 'directory-read-failed');
  } finally {
    if (changedDirectory) {
      try {
        process.chdir(originalCwd);
      } catch {
        throw new ConfigurationError(`/${CONFIG_DIRECTORY}`, 'cwd-restore-failed');
      }
    }
  }
}

function normalize(config) {
  return {
    project: {
      ...config.project,
      repository: {
        sensitivePaths: [],
        ...config.project.repository,
      },
    },
    providers: config.providers,
    orchestration: {
      enabled: DEFAULT_CONFIG.orchestration.enabled,
      ...config.orchestration,
    },
    quality: config.quality,
  };
}

export async function loadProjectConfig(projectRoot, options = {}) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0 || projectRoot.includes('\0')) {
    throw new ConfigurationError('/', 'project-root');
  }
  const configRoot = join(resolve(projectRoot), CONFIG_DIRECTORY);
  const fs = Object.freeze({ ...DEFAULT_FILE_SYSTEM, ...(options.fs ?? {}) });
  const parsed = readTrackedConfiguration(configRoot, fs);
  const normalized = normalize(parsed);
  validateProjectConfiguration(normalized);
  return deepFreeze(normalized);
}

export function providerCredentialStatus(config, environment = process.env) {
  try {
    const providers = config?.providers?.providers;
    if (!Array.isArray(providers) || !environment || typeof environment !== 'object' || Array.isArray(environment)) {
      throw new TypeError();
    }
    return deepFreeze(providers.flatMap(provider => Object.entries(provider.credentials ?? {})
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([, name]) => {
        if (typeof name !== 'string' || !/^[A-Z][A-Z0-9_]{1,127}$/.test(name)) throw new TypeError();
        const value = environment[name];
        return {
          provider: provider.id,
          name,
          present: typeof value === 'string' && value.length > 0,
          required: provider.mode !== 'disabled',
        };
      })));
  } catch {
    throw new ConfigurationError('/providers/providers', 'credential-reference');
  }
}

export const loadConfig = loadProjectConfig;
