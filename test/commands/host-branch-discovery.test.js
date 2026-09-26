import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverGit } from '../../src/discovery/git.js';

test('configured host branch freshness overrides a different remote HEAD and rejects malformed counts', async () => {
  for (const output of ['0 2', 'malformed', '0 0']) {
    const calls = [];
    const result = await discoverGit('/project', { defaultBranch: 'develop', runner: async (_cmd, args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return { code: 0, stdout: '/project\n' };
      if (args.at(-1) === 'HEAD') return { code: 0, stdout: 'develop\n' };
      if (args.at(-1) === 'refs/remotes/origin/HEAD') return { code: 0, stdout: 'origin/main\n' };
      if (args[0] === 'worktree') return { code: 0, stdout: 'worktree /project\0\0' };
      if (args[0] === 'rev-list') return { code: 0, stdout: output };
      return { code: 0, stdout: '' };
    } });
    assert.equal(result.defaultBranch, 'develop');
    assert.equal(result.baseFreshness, output === '0 2' ? 'behind' : output === '0 0' ? 'fresh' : 'not_checked');
    assert.deepEqual(calls.find(args => args[0] === 'rev-list'), ['rev-list', '--left-right', '--count', 'develop...refs/remotes/origin/develop']);
  }
});
