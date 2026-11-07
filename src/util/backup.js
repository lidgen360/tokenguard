/** Бэкап перед изменениями: tar.gz в ~/.tokenguard/backups (или CCLINER_HOME). */
import path from 'node:path'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { sanitizeName } from './naming.js'
import { DATA_HOME, ensureDir, exists, timestamp, expand } from './files.js'
import { recordArtifact } from './manifest.js'

export const BACKUP_DIR_NAME = 'backups'
export const BACKUP_DIR = path.join(DATA_HOME, BACKUP_DIR_NAME)

function backupDir() {
  return path.join(process.env.CCLINER_HOME || DATA_HOME, BACKUP_DIR_NAME)
}

function commonAncestor(paths) {
  const absolute = paths.map((p) => path.resolve(expand(p)))
  let base = path.dirname(absolute[0])
  for (const item of absolute) {
    while (!(item === base || item.startsWith(base + path.sep)) && base !== path.dirname(base)) {
      base = path.dirname(base)
    }
  }
  return base
}

/** Заархивировать набор путей. Возвращает путь к архиву. */
export function backupPaths(paths, label = 'backup') {
  const list = paths.filter((p) => exists(p)).map(expand)
  if (list.length === 0) throw new Error('backup: нечего архивировать')
  const dir = backupDir()
  ensureDir(dir)
  const base = commonAncestor(list)
  const out = path.join(dir, `${sanitizeName(label)}-${timestamp()}.tar.gz`)
  const relative = list.map((p) => path.relative(base, path.resolve(p)))
  execFileSync('tar', ['-czf', out, '-C', base, ...relative], { stdio: 'pipe' })
  recordArtifact({ kind: 'backup', action: 'backup', path: out, meta: { label, sources: list } })
  return out
}

export function listBackups() {
  try {
    return fs.readdirSync(backupDir()).filter((name) => name.endsWith('.tar.gz'))
  } catch {
    return []
  }
}
