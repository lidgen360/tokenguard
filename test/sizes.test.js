import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTokenSize } from '../src/util/sizes.js'

test('parseTokenSize: K/M/B и числа', () => {
  assert.equal(parseTokenSize('20M'), 20_000_000)
  assert.equal(parseTokenSize('1.5B'), 1_500_000_000)
  assert.equal(parseTokenSize('500k'), 500_000)
  assert.equal(parseTokenSize('12345'), 12345)
  assert.equal(parseTokenSize(7_000_000), 7_000_000)
})

test('parseTokenSize: мусор даёт null', () => {
  assert.equal(parseTokenSize('abc'), null)
  assert.equal(parseTokenSize(''), null)
  assert.equal(parseTokenSize('20M extra'), null)
})
