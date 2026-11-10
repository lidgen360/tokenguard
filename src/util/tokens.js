/**
 * Грубая оценка токенов без токенизатора: латиница/JSON ≈ 4 символа на токен,
 * кириллица ≈ 2,5. Достаточно для сравнения «до/после», не для биллинга.
 */
export function estimateTokens(text) {
  if (!text) return 0
  let latin = 0
  let cyrillic = 0
  let other = 0
  for (const char of String(text)) {
    const code = char.codePointAt(0)
    if (code < 128) latin += 1
    else if (code >= 0x0400 && code <= 0x04ff) cyrillic += 1
    else other += 1
  }
  return Math.ceil(latin / 4 + cyrillic / 2.5 + other / 3)
}

export function jsonTokens(value) {
  try {
    return estimateTokens(JSON.stringify(value))
  } catch {
    return 0
  }
}

/** Оценка размера JSON-схемы инструментов в токенах (то, что уходит в контекст). */
export function toolsTokens(tools) {
  return jsonTokens(
    (tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    })),
  )
}

/** Человекочитаемый формат количества токенов: 12.3K, 1.2M. */
export function humanTokens(value) {
  const number = Number(value) || 0
  if (number >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(2)}B`
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`
  if (number >= 1_000) return `${(number / 1_000).toFixed(0)}K`
  return String(number)
}

/** Разобрать порог вида 350k, 1.2M, 250000; null — если значение некорректно. */
export function parseTokenCount(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value))
  const text = String(value).trim().toLowerCase().replace(/[\s_]/g, '')
  const match = text.match(/^([0-9]*\.?[0-9]+)([kmb])?$/)
  if (!match) return fallback
  const multiplier = { k: 1_000, m: 1_000_000, b: 1_000_000_000 }[match[2]] ?? 1
  return Math.round(Number(match[1]) * multiplier)
}
