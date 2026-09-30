import Schema from '@deepseek-ai/schemastery'
import { Store } from './store.js'
import { Worker } from './worker.js'
import { JournalService } from './service.js'
import { handler } from './http.js'
import { readFileSync } from 'node:fs'

export const name = 'knowledge-worklog'
export const inject = ['llm', 'connection']
export const Config = Schema.object({ databasePath: Schema.string().required().description('工作记录独立数据库路径') })
export function apply(ctx, config) {
  const store = new Store(config.databasePath), worker = new Worker(store, ctx.llm, undefined, () => ctx.logger.warn('worklog: 整理任务存储异常，请检查磁盘。'))
  const models = async () => Promise.all(ctx.llm.listProviders().map(async p => ({ id: p.id, name: p.name, models: (await ctx.llm.listModels(p.id)).map(m => ({ id: m.id, name: m.name })) })))
  const service = new JournalService(store, worker, models, config.current)
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    try {
      service.collect(agent.session, turn)
    } catch { ctx.logger.warn('worklog: 工作素材保存失败，请检查数据库磁盘状态。') }
  })
  ctx.inject(['webServer'], injected => {
    const remove = injected.webServer.register({ kind: 'prefix', path: '/worklog-control/v1', handler: handler(store, worker, request => ctx.connection.requestRejection(request), models, (...args) => service.browser(...args)) })
    injected.effect(() => remove, 'worklog.http')
    for (const [file, type] of [['workspace.js', 'text/javascript'], ['workspace.css', 'text/css']]) {
      const asset = readFileSync(new URL(`./worklog/${file}`, import.meta.url))
      const removeAsset = injected.webServer.register({ kind: 'exact', path: `/worklog-assets/${file}`, handler(req, res) {
        if (req.method !== 'GET') { res.writeHead(405).end(); return }
        // Static code/styles are public; all data APIs require Host authentication.
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' }).end(asset)
      } })
      injected.effect(() => removeAsset, `worklog.asset.${file}`)
    }
  })
  service.start()
  ctx.effect(() => async () => { await service.close(); store.close(); config.onDispose?.() }, 'worklog.close')
  return { dispatch: (...args) => service.serveCentral(...args), isRunning: () => !!worker.active }
}
