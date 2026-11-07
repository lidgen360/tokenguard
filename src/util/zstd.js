/** zstd: нативный zlib (Node ≥23.8) с фолбэком на CLI-утилиту zstd. */
import fs from 'node:fs'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'

export const hasNativeZstd = typeof zlib.zstdDecompressSync === 'function'
  && typeof zlib.zstdCompressSync === 'function'

function cli(args, input) {
  try {
    return execFileSync('zstd', args, { input, maxBuffer: 512 * 1024 * 1024 })
  } catch (error) {
    throw new Error(`не удалось распаковать/сжать zstd: ${error.message}. Установи Node ≥23.8 или утилиту zstd`)
  }
}

export function decompressBuffer(buffer) {
  if (hasNativeZstd) return zlib.zstdDecompressSync(buffer)
  return cli(['-dc'], buffer)
}

export function compressBuffer(buffer) {
  if (hasNativeZstd) return zlib.zstdCompressSync(buffer)
  return cli(['-q', '-19', '-c'], buffer)
}

/** Прочитать zstd-файл как UTF-8 текст. */
export function readCompressedText(file) {
  return decompressBuffer(fs.readFileSync(file)).toString('utf8')
}

/** Атомарно записать текст в zstd-файл. */
export function writeCompressedText(file, text) {
  const tmp = `${file}.tokenguard-tmp`
  fs.writeFileSync(tmp, compressBuffer(Buffer.from(text, 'utf8')))
  fs.renameSync(tmp, file)
}
