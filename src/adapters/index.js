/** Реестр адаптеров харнессов. */
import * as dsh from './dsh.js'
import * as claudeCode from './claude-code.js'
import * as codex from './codex.js'

export const adapters = [dsh, claudeCode, codex]

export function detectAdapters() {
  return adapters.map((adapter) => ({
    id: adapter.id,
    label: adapter.label,
    detected: safeDetect(adapter),
  }))
}

function safeDetect(adapter) {
  try {
    return adapter.detect()
  } catch {
    return false
  }
}

export function getAdapter(id) {
  return adapters.find((adapter) => adapter.id === id) ?? null
}

/** Все сессии всех найденных харнессов. */
export function listAllSessions() {
  const result = []
  for (const adapter of adapters) {
    if (!safeDetect(adapter)) continue
    try {
      for (const session of adapter.listSessions()) result.push({ ...session, adapter: adapter.id })
    } catch {
      /* харнесс может быть неполным */
    }
  }
  result.sort((a, b) => b.lastTime - a.lastTime)
  return result
}
