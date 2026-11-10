#!/usr/bin/env node
/**
 * DSH UserPromptSubmit hook entry point.
 * Reads the bridge payload from stdin and prints protocol JSON on drift only.
 */
import { readFileSync } from 'node:fs'
import { buildContextContext, buildDriftContext, hookOutput } from '../src/hooks/dsh-user-prompt.js'

let payload = {}
try {
  payload = JSON.parse(readFileSync(0, 'utf8') || '{}')
} catch {
  process.exit(0)
}
const parts = []
const drift = buildDriftContext(payload)
if (drift) parts.push(drift)
const context = buildContextContext(payload)
if (context) parts.push(context)
if (parts.length > 0) process.stdout.write(JSON.stringify(hookOutput(parts.join('\n\n'))))
process.exit(0)
