/** Разбор Markdown: заголовки, параграфы, ссылки (без внешних зависимостей). */

/** Разобрать markdown-файл на структурные части. */
export function parseMarkdown(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const headings = []
  const links = []
  const paragraphs = []
  let buffer = []
  let inFence = false
  let fenceMarker = ''

  const flush = () => {
    const paragraph = buffer.join(' ').trim()
    if (paragraph) paragraphs.push(paragraph)
    buffer = []
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const fence = /^\s*(```+|~~~+)/.exec(line)
    if (fence) {
      if (!inFence) {
        inFence = true
        fenceMarker = fence[1][0]
      } else if (fence[1][0] === fenceMarker) {
        inFence = false
      }
      flush()
      continue
    }
    if (inFence) continue

    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading) {
      headings.push({ level: heading[1].length, text: heading[2].trim(), line: index + 1 })
      flush()
      continue
    }

    const linkPattern = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
    let match
    while ((match = linkPattern.exec(line)) !== null) {
      links.push({ text: match[1], href: match[2].replace(/^<|>$/g, ''), line: index + 1 })
    }

    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush()
      const item = line.replace(/^\s*([-*+]|\d+[.)])\s+/, '').trim()
      if (item) paragraphs.push(item)
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    buffer.push(line.trim())
  }
  flush()

  const title = headingText(headings, 1) || headingText(headings, 2) || ''
  return { title, headings, links, paragraphs }
}

function headingText(headings, level) {
  const found = headings.find((heading) => heading.level === level)
  return found ? found.text : ''
}

/** Нормализация для сравнения текстов. */
export function normalizeText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[ё]/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** GitHub-подобный якорь для проверки ссылок вида #anchor. */
export function slugifyHeading(text) {
  return String(text ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
}

/** Ссылка локальная (не http/mailto/#)? */
export function isLocalLink(href) {
  if (!href) return false
  if (/^(https?:|mailto:|tel:|#)/i.test(href)) return false
  // Абсолютные пути файловой системы проверяем, а сайтовые (/articles/...) — нет.
  if (href.startsWith('/')) return /^\/(Users|opt|tmp|var|etc|home)\//.test(href)
  return true
}
