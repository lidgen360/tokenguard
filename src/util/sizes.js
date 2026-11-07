/** Размеры в токенах: «20M», «1.5B», «500K». */
import { humanTokens } from './tokens.js'

const MULTIPLIERS = { K: 1e3, M: 1e6, B: 1e9 }

/** Разобрать «20M»/«1.5B»/«500k»/«12345» в число токенов. */
export function parseTokenSize(input) {
  if (typeof input === 'number') return input
  const text = String(input ?? '').trim().replace(/\s+/g, '')
  if (!text) return null
  const match = /^([0-9]+(?:[.,][0-9]+)?)([KkMmBb]?)$/.exec(text)
  if (!match) return null
  const value = Number(match[1].replace(',', '.'))
  if (!Number.isFinite(value)) return null
  const suffix = match[2].toUpperCase()
  return Math.round(value * (MULTIPLIERS[suffix] ?? 1))
}

export function formatTokenSize(value) {
  return humanTokens(value)
}
