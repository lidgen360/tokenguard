import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compressBuffer } from '../src/util/zstd.js'
import { scanData, run, VALUE_FLAGS } from '../src/commands/attachments.js'

const HASH_REFERENCED = 'a1'.repeat(32)
const HASH_ORPHAN_OLD = 'b2'.repeat(32)
const HASH_ORPHAN_NEW = 'c3'.repeat(32)
const HASH_ORPHAN_EXTRA = 'd4'.repeat(32)

const DAY_MS = 86_400_000

function makeSessionText(hashes) {
  return hashes
    .map((hash) => JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: `вложение: ${hash}` }] } }))
    .join('\n') + '\n'
}

/** Временный каталог с объектами вложений и (опционально) одной сессией. */
function makeFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenguard-attachments-'))
  const objectsRoot = path.join(root, 'attachments', 'v1', 'objects')
  const sessionsRoot = path.join(root, 'sessions')
  fs.mkdirSync(sessionsRoot, { recursive: true })
  const files = new Map()
  for (const object of options.objects ?? []) {
    const file = path.join(objectsRoot, object.hash.slice(0, 2), object.hash)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, object.content ?? `attachment ${object.hash}`)
    const when = new Date(Date.now() - (object.ageDays ?? 1) * DAY_MS)
    fs.utimesSync(file, when, when)
    files.set(object.hash, file)
  }
  if (options.sessionText !== undefined) {
    const sessionFile = options.sessionFile ?? 'session.v4.jsonl'
    const file = path.join(sessionsRoot, 'project', 'session-1', sessionFile)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if (sessionFile.endsWith('.zstd')) fs.writeFileSync(file, compressBuffer(Buffer.from(options.sessionText, 'utf8')))
    else fs.writeFileSync(file, options.sessionText)
  }
  return { root, objectsRoot, sessionsRoot, files, dataHome: path.join(root, 'data') }
}

/** Подменить переменные окружения на время выполнения (в т.ч. асинхронного). */
function withEnv(env, fn) {
  const previous = new Map()
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key])
    process.env[key] = value
  }
  const restore = () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  try {
    const result = fn()
    if (result && typeof result.then === 'function') return result.finally(restore)
    restore()
    return result
  } catch (error) {
    restore()
    throw error
  }
}

/** Перехватить console.log и вернуть собранный текст. */
async function captureLog(fn) {
  const lines = []
  const original = console.log
  console.log = (...args) => lines.push(args.map((value) => String(value)).join(' '))
  try {
    await fn()
  } finally {
    console.log = original
  }
  return lines.join('\n')
}

test('attachments: VALUE_FLAGS содержит --older-than', () => {
  assert.ok(VALUE_FLAGS.includes('older-than'))
})

test('scanData: находит ссылки в сессиях и вычисляет осиротевшие объекты', () => {
  const fixture = makeFixture({
    objects: [
      { hash: HASH_REFERENCED, ageDays: 3, content: 'x'.repeat(10) },
      { hash: HASH_ORPHAN_OLD, ageDays: 40, content: 'y'.repeat(20) },
      { hash: HASH_ORPHAN_NEW, ageDays: 2, content: 'z'.repeat(5) },
    ],
    sessionText: makeSessionText([HASH_REFERENCED]),
  })
  const data = scanData({ attachmentsRoot: fixture.objectsRoot, sessionsRoot: fixture.sessionsRoot })

  assert.equal(data.attachmentsStatus, 'ok')
  assert.equal(data.sessionsStatus, 'ok')
  assert.equal(data.referencesKnown, true)
  assert.equal(data.sessions.files, 1)
  assert.equal(data.sessions.hashes, 1)
  assert.equal(data.summary.total, 3)
  assert.equal(data.summary.totalBytes, 35)
  assert.equal(data.summary.orphans, 2)

  const referenced = data.objects.find((object) => object.hash === HASH_REFERENCED)
  assert.equal(referenced.referenced, true)
  const orphanHashes = data.objects.filter((object) => object.referenced === false).map((object) => object.hash)
  assert.deepEqual(orphanHashes.sort(), [HASH_ORPHAN_OLD, HASH_ORPHAN_NEW].sort())
  assert.equal(data.summary.oldest.hash, HASH_ORPHAN_OLD)
  assert.ok(data.summary.oldest.ageDays > 39)
})

