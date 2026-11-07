import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeTopicDrift, jaccard, segmentLabel, topKeywords, topicTokens } from '../src/util/topics.js'

test('topicTokens: нормализует и отбрасывает стоп-слова', () => {
  const tokens = topicTokens('Покажи, пожалуйста, процессы в диспетчере')
  assert.ok(tokens.includes('процесс'))
  assert.ok(tokens.includes('диспетчер'))
  assert.ok(!tokens.includes('пожалуйста'))
})

test('jaccard: базовая мера пересечения', () => {
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1)
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['c', 'd'])), 0)
  assert.ok(Math.abs(jaccard(new Set(['a', 'b']), new Set(['b', 'c'])) - 1 / 3) < 1e-9)
})

test('analyzeTopicDrift: находит смену темы и строит сегменты', () => {
  const messages = [
    { text: 'покажи процессы мониторинга системы' },
    { text: 'запусти диспетчер процессов монитора' },
    { text: 'сколько оперативной памяти занимает монитор процессов' },
    { text: 'проверь процессор и память утилитой монитора' },
    { text: 'mcp токены lazy прокси контекст схемы инструментов' },
    { text: 'сделай lazy загрузку mcp инструментов для токенов' },
    { text: 'сколько токенов ест mcp контекст схемы' },
  ]
  const result = analyzeTopicDrift(messages, { windowSize: 3, threshold: 0.2 })
  assert.ok(result.shifts.length >= 1, 'должна быть хотя бы одна смена темы')
  assert.equal(result.segments.length, result.shifts.length + 1)
  const labels = result.segments.map((segment) => segmentLabel(segment))
  assert.ok(labels[0].length > 0)
})

test('analyzeTopicDrift: один сплошной топик не даёт смен', () => {
  const messages = Array.from({ length: 6 }, (_, index) => ({
    text: `проверка процесса монитора памяти и процессора шаг ${index}`,
  }))
  const result = analyzeTopicDrift(messages, { windowSize: 2, threshold: 0.2 })
  assert.equal(result.shifts.length, 0)
})

test('topKeywords: частотные слова', () => {
  const keywords = topKeywords(['mcp mcp токены', 'mcp lazy токены', 'контекст токены'])
  assert.equal(keywords[0].word, 'токены')
})
