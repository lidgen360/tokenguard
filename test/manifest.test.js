import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('manifest: запись артефакта, чтение и пометка удаления', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccliner-manifest-'))
  process.env.CCLINER_HOME = home
  const manifest = await import('../src/util/manifest.js')

  const file = path.join(home, 'artifact.txt')
  fs.writeFileSync(file, 'hello')
  const record = manifest.recordArtifact({ kind: 'digest', action: 'create', path: file, meta: { session: 'x' } })
  assert.ok(record.id)
  assert.equal(manifest.sizeOf(file), 5)

  const rows = manifest.readManifest()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'digest')

  manifest.markDeleted([record.id])
  assert.equal(manifest.readManifest().length, 0)
})

test('manifest: битые строки не ломают чтение', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccliner-manifest-'))
  process.env.CCLINER_HOME = home
  const manifest = await import('../src/util/manifest.js')
  fs.appendFileSync(manifest.manifestFile(), 'not-json\n{"id":"1","ts":1,"kind":"digest","action":"create","path":null,"meta":{}}\n')
  const rows = manifest.readManifest()
  assert.equal(rows.length, 1)
})
