/** projects: поиск мёртвых/незавершённых проектов и архивация. */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DATA_HOME, exists, isDir, humanBytes, ageDays, timeAgo, ensureDir, writeFile, readText } from '../util/files.js'
import { sanitizeName } from '../util/naming.js'
import { printTable, info, ok, warn, bold } from '../log.js'

export const VALUE_FLAGS = ['root', 'max-depth', 'limit']

const IGNORE = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.next', 'out', '.venv', 'venv',
  '__pycache__', '.tmp', '.cache', 'coverage', '.idea', 'vendor', 'target', '.gradle',
  'Library', 'Applications', 'Pictures', 'Movies', 'Music', 'Downloads', 'Documents',
])

const HELP = `${bold('ccliner projects')} — мёртвые и незавершённые проекты

  ccliner projects scan [--root <dir>] [--max-depth 3] [--json]
      Найти git-репозитории и оценить: последний коммит, незакоммиченное,
      TODO/FIXME, ветки → вердикт (активный / старый / спящий / мёртвый / незавершённый).

  ccliner projects archive <path> [--apply] [--delete]
      Архивация: git bundle + tar рабочего дерева + опись в ~/.ccliner/archive.
      С --apply проект перемещается в архив; --delete удаляет кэши в перенесённой копии.
`

export async function run(positional, flags) {
  const sub = positional[0]
  if (!sub || sub === 'scan') return scan(flags)
  if (sub === 'archive') return archiveCommand(positional[1], flags)
  console.log(HELP)
  return 0
}

function git(repo, args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 20_000,
    })
  } catch {
    return null
  }
}

function findRepos(root, maxDepth) {
  const repos = []
  const stack = [{ dir: path.resolve(root), depth: 0 }]
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()
    if (exists(path.join(dir, '.git'))) {
      repos.push(dir)
      continue
    }
    if (depth >= maxDepth) continue
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORE.has(entry.name) || entry.name.startsWith('.')) continue
      stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 })
    }
  }
  return repos.sort()
}

/** Метрики одного репозитория. */
export function inspectRepo(repo) {
  const relative = path.basename(repo)
  const lastCommitSeconds = Number((git(repo, ['log', '-1', '--format=%ct']) ?? '').trim())
  const lastCommit = lastCommitSeconds > 0 ? lastCommitSeconds * 1000 : 0
  const age = lastCommit > 0 ? ageDays(lastCommit) : Number.POSITIVE_INFINITY
  const status = git(repo, ['status', '--porcelain']) ?? ''
  const dirty = status.split('\n').filter((line) => line.trim()).length
  const untracked = status.split('\n').filter((line) => line.startsWith('??')).length
  const branch = (git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? '').trim() || '—'
  const branches = (git(repo, ['branch', '--format=%(refname:short)']) ?? '').split('\n').filter(Boolean).length
  const todoOutput = git(repo, ['grep', '-n', '-I', '-E', '\\b(TODO|FIXME)\\b', '--', '.']) ?? ''
  const todos = todoOutput.split('\n').filter((line) => line.trim()).length
  const hasReadme = exists(path.join(repo, 'README.md')) || exists(path.join(repo, 'readme.md'))
  let verdict = 'активный'
  if (lastCommit === 0) verdict = 'без коммитов'
  else if (age > 365) verdict = 'мёртвый'
  else if (age > 90) verdict = 'спящий'
  else if (dirty > 50 || (todos >= 20 && age > 30) || (!hasReadme && dirty > 0)) verdict = 'незавершённый'
  else if (age > 14) verdict = 'старый'
  return {
    path: repo,
    name: relative,
    branch,
    branches,
    lastCommit,
    ageDays: age,
    dirty,
    untracked,
    todos,
    hasReadme,
    verdict,
  }
}

export function scanData(flags = {}) {
  const root = path.resolve(flags.root ? String(flags.root) : process.cwd())
  const maxDepth = Number(flags['max-depth'] ?? 3)
  const repos = findRepos(root, Number.isFinite(maxDepth) ? maxDepth : 3).map(inspectRepo)
  repos.sort((a, b) => (a.lastCommit || 0) - (b.lastCommit || 0))
  return { root, repos }
}

