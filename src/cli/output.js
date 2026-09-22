import { Buffer } from 'node:buffer';

/**
 * Stable process exit codes. These numeric values are part of the CLI contract.
 */
export const EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  INVALID_INPUT: 1,
  MISSING_CONFIGURATION: 2,
  BLOCKED_AUTHORITY: 3,
  FAILED_GATE: 4,
  PROVIDER_UNAVAILABLE: 5,
  REPOSITORY_CONFLICT: 6,
  INTERNAL_ERROR: 7,
});

export const MAX_JSON_OUTPUT_BYTES = 64 * 1024;
const MIN_JSON_OUTPUT_BYTES = 128;
const outputErrorSubscriptions = new WeakMap();

export class CliError extends Error {
  constructor(safeMessage, code = 'INTERNAL_ERROR', { cause } = {}) {
    super(safeMessage, { cause });
    this.name = 'CliError';
    this.safeMessage = safeMessage;
    this.code = Object.hasOwn(EXIT_CODES, code) ? code : 'INTERNAL_ERROR';
    this.exitCode = EXIT_CODES[this.code];
  }
}

/** Buffers machine output so the process boundary can commit exactly one object. */
export function createJsonOutputBoundary(maxBytes = MAX_JSON_OUTPUT_BYTES) {
  const outputBudget = Number.isFinite(maxBytes)
    ? Math.min(MAX_JSON_OUTPUT_BYTES, Math.max(MIN_JSON_OUTPUT_BYTES, maxBytes))
    : MAX_JSON_OUTPUT_BYTES;
  let bufferedWrite = null;
  let attempted = false;
  let violated = false;

  const rejectWrite = () => {
    violated = true;
    throw new Error('Invalid output in JSON mode');
  };
  const output = Object.freeze({
    log: rejectWrite,
    warn: rejectWrite,
    error: rejectWrite,
    json(value, stream = 'stdout') {
      if (attempted || (stream !== 'stdout' && stream !== 'stderr')) {
        rejectWrite();
      }
      attempted = true;
      let serializedValue;
      try {
        const serialized = JSON.stringify(value);
        if (Buffer.byteLength(serialized, 'utf8') + 1 > outputBudget) rejectWrite();
        serializedValue = JSON.parse(serialized);
      } catch {
        rejectWrite();
      }
      if (
        serializedValue === null
        || Array.isArray(serializedValue)
        || typeof serializedValue !== 'object'
      ) {
        rejectWrite();
      }
      bufferedWrite = { value: serializedValue, stream };
    },
  });

  return Object.freeze({
    output,
    commit(target, exitCode) {
      const expectedStream = exitCode === EXIT_CODES.SUCCESS ? 'stdout' : 'stderr';
      if (violated || !bufferedWrite || bufferedWrite.stream !== expectedStream) {
        throw new Error('Invalid output in JSON mode');
      }
      target.json(bufferedWrite.value, bufferedWrite.stream);
    },
  });
}

export function createOutput({ stdout = process.stdout, stderr = process.stderr } = {}) {
  const listeners = new Set();
  let detachStreams = null;
  const notifyOutputError = () => {
    for (const listener of listeners) {
      try { listener(); } catch { /* output failure observers cannot affect publication */ }
    }
  };
  const attachStream = stream => {
    if (!stream || typeof stream.on !== 'function' || typeof stream.off !== 'function') return () => {};
    const onError = () => notifyOutputError();
    stream.on('error', onError);
    return () => {
      try { stream.off('error', onError); } catch { /* stream cleanup is best effort */ }
    };
  };
  const subscribe = listener => {
    listeners.add(listener);
    if (listeners.size === 1) {
      let detachStdout = () => {};
      let detachStderr = () => {};
      try {
        detachStdout = attachStream(stdout);
        if (stderr !== stdout) detachStderr = attachStream(stderr);
      } catch {
        listeners.delete(listener);
        detachStdout();
        detachStderr();
        return null;
      }
      detachStreams = () => { detachStdout(); detachStderr(); };
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      listeners.delete(listener);
      if (listeners.size === 0 && detachStreams) {
        detachStreams();
        detachStreams = null;
      }
    };
  };
  const writeLine = (stream, value = '') => {
    try { stream.write(`${String(value)}\n`); }
    catch {
      notifyOutputError();
      throw new Error('Output publication failed.');
    }
  };

  const output = Object.freeze({
    log: value => writeLine(stdout, value),
    warn: value => writeLine(stderr, value),
    error: value => writeLine(stderr, value),
    json(value, stream = 'stdout') {
      writeLine(stream === 'stderr' ? stderr : stdout, JSON.stringify(value));
    },
  });
  outputErrorSubscriptions.set(output, subscribe);
  return output;
}

/** Subscribes only outputs created by createOutput; listener receives no raw stream error. */
export function observeOutputErrors(output, listener) {
  if (typeof listener !== 'function') return null;
  const subscribe = outputErrorSubscriptions.get(output);
  if (!subscribe) return null;
  try { return subscribe(listener); } catch { return null; }
}

/** JSON-mode errors are one object on stderr; human-readable errors use stderr text. */
export function emitCliError(output, error, { json = false } = {}) {
  const cliError = error instanceof CliError
    ? error
    : new CliError('Unexpected rivet failure.', 'INTERNAL_ERROR');

  if (json) {
    output.json({
      ok: false,
      error: {
        code: cliError.code,
        exitCode: cliError.exitCode,
        message: cliError.safeMessage,
      },
    }, 'stderr');
  } else {
    output.error(`ERROR: ${cliError.safeMessage}`);
  }
  return cliError.exitCode;
}
