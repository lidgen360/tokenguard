/**
 * Редакция секретов в тексте: пароли, токены, приватные ключи.
 * Используется при генерации конспектов, чтобы случайно не вынести секреты в файл.
 */

const RULES = [
  {
    name: 'private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: '[ПРИВАТНЫЙ КЛЮЧ СКРЫТ]',
  },
  { name: 'openai-key', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replace: 'sk-***СКРЫТО***' },
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: 'gh***_СКРЫТО' },
  { name: 'aws-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: 'AKIA***СКРЫТО***' },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, replace: '[JWT СКРЫТ]' },
  {
    name: 'key-value-secret',
    pattern: /((?:password|passwd|pwd|secret|token|api[_-]?key|apikey|authorization|bearer)\s*[:=]\s*["']?)([^\s"',;]{3,})/gi,
    replace: (_match, prefix) => `${prefix}***СКРЫТО***`,
  },
  {
    name: 'app-password',
    pattern: /\b([A-Za-z0-9]{4}[- ]){3}[A-Za-z0-9]{4}\b/g,
    replace: '****-****-****-****',
  },
  { name: 'email', pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g, replace: '[EMAIL СКРЫТ]' },
]

/** Замаскировать секреты. Возвращает { text, count, rules }. */
export function redactSecrets(text, options = {}) {
  const enabled = new Set(options.rules ?? RULES.map((rule) => rule.name))
  let result = String(text ?? '')
  let count = 0
  const applied = []
  for (const rule of RULES) {
    if (!enabled.has(rule.name)) continue
    const before = result
    result = result.replace(rule.pattern, rule.replace)
    if (result !== before) {
      count += 1
      applied.push(rule.name)
    }
  }
  return { text: result, count, rules: applied }
}

export function hasSecrets(text) {
  return redactSecrets(text).count > 0
}