test('scanData: читает сжатые сессии session.v4.jsonl.zstd', () => {
  const fixture = makeFixture({
    objects: [{ hash: HASH_REFERENCED, ageDays: 1 }],
    sessionFile: 'session.v4.jsonl.zstd',
    sessionText: makeSessionText([HASH_REFERENCED]),
  })
  const data = scanData({ attachmentsRoot: fixture.objectsRoot, sessionsRoot: fixture.sessionsRoot })

  assert.equal(data.referencesKnown, true)
  assert.equal(data.objects[0].referenced, true)
  assert.equal(data.summary.orphans, 0)
})

test('scanData: отсутствующие каталоги — статус skip, без ошибок', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenguard-attachments-'))
  const data = scanData({
    attachmentsRoot: path.join(root, 'нет', 'objects'),
    sessionsRoot: path.join(root, 'нет-сессий'),
  })

  assert.equal(data.attachmentsStatus, 'skip')
  assert.equal(data.sessionsStatus, 'skip')
  assert.equal(data.referencesKnown, false)
  assert.equal(data.summary.total, 0)
  assert.equal(data.summary.orphans, null)
  assert.deepEqual(data.objects, [])
})

test('scanData: пустой каталог сессий не делает вложения осиротевшими', () => {
  const fixture = makeFixture({ objects: [{ hash: HASH_ORPHAN_OLD, ageDays: 30 }] })
  const data = scanData({ attachmentsRoot: fixture.objectsRoot, sessionsRoot: fixture.sessionsRoot })

  assert.equal(data.sessionsStatus, 'ok')
  assert.equal(data.sessions.files, 0)
  assert.equal(data.referencesKnown, false)
  assert.equal(data.summary.orphans, null)
})

test('run list --json: отдаёт сводку в JSON', async () => {
  const fixture = makeFixture({
    objects: [
      { hash: HASH_REFERENCED, ageDays: 1 },
      { hash: HASH_ORPHAN_OLD, ageDays: 40 },
    ],
    sessionText: makeSessionText([HASH_REFERENCED]),
  })
  const output = await withEnv({
    TOKENGUARD_ATTACHMENTS_ROOT: fixture.objectsRoot,
    TOKENGUARD_DSH_SESSIONS_ROOT: fixture.sessionsRoot,
  }, () => captureLog(() => run(['list'], { json: true })))

  const parsed = JSON.parse(output)
  assert.equal(parsed.summary.total, 2)
  assert.equal(parsed.summary.orphans, 1)
  assert.equal(parsed.summary.oldest.hash, HASH_ORPHAN_OLD)
  assert.equal(parsed.objects.find((object) => object.hash === HASH_ORPHAN_OLD).referenced, false)
})

test('clean: dry-run по умолчанию ничего не удаляет', async () => {
  const fixture = makeFixture({
    objects: [
      { hash: HASH_REFERENCED, ageDays: 40 },
      { hash: HASH_ORPHAN_OLD, ageDays: 40 },
      { hash: HASH_ORPHAN_NEW, ageDays: 2 },
    ],
    sessionText: makeSessionText([HASH_REFERENCED]),
  })
  const output = await withEnv({
    TOKENGUARD_ATTACHMENTS_ROOT: fixture.objectsRoot,
    TOKENGUARD_DSH_SESSIONS_ROOT: fixture.sessionsRoot,
    TOKENGUARD_HOME: fixture.dataHome,
  }, () => captureLog(() => run(['clean'], {})))

  assert.match(output, /dry-run/)
  for (const file of fixture.files.values()) assert.ok(fs.existsSync(file), 'dry-run не должен удалять файлы')
  assert.equal(fs.existsSync(path.join(fixture.dataHome, 'manifest.jsonl')), false, 'dry-run не пишет в реестр')
})

