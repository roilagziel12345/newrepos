const test = require('node:test');
const assert = require('node:assert/strict');
const chunk = require('lodash/chunk');

test('Node example works', () => assert.deepEqual(chunk([1, 2, 3], 2), [[1, 2], [3]]));
