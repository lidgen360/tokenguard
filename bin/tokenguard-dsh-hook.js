#!/usr/bin/env node
/**
 * DSH UserPromptSubmit hook entry point.
 * Reads the bridge payload from stdin and prints protocol JSON on drift only.
 */
import { readFileSync } from 'node:fs'
import { buildDriftContext, hookOutput } from '../src/hooks/dsh-user-prompt.js'

let payload = {}
try {
  payload = JSON.parse(readFileSync(0, 'utf8') || '{}')
} catch {
  process.exit(0)
}
const context = buildDriftContext(payload)
if (context) process.stdout.write(JSON.stringify(hookOutput(context)))
process.exit(0)
