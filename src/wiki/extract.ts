import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
export interface WikiExtractResult { quality: 'full' | 'partial' | 'none' | 'failed'; chars: number; parser?: string; error?: string | null; preview?: string }
export async function extractWikiFile(python: string, src: string, dst: string | undefined, signal: AbortSignal): Promise<WikiExtractResult> {
  const script = fileURLToPath(new URL('../../scripts/extract-one.py', import.meta.url))
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, signal })
    let output = '', errors = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('WIKI_EXTRACT_TIMEOUT')) }, 120_000)
    child.stdout.on('data', bytes => { output += bytes.toString(); if (output.length > 100_000) { child.kill(); reject(new Error('WIKI_EXTRACT_OUTPUT_LIMIT')) } })
    child.stderr.on('data', bytes => { if (errors.length < 4000) errors += bytes.toString() })
    child.once('error', err => { clearTimeout(timer); reject(new Error(`EXTRACTOR_UNAVAILABLE:${err.message}`)) })
    child.once('close', code => {
      clearTimeout(timer)
      if (code !== 0) { reject(new Error(`WIKI_EXTRACT_FAILED:${errors}`)); return }
      try {
        const value = JSON.parse(output) as WikiExtractResult
        if (!['full', 'partial', 'none', 'failed'].includes(value.quality) || !Number.isSafeInteger(value.chars)) throw new Error('invalid extraction response')
        resolve(value)
      } catch (e) { reject(e) }
    })
    child.stdin.end(JSON.stringify({ src, ...(dst ? { dst } : { preview: true }) }))
  })
}
