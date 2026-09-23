import { CliError } from './output.js';

function interrupted() {
  return new CliError('Task interrupted. Inspect it with rivet task status before continuing.', 'REPOSITORY_CONFLICT');
}

export async function withTerminalInterruption(operation) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  try {
    let result;
    try { result = await operation(controller.signal); }
    catch (error) {
      if (controller.signal.aborted) throw interrupted();
      throw error;
    }
    if (controller.signal.aborted) throw interrupted();
    return result;
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
}
