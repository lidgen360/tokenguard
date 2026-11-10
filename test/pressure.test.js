import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_CONTEXT_THRESHOLD,
  COMPACTED_CONTEXT_ESTIMATE,
  pressureData,
  resolveContextThreshold,
} from '../src/commands/chats.js'
import { parseTokenCount } from '../src/util/tokens.js'

const adapter = { id: 'dsh', usageTimeline: (session) => session.timeline }

test('parseTokenCount: k/m/b, числа и мусор', () => {
  assert.equal(parseTokenCount('350k'), 350_000)
  assert.equal(parseTokenCount('1.2M'), 1_200_000)
  assert.equal(parseTokenCount('250000'), 250_000)
  assert.equal(parseTokenCount('2b'), 2_000_000_000)
  assert.equal(parseTokenCount(750), 750)
  assert.equal(parseTokenCount(' 400 K '), 400_000)
  assert.equal(parseTokenCount('abc', 42), 42)
  assert.equal(parseTokenCount('', 42), 42)
})

test('resolveContextThreshold: флаг → config → дефолт, мусор → null', () => {
  assert.equal(resolveContextThreshold({}, {}), DEFAULT_CONTEXT_THRESHOLD)
  assert.equal(resolveContextThreshold({ threshold: '300k' }, {}), 300_000)
  assert.equal(resolveContextThreshold({}, { contextThreshold: '1.2M' }), 1_200_000)
  assert.equal(resolveContextThreshold({ threshold: 250_000 }, { contextThreshold: '1M' }), 250_000)
  assert.equal(resolveContextThreshold({ threshold: 'много' }, {}), null)
})

test('pressureData: сортировка по последнему запросу, порог и экономия', () => {
  const sessions = [
    { id: 'a', title: 'A', promptTokens: 3_000, bytes: 10, timeline: [{ promptTokens: 100 }, { promptTokens: 500 }, { promptTokens: 1_000 }] },
    { id: 'b', title: 'B', promptTokens: 80_000, bytes: 20, timeline: [{ promptTokens: 400_000 }, { promptTokens: 420_000 }] },
    { id: 'c', title: 'C', promptTokens: 0, bytes: 0, timeline: [] },
  ]
  const rows = pressureData(sessions, { adapter, threshold: 350_000 })
  assert.deepEqual(rows.map((row) => row.id), ['b', 'a', 'c'])
  const [b, a, c] = rows
  assert.equal(b.last, 420_000)
  assert.equal(b.max, 420_000)
  assert.equal(b.over, true)
  assert.equal(b.requests, 2)
  assert.equal(b.savedPerRequest, 420_000 - COMPACTED_CONTEXT_ESTIMATE)
  assert.equal(b.savedPer100, (420_000 - COMPACTED_CONTEXT_ESTIMATE) * 100)
  assert.equal(a.over, false)
  assert.equal(a.last, 1_000)
  assert.equal(a.cumulative, 3_000)
  assert.equal(c.last, 0)
  assert.equal(c.over, false)
  assert.equal(c.requests, 0)
})

test('pressureData: пустой список и битый usageTimeline не ломают', () => {
  assert.deepEqual(pressureData([], { adapter }), [])
  const broken = { id: 'x', timeline: null }
  const rows = pressureData([broken], { adapter: { id: 'dsh', usageTimeline: () => { throw new Error('нет') } } })
  assert.equal(rows[0].last, 0)
  assert.equal(rows[0].over, false)
})