async function scan(flags) {
  const { root, repos } = scanData(flags)
  if (flags.json) {
    console.log(JSON.stringify({ root, repos }, null, 2))
    return 0
  }
  if (repos.length === 0) {
    warn(`git-репозитории не найдены в ${root}`)
    return 0
  }
  const limit = Number(flags.limit ?? 50)
  printTable(
    ['Проект', 'Ветка', 'Последний коммит', 'Изменено', 'TODO', 'Вердикт'],
    repos.slice(0, limit).map((repo) => [
      repo.name,
      repo.branch,
      repo.lastCommit ? timeAgo(repo.lastCommit) : '—',
      `${repo.dirty} (${repo.untracked} новых)`,
      repo.todos,
      repo.verdict,
    ]),
  )
  const counts = repos.reduce((acc, repo) => {
    acc[repo.verdict] = (acc[repo.verdict] ?? 0) + 1
    return acc
  }, {})
  info(`корень: ${root}; репозиториев: ${repos.length}`)
  console.log(Object.entries(counts).map(([verdict, count]) => `  ${verdict}: ${count}`).join('\n'))
  return 0
}

function archiveCommand(repoPath, flags) {
  if (!repoPath) {
    warn('укажи путь к проекту: ccliner projects archive <path>')
    return 1
  }
  const repo = path.resolve(String(repoPath))
  if (!exists(repo) || !exists(path.join(repo, '.git'))) {
    warn(`${repo} — не git-репозиторий`)
    return 1
  }
  const metrics = inspectRepo(repo)
  const archiveRoot = path.join(DATA_HOME, 'archive', `${sanitizeName(metrics.name)}-${Date.now()}`)
  const bundleFile = path.join(archiveRoot, 'repo.bundle')
  const tarFile = path.join(archiveRoot, 'worktree.tar.gz')
  if (!flags.apply) {
    info('dry-run: будет создано')
    console.log(`  • ${bundleFile} — все ветки (git bundle)`)
    console.log(`  • ${tarFile} — рабочее дерево без node_modules/.venv`)
    console.log(`  • ${path.join(archiveRoot, 'ARCHIVE.md')} — опись`)
    info('добавь --apply, чтобы выполнить; --delete — удалить кэши в перенесённой копии')
    return 0
  }
  ensureDir(archiveRoot)
  const bundle = git(repo, ['bundle', 'create', bundleFile, '--all'])
  if (bundle === null) warn('git bundle не создан (проверь git)')
  const parent = path.dirname(repo)
  try {
    execFileSync('tar', [
      '-czf', tarFile,
      '-C', parent,
      '--exclude', `${metrics.name}/node_modules`,
      '--exclude', `${metrics.name}/.venv`,
      '--exclude', `${metrics.name}/venv`,
      '--exclude', `${metrics.name}/.next`,
      '--exclude', `${metrics.name}/dist`,
      '--exclude', `${metrics.name}/build`,
      metrics.name,
    ], { stdio: 'pipe' })
  } catch (error) {
    warn(`tar не удался: ${error.message}`)
  }
  const size = (file) => (exists(file) ? humanBytes(fs.statSync(file).size) : '—')
  const lines = [
    `# Архив проекта ${metrics.name}`,
    '',
    `Дата: ${new Date().toISOString()}`,
    `Исходный путь: \`${repo}\``,
    `Ветка: ${metrics.branch}, веток: ${metrics.branches}`,
    `Последний коммит: ${metrics.lastCommit ? new Date(metrics.lastCommit).toISOString() : '—'}`,
    `Изменённых файлов на момент архивации: ${metrics.dirty}`,
    `TODO/FIXME: ${metrics.todos}`,
    `Вердикт: ${metrics.verdict}`,
    '',
    `- \`repo.bundle\` (${size(bundleFile)}) — восстановление: \`git clone repo.bundle <dir>\``,
    `- \`worktree.tar.gz\` (${size(tarFile)}) — рабочее дерево без кэшей`,
    '',
    'Восстановление: `git clone repo.bundle project && tar -xzf worktree.tar.gz`',
  ]
  writeFile(path.join(archiveRoot, 'ARCHIVE.md'), `${lines.join('\n')}\n`)
  ok(`архив: ${archiveRoot}`)
  if (flags.delete) {
    const moved = path.join(archiveRoot, 'repo')
    fs.renameSync(repo, moved)
    for (const cache of ['node_modules', '.venv', 'venv', '.next', 'dist', 'build']) {
      fs.rmSync(path.join(moved, cache), { recursive: true, force: true })
    }
    ok(`проект перенесён в архив и очищен от кэшей: ${moved}`)
  } else {
    info('проект оставлен на месте; --delete перенесёт его в архив и уберёт кэши')
  }
  return 0
}
