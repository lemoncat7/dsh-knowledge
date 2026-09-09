import { assertKnowledgeBrowserRequest } from '../api.js'
import type { RuntimeContextLike } from '../runtime.js'
import type { WritebackQueue } from './queue.js'

/** Authenticated long polling: one notification channel per page, no job content. */
export function registerWritebackLive(ctx: RuntimeContextLike, queue?: WritebackQueue): (() => void) | undefined {
  const waiting = new Set<(shutdown?: boolean) => void>()
  const notify = (): void => { for (const check of [...waiting]) check() }
  const unsubscribe = queue?.subscribe(notify)
  // Also notice writes from another process using the same SQLite outbox.
  const timer = setInterval(notify, 2000)
  timer.unref?.()
  const unregister = ctx.webServer?.register({
    kind: 'exact', path: '/knowledge-control/v1/writeback-changes',
    handler(req, res) {
      try {
        const client = req.headers['x-dsh-knowledge-client']
        assertKnowledgeBrowserRequest(req, client === 'conversation-web' ? 'conversation-web' : 'management-web')
        if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }).end(); return }
        if (!queue) { res.writeHead(409).end(); return }
        if (waiting.size >= 128) { res.writeHead(429).end(); return }
        const since = new URL(req.url ?? '/', 'http://localhost').searchParams.get('since')
        let finished = false
        let deadline: NodeJS.Timeout | undefined
        const cleanup = (): void => { waiting.delete(check); clearTimeout(deadline); res.off('close', disconnect) }
        const disconnect = (): void => { finished = true; cleanup() }
        const finish = (status: number, revision?: string): void => {
          if (finished) return
          finished = true
          cleanup()
          res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ revision }))
        }
        const check = (shutdown = false): void => {
          if (shutdown) { finish(503); return }
          const revision = queue.revision
          if (since !== revision) finish(200, revision)
        }
        waiting.add(check)
        res.on('close', disconnect)
        deadline = setTimeout(() => finish(200, queue.revision), 20000)
        check()
      } catch {
        res.writeHead(403, { 'cache-control': 'no-store' }).end()
      }
    },
  })
  return () => { clearInterval(timer); unsubscribe?.(); for (const check of [...waiting]) check(true); unregister?.() }
}
