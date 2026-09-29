import test from 'node:test';
import assert from 'node:assert/strict';
import { exactPercentageOf } from '../../dist/domain/decimal.js';

test('exact percentages preserve finite results without reducing any significant digits', () => {
  for (const [used, limit, expected] of [
    ['62000', '2000000', '3.1'], ['1', '128', '0.78125'], ['1', '40', '2.5'],
    ['9007199254740993.123456789', '18014398509481986.246913578', '50'],
    ['1e-20', '100', '0.00000000000000000001'],
    ['99.99999999999999999999', '100', '99.99999999999999999999'],
    ['0', '123.456', '0'], ['100', '100', '100'], ['105', '100', '105'],
  ]) assert.equal(exactPercentageOf(used, limit), expected);
});

test('nonterminating and unsupported percentages remain absent rather than becoming rounded values', () => {
  for (const [used, limit] of [['1', '3'], ['1', '6'], ['100', '0'], ['1', (2n ** 800n).toString()], ['9'.repeat(256), '1']]) {
    assert.equal(exactPercentageOf(used, limit), null);
  }
  for (const used of ['-1', 'Infinity', '1e999']) assert.throws(() => exactPercentageOf(used, '100'));
});
