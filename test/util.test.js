import test from 'node:test'
import assert from 'node:assert/strict'
import { estimateTokens, jsonTokens } from '../src/util/tokens.js'
import { parseMarkdown, normalizeText, isLocalLink, slugifyHeading } from '../src/util/md.js'
import { humanBytes } from '../src/util/files.js'

test('estimateTokens: кириллица дороже латиницы и пустое = 0', () => {
  assert.equal(estimateTokens(''), 0)
  assert.ok(estimateTokens('привет мир') > estimateTokens('hello world'))
  assert.ok(jsonTokens({ a: 1 }) > 0)
})

test('parseMarkdown: заголовки, ссылки, абзацы, игнор кода', () => {
  const md = parseMarkdown([
    '# Заголовок',
    '',
    'Первый абзац.',
    '',
    '- пункт списка',
    '',
    '## Раздел',
    '',
    '[ссылка](docs/a.md#x) и [внешняя](https://example.com)',
    '',
    '```js',
    '# это не заголовок',
    '```',
  ].join('\n'))
  assert.equal(md.title, 'Заголовок')
  assert.equal(md.headings.length, 2)
  assert.equal(md.links[0].href, 'docs/a.md#x')
  assert.ok(md.paragraphs.includes('Первый абзац.'))
  assert.ok(!md.headings.some((heading) => heading.text.includes('не заголовок')))
})

test('нормализация и ссылки', () => {
  assert.equal(normalizeText('  Привет, Ёж! '), 'привет еж')
  assert.equal(slugifyHeading('Как это работает?'), 'как-это-работает')
  assert.equal(isLocalLink('docs/a.md'), true)
  assert.equal(isLocalLink('https://x.y'), false)
  assert.equal(isLocalLink('#anchor'), false)
})

test('humanBytes', () => {
  assert.equal(humanBytes(0), '0 Б')
  assert.match(humanBytes(1024), /1/)
})
