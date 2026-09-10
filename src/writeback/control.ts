import { assertKnowledgeBrowserRequest } from '../api.js'
import type { RuntimeContextLike } from '../runtime.js'
import type { WritebackQueue } from './queue.js'

/** The outbox belongs to this DSH instance, never the remote knowledge provider. */
export function registerWritebackControl(ctx: RuntimeContextLike, queue: WritebackQueue | undefined): (() => void) | undefined {
  return ctx.webServer?.register({
    kind: 'exact', path: '/knowledge-control/v1/writeback-jobs',
    handler(req, res) {
      try {
        assertKnowledgeBrowserRequest(req, 'management-web')
        if (!queue) throw Object.assign(new Error('知识库回写已停用'), { status: 409 })
        const url = new URL(req.url ?? '/', 'http://localhost')
        let result: unknown
        if (req.method === 'GET') {
          const offset = Number(url.searchParams.get('offset') ?? 0)
          if (!Number.isSafeInteger(offset) || offset < 0) throw Object.assign(new Error('无效分页参数'), { status: 400 })
          const status = url.searchParams.get('status') || undefined
          if (status !== undefined && status !== 'failed') throw Object.assign(new Error('无效状态筛选'), { status: 400 })
          result = queue.list(url.searchParams.get('sessionId')?.trim(), offset, 50, status)
        } else if (req.method === 'POST') {
          const key = url.searchParams.get('sourceKey')
          const action = url.searchParams.get('action')
          if (!key || !['retry', 'cancel'].includes(action ?? '')) throw Object.assign(new Error('需要任务编号和有效操作'), { status: 400 })
          result = action === 'retry' ? queue.retry(key) : queue.cancel(key)
        } else { res.writeHead(405, { allow: 'GET, POST' }).end(); return }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(result))
      } catch (error) {
        const status = (error as { status?: number })?.status ?? 500
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify({ error: status < 500 && error instanceof Error ? error.message : '回写队列操作失败，请稍后重试' }))
      }
    },
  })
}
