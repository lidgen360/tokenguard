#!/usr/bin/env node
import { main } from '../src/cli.js'

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code ?? 0
}).catch((error) => {
  console.error('tokenguard:', error?.message ?? error)
  if (process.env.CCLINER_DEBUG) console.error(error?.stack)
  process.exitCode = 1
})
