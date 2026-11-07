/** Детектор смены темы в диалоге: лексическая близость соседних сообщений. */
import { normalizeText } from './md.js'

const STOPWORDS = new Set([
  'это', 'что', 'как', 'где', 'когда', 'если', 'или', 'для', 'надо', 'нужно', 'можно',
  'есть', 'было', 'будет', 'быть', 'все', 'всё', 'еще', 'ещё', 'так', 'там', 'тут',
  'мне', 'меня', 'нам', 'нас', 'тебе', 'тебя', 'вам', 'вас', 'его', 'её', 'ее', 'их',
  'этот', 'эта', 'эти', 'тот', 'та', 'те', 'наш', 'ваш', 'мой', 'свой', 'сам',
  'привет', 'давай', 'давай-ка', 'спасибо', 'пожалуйста', 'можешь', 'можем', 'сделай',
  'сделать', 'дальше', 'теперь', 'потом', 'просто', 'очень', 'также', 'тоже',
  'the', 'and', 'for', 'that', 'this', 'with', 'you', 'are', 'was', 'have',
])

/** Грубое усечение русских окончаний: процессы/процессов/процесс → процесс. */
const ENDINGS = ['иями', 'ями', 'ами', 'ого', 'ому', 'ыми', 'ими', 'ов', 'ев', 'ий', 'ый', 'ой',
  'ая', 'ое', 'ые', 'ие', 'ом', 'ем', 'ах', 'ях', 'ам', 'ям', 'ую', 'юю', 'у', 'ю', 'а', 'я', 'ы', 'и', 'е', 'о', 'ь']

export function stemWord(word) {
  for (const ending of ENDINGS) {
    if (word.length - ending.length >= 4 && word.endsWith(ending)) return word.slice(0, -ending.length)
  }
  return word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word
}

/** Значимые слова сообщения (нормализованные + усечённые окончания). */
export function topicTokens(text) {
  return normalizeText(text)
    .split(' ')
    .map((word) => word.trim())
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word))
    .map((word) => stemWord(word))
    .filter((word) => word.length >= 3)
}

export function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const item of a) if (b.has(item)) intersection += 1
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

/** Частые значимые слова сегмента. */
export function topKeywords(texts, limit = 6) {
  const stats = new Map() // stem → { count, display }
  for (const text of texts) {
    const seen = new Set()
    for (const original of normalizeText(text).split(' ')) {
      const word = original.trim()
      if (word.length < 3 || STOPWORDS.has(word)) continue
      const stem = stemWord(word)
      if (stem.length < 3 || seen.has(stem)) continue
      seen.add(stem)
      const entry = stats.get(stem) ?? { count: 0, display: word }
      entry.count += 1
      if (word.length < entry.display.length) entry.display = word // короткая форма читабельнее
      stats.set(stem, entry)
    }
  }
  return [...stats.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[1].display.localeCompare(b[1].display))
    .slice(0, limit)
    .map(([stem, entry]) => ({ word: entry.display, stem, count: entry.count }))
}

function segmentOf(messages, from, to) {
  return {
    from,
    to,
    keywords: topKeywords(messages.slice(from, to).map((message) => message.text)),
  }
}

/**
 * Найти смены темы.
 * @param {Array<{time?: number, text: string}>} messages — сообщения пользователя
 */
export function analyzeTopicDrift(messages, options = {}) {
  const windowSize = Number(options.windowSize ?? 4)
  const threshold = Number(options.threshold ?? 0.18)
  const minTokens = Number(options.minTokens ?? 4)
  const minGap = Number(options.minGap ?? 4)
  const sets = messages.map((message) => new Set(topicTokens(message.text)))
  const rawShifts = []
  for (let index = windowSize; index < messages.length; index += 1) {
    const current = sets[index]
    if (current.size < minTokens) continue
    const previous = sets.slice(Math.max(0, index - windowSize), index)
    const similarity = Math.max(0, ...previous.map((set) => jaccard(set, current)))
    if (similarity < threshold) {
      rawShifts.push({
        index,
        similarity: Number(similarity.toFixed(3)),
        time: messages[index].time ?? 0,
        keywords: topKeywords([messages[index].text], 4).map((item) => item.word),
      })
    }
  }
  // Одна смена темы на несколько сообщений: держим минимальный зазор между сменами.
  const shifts = []
  for (const shift of rawShifts) {
    const last = shifts[shifts.length - 1]
    if (last && shift.index - last.index < minGap) continue
    shifts.push(shift)
  }
  const segments = []
  let start = 0
  for (const shift of shifts) {
    segments.push(segmentOf(messages, start, shift.index))
    start = shift.index
  }
  segments.push(segmentOf(messages, start, messages.length))
  return { shifts, segments, threshold, windowSize, total: messages.length }
}

/** Первые/ключевые слова для подписи сегмента. */
export function segmentLabel(segment, limit = 3) {
  return segment.keywords.slice(0, limit).map((item) => item.word).join(' / ') || '(без слов)'
}
