import assert from 'node:assert/strict';
import { normalizeTags } from './src/solution.js';
assert.equal(typeof normalizeTags, 'function');
