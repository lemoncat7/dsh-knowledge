import type { WikiProviderBridge } from './provider-bridge.js'

export interface WikiChangeLogger { warn(message: string): void }
export interface WikiChangeCheckSummary { checked: string[]; skipped: string[]; failed: string[] }

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }

/**
 * One scheduled round of read-only change detection. Only connected bases are checked, a base with
 * a running ingest job is skipped for this round, and every failure is logged instead of thrown.
 */
export async function runWikiChangeCheck(wiki: WikiProviderBridge, logger: WikiChangeLogger): Promise<WikiChangeCheckSummary> {
  const summary: WikiChangeCheckSummary = { checked: [], skipped: [], failed: [] }
  let bases: { kbId: string }[]
  try { bases = wiki.list() } catch (error) { logger.warn(`dsh-knowledge: wiki change check unavailable: ${messageOf(error)}`); return summary }
  for (const { kbId } of bases) {
    try {
      const state = wiki.connectionStatus(kbId).state
      if (state !== 'ready' && state !== 'partial') continue
      if (wiki.ingest.running(kbId)) { summary.skipped.push(kbId); continue }
      await wiki.ingest.changes(kbId)
      summary.checked.push(kbId)
    } catch (error) {
      summary.failed.push(kbId)
      logger.warn(`dsh-knowledge: wiki change check failed for ${kbId}: ${messageOf(error)}`)
    }
  }
  return summary
}

/** Interval driver: a slow round never overlaps itself and failures stay inside this watcher. */
export function startWikiChangeWatch(run: () => Promise<unknown>, everyMs: number): () => void {
  if (!(everyMs > 0)) return () => {}
  let busy = false
  const timer = setInterval(() => {
    if (busy) return
    busy = true
    void Promise.resolve().then(run).catch(() => {}).finally(() => { busy = false })
  }, everyMs)
  const handle = timer as unknown as { unref?: () => void }
  handle.unref?.()
  return () => clearInterval(timer)
}
