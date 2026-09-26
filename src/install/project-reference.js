import { join } from 'node:path';
import { CliError } from '../cli/output.js';
import integrity from './runtime-integrity.cjs';
const { runtimeIntegrity } = integrity;
const NAME = '.rivet.cjs';
const fail = message => { throw new CliError(message, 'REPOSITORY_CONFLICT'); };
function regular(file, fs, maximum) {
  const before=fs.lstatSync(file);
  if(!before.isFile()||before.isSymbolicLink()||before.size>maximum)fail('Project runtime reference is unsafe.');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
  try{
    const opened=fs.fstatSync(fd),bytes=fs.readFileSync(fd),after=fs.fstatSync(fd);
    if(opened.dev!==before.dev||opened.ino!==before.ino||bytes.length!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)fail('Project runtime reference changed.');
    return bytes;
  }finally{fs.closeSync(fd);}
}
// Version 1 is an ownership contract: future formats must retain this renderer
// and verifier for recognizing unchanged references written by older releases.
export function launcher(id) {
  return `// Rivet project source v1: ${id}\n'use strict';\nconst path = require('node:path');\nconst cache = path.join(require('node:fs').realpathSync(require('node:os').homedir()), '.cache', 'rivet', 'project-runtimes');\ntry {\n  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');\n  const fs = require('node:fs');\n  if (fs.realpathSync(cache) !== cache) throw new Error('Private runtime cache path is unsafe.');\n  const index = path.join(cache, 'source-${id}-' + process.platform + '-' + process.arch + '.json');\n  const stat = fs.lstatSync(index);\n  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error('Private runtime index is unsafe.');\n  const fd = fs.openSync(index, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));\n  let record;\n  try {\n    const opened = fs.fstatSync(fd), buffer = Buffer.alloc(1025), size = fs.readSync(fd, buffer, 0, buffer.length, 0), after = fs.fstatSync(fd);\n    if (opened.dev !== stat.dev || opened.ino !== stat.ino || size !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('Private runtime index changed.');\n    record = JSON.parse(buffer.subarray(0, size).toString('utf8'));\n  } finally { fs.closeSync(fd); }\n  if (Object.keys(record).length !== 1 || !/^[a-f0-9]{64}$/.test(record.runtimeId)) throw new Error('Private runtime index is invalid.');\n  const runtime = (${runtimeIntegrity.toString()})(path.join(cache, record.runtimeId), record.runtimeId, '${id}');\n  import(require('node:url').pathToFileURL(runtime.entry).href).catch(error => { console.error(error.safeMessage || 'Pinned Rivet failed.'); process.exitCode = 1; });\n} catch (error) { console.error(error.message); process.exitCode = 1; }\n`;
}
export function reference(root, fs) {
  const file = join(root, NAME), stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  const bytes = regular(file, fs, 32768), match = /^\/\/ Rivet project source v1: ([a-f0-9]{64})\n/.exec(bytes.toString());
  if (!match || bytes.toString() !== launcher(match[1])) fail('The project runtime reference is unowned or edited; it was preserved.');
  return { id: match[1], bytes, dev: stat.dev, ino: stat.ino };
}
export function runtimeSkill(source, id) {
  const text = source.toString('utf8').replace(/^If `rivet` is not on `PATH`.*$/m, '');
  return Buffer.from(text + `\n## Pinned project runtime\n\nFor EVERY command shown as \`rivet\` above, use \`node <absolute-project-root>/.rivet.cjs\` followed by the same arguments. Discover the project root yourself; do not ask the user for it. This project pins Rivet source ${id}; the runtime and resolved dependency inventory are private to this machine. Use the project reference even when a global Rivet is available. Do not use a floating npx fallback.\n`);
}
