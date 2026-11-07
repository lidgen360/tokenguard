import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compressBuffer, readCompressedText } from '../src/util/zstd.js'
import * as dsh from '../src/adapters/dsh.js'

function makeSession(root, id, title, userTexts) {
  const dir = path.join(root, '--test--', id)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  const now = Date.now()
  const events = [
    { type: 'session', version: 4, id, createdAt: now - 1000, cwd: '/tmp/x', origin: 'user' },
    { type: 'session/title', seq: 0, time: now, data: { title, messageSeqs: [1], source: { kind: 'fallback' } } },
    ...userTexts.map((text, index) => ({
      type: 'user/message',
      seq: index + 1,
      time: now,
      data: { content: [{ type: 'text', text }] },
    })),
    {
      type: 'user/message',
      seq: 80,
      time: now,
      data: { content: [{ type: 'text', text: 'The user changed the approval policy from "ask" to "never".' }] },
    },
    { type: 'tool/call', seq: 81, time: now, data: { name: 'write', arguments: { file_path: '/tmp/x/a.txt' } } },
    {
      type: 'assistant/message',
      seq: 82,
      time: now,
      data: {
        message: { content: [{ type: 'text', text: 'готово' }] },
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100 },
      },
    },
  ]
  fs.writeFileSync(file, compressBuffer(Buffer.from(events.map((event) => JSON.stringify(event)).join('\n') + '\n')))
  return { dir, file }
}

test('dsh: listSessions читает заголовок и счётчики', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccliner-dsh-'))
  makeSession(root, 'session-test-1', 'Тестовый чат', ['привет'])
  const sessions = dsh.listSessions({ root })
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].title, 'Тестовый чат')
  assert.equal(sessions[0].userCount, 2)
  assert.equal(sessions[0].promptTokens, 110)
  assert.equal(sessions[0].toolCount, 1)
})

test('dsh: renameSession добавляет session/title с source user', () => {
  process.env.CCLINER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccliner-home-'))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccliner-dsh-'))
  makeSession(root, 'session-test-2', 'Старое имя', ['привет'])
  const session = dsh.listSessions({ root })[0]
  const result = dsh.renameSession(session, 'Новое имя', { force: true })
  assert.equal(result.title, 'Новое имя')
  assert.ok(result.backup.includes('session-'))
  const text = readCompressedText(session.file)
  assert.ok(text.includes('"kind":"user"'))
  assert.ok(text.includes('Новое имя'))
  const renamed = dsh.listSessions({ root })[0]
  assert.equal(renamed.title, 'Новое имя')
})

test('dsh: renameSession не даёт пустое название', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccliner-dsh-'))
  makeSession(root, 'session-test-3', 'Имя', ['x'])
  const session = dsh.listSessions({ root })[0]
  assert.throws(() => dsh.renameSession(session, '   ', { force: true }), /пустое название/)
})

test('dsh: extractDigest фильтрует служебные сообщения и собирает файлы', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccliner-dsh-'))
  makeSession(root, 'session-test-4', 'Чат', ['сделай штуку', 'и ещё одну'])
  const session = dsh.listSessions({ root })[0]
  const digest = dsh.extractDigest(session)
  assert.equal(digest.userRequests.length, 2)
  assert.ok(digest.filesTouched.includes('/tmp/x/a.txt'))
  assert.equal(digest.assistantTexts.at(-1).text, 'готово')
})