test('clean --apply: удаляет только осиротевшие старше порога и пишет артефакт', async () => {
  const fixture = makeFixture({
    objects: [
      { hash: HASH_REFERENCED, ageDays: 40 },
      { hash: HASH_ORPHAN_OLD, ageDays: 40 },
      { hash: HASH_ORPHAN_NEW, ageDays: 2 },
      { hash: HASH_ORPHAN_EXTRA, ageDays: 30 },
    ],
    sessionText: makeSessionText([HASH_REFERENCED]),
  })
  await withEnv({
    TOKENGUARD_ATTACHMENTS_ROOT: fixture.objectsRoot,
    TOKENGUARD_DSH_SESSIONS_ROOT: fixture.sessionsRoot,
    TOKENGUARD_HOME: fixture.dataHome,
  }, () => run(['clean'], { apply: true, 'older-than': '14' }))

  assert.equal(fs.existsSync(fixture.files.get(HASH_ORPHAN_OLD)), false, 'старый осиротевший удалён')
  assert.equal(fs.existsSync(fixture.files.get(HASH_ORPHAN_EXTRA)), false, 'старый осиротевший удалён')
  assert.equal(fs.existsSync(fixture.files.get(HASH_ORPHAN_NEW)), true, 'молодой осиротевший остался (порог 14 дней)')
  assert.equal(fs.existsSync(fixture.files.get(HASH_REFERENCED)), true, 'используемый объект не удаляется')

  assert.equal(fs.existsSync(path.join(fixture.objectsRoot, HASH_ORPHAN_OLD.slice(0, 2))), false, 'пустой каталог подчищен')
  assert.equal(fs.existsSync(path.join(fixture.objectsRoot, HASH_ORPHAN_NEW.slice(0, 2))), true, 'непустой каталог остался')

  const manifestFile = path.join(fixture.dataHome, 'manifest.jsonl')
  assert.ok(fs.existsSync(manifestFile), 'реестр артефактов должен быть записан')
  const records = fs.readFileSync(manifestFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const record = records.find((row) => row.kind === 'attachment-clean')
  assert.ok(record, 'должна быть запись kind attachment-clean')
  assert.equal(record.meta.deleted, 2)
  assert.ok(record.meta.freedBytes > 0)
  assert.equal(record.meta.olderThanDays, 14)
})

test('clean --apply: порог по умолчанию 14 дней', async () => {
  const fixture = makeFixture({
    objects: [
      { hash: HASH_ORPHAN_OLD, ageDays: 20 },
      { hash: HASH_ORPHAN_NEW, ageDays: 5 },
    ],
    sessionText: makeSessionText([]),
  })
  await withEnv({
    TOKENGUARD_ATTACHMENTS_ROOT: fixture.objectsRoot,
    TOKENGUARD_DSH_SESSIONS_ROOT: fixture.sessionsRoot,
    TOKENGUARD_HOME: fixture.dataHome,
  }, () => run(['clean'], { apply: true }))

  assert.equal(fs.existsSync(fixture.files.get(HASH_ORPHAN_OLD)), false)
  assert.equal(fs.existsSync(fixture.files.get(HASH_ORPHAN_NEW)), true)
})

test('clean: при неизвестных ссылках (нет сессий) ничего не удаляет', async () => {
  const fixture = makeFixture({
    objects: [{ hash: HASH_ORPHAN_OLD, ageDays: 90 }],
  })
  await withEnv({
    TOKENGUARD_ATTACHMENTS_ROOT: fixture.objectsRoot,
    TOKENGUARD_DSH_SESSIONS_ROOT: path.join(fixture.root, 'нет-сессий'),
    TOKENGUARD_HOME: fixture.dataHome,
  }, () => run(['clean'], { apply: true }))

  assert.ok(fs.existsSync(fixture.files.get(HASH_ORPHAN_OLD)), 'без сессий удалять нельзя')
  assert.equal(fs.existsSync(path.join(fixture.dataHome, 'manifest.jsonl')), false)
})

test('clean: некорректный --older-than — код возврата 1', async () => {
  const fixture = makeFixture({
    objects: [{ hash: HASH_ORPHAN_OLD, ageDays: 90 }],
    sessionText: makeSessionText([]),
  })
  const code = await withEnv({
    TOKENGUARD_ATTACHMENTS_ROOT: fixture.objectsRoot,
    TOKENGUARD_DSH_SESSIONS_ROOT: fixture.sessionsRoot,
    TOKENGUARD_HOME: fixture.dataHome,
  }, () => run(['clean'], { apply: true, 'older-than': 'вчера' }))

  assert.equal(code, 1)
  assert.ok(fs.existsSync(fixture.files.get(HASH_ORPHAN_OLD)))
})
