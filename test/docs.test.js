import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkData, indexData } from '../src/commands/docs.js'

function makeDocs(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccliner-docs-'))
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  return root
}

test('docs check: ловит битые ссылки, конфликт значений и устаревшее «актуально на»', () => {
  const paragraph = 'Очень длинный абзац про архитектуру проекта, который повторяется в двух разных документах, чтобы проверка повторов абзацев сработала. ' + 'Дополнительный текст для длины. '.repeat(3)
  const root = makeDocs({
    'a.md': `# Документ А\n\n${paragraph}\n\nПорт API: SERVER_PORT=9090\n\nАктуально на 01.01.2020.\n\n[битая ссылка](missing.md)\n`,
    'b.md': `# Документ Б\n\n${paragraph}\n\nSERVER_PORT=9091\n`,
  })
  const result = checkData(root)
  const rules = new Set(result.findings.map((finding) => finding.rule))
  assert.ok(rules.has('broken-link'), 'должна быть битая ссылка')
  assert.ok(rules.has('conflicting-value'), 'должен быть конфликт SERVER_PORT')
  assert.ok(rules.has('stale-actual'), 'должна быть устаревшая дата')
  assert.ok(rules.has('duplicate-paragraph'), 'должен быть повтор абзаца')
  assert.ok(result.counts.high >= 1)
})

test('docs index: собирает документы и видит дубли названий', () => {
  const root = makeDocs({
    'a.md': '# Одинаковый заголовок\n\nТекст А.\n',
    'nested/b.md': '# Одинаковый заголовок\n\nТекст Б.\n',
    'README.md': '# Проект\n\nГлавный документ. [ссылка](a.md)\n',
  })
  const data = indexData(root)
  assert.equal(data.entries.length, 3)
  const duplicates = data.entries.filter((entry) => entry.duplicateTitle)
  assert.equal(duplicates.length, 2)
  const nested = data.entries.find((entry) => entry.relative.includes('nested'))
  assert.equal(nested.orphan, true)
  const readme = data.entries.find((entry) => entry.relative === 'README.md')
  assert.equal(readme.orphan, false)
})

test('docs check: игнорирует рантайм-каталоги', () => {
  const root = makeDocs({
    'api/data/runtime.md': '# Рантайм\n\n[битая](nope.md)\n',
    'docs/ok.md': '# Ок\n\nВсё хорошо.\n',
  })
  const result = checkData(root)
  assert.equal(result.docs, 1)
  assert.equal(result.findings.length, 0)
})
