#!/usr/bin/env node
import { main } from '../src/cli/main.js';
import { createRivetApplication } from '../src/runtime/application.js';

let streamExitCode = null;
let stderrUsable = true;

function recordStreamError(error, stream) {
  const exitCode = error?.code === 'EPIPE' ? 0 : 7;
  if (streamExitCode !== 7) streamExitCode = exitCode;
  process.exitCode = streamExitCode;
  if (stream === 'stderr') {
    stderrUsable = false;
    return;
  }
  if (exitCode === 7 && stderrUsable) {
    try {
      process.stderr.write('ERROR: Unexpected rivet output failure.\n');
    } catch {
      stderrUsable = false;
    }
  }
}

process.stdout.on('error', error => recordStreamError(error, 'stdout'));
process.stderr.on('error', error => recordStreamError(error, 'stderr'));

function writeFallbackError(message) {
  if (!stderrUsable) return;
  try {
    process.stderr.write(`${message}\n`);
  } catch {
    stderrUsable = false;
  }
}

main(process.argv.slice(2), createRivetApplication()).then(exitCode => {
  process.exitCode = streamExitCode ?? (Number.isInteger(exitCode) ? exitCode : 7);
}).catch(error => {
  writeFallbackError(error?.safeMessage ?? 'Unexpected rivet failure.');
  process.exitCode = streamExitCode ?? (Number.isInteger(error?.exitCode) ? error.exitCode : 7);
});
