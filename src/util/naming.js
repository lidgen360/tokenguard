/** Имена файлов/архивов: безопасные slug-и. */

export function sanitizeName(input) {
  return String(input ?? 'item')
    .toLowerCase()
    .replace(/[ё]/g, 'е')
    .replace(/[^a-z0-9а-я]+/giu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'item'
}

export function slugify(input) {
  return sanitizeName(input)
}
