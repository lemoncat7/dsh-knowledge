import { fail, validDay } from './domain.js'

function filters(query) {
  const where = [], args = []
  for (const [key, op] of [['day', '='], ['from', '>='], ['to', '<=']]) {
    const value = query.get(key)
    if (value) { where.push(`day ${op} ?`); args.push(validDay(value)) }
  }
  if (!where.length) throw fail('请选择日期或日期范围')
  if (query.get('from') && query.get('to') && query.get('from') > query.get('to')) throw fail('开始日期不能晚于结束日期')
  const project = query.get('project'), search = query.get('search') || '', state = query.get('state') || 'all'
  if (search.length > 256 || (project?.length || 0) > 4096) throw fail('筛选内容过长')
  if (!['all', 'included', 'excluded', 'unknown'].includes(state)) throw fail('来源状态无效')
  if (project) { where.push('project=?'); args.push(project) }
  if (state === 'included' || state === 'excluded') { where.push('excluded=?'); args.push(+(state === 'excluded')) }
  if (state === 'unknown') where.push("json_extract(body,'$.sessionId') IS NOT NULL AND json_extract(body,'$.captureKind') IS NULL")
  if (search) {
    where.push("(instr(lower(json_extract(body,'$.user')),lower(?))>0 OR instr(lower(json_extract(body,'$.answer')),lower(?))>0)")
    args.push(search, search)
  }
  return { clause: where.join(' AND '), args }
}
export function sourcePage(store, query) {
  const { clause, args } = filters(query)
  const page = Number(query.get('page') || 0), limit = 30
  if (!Number.isSafeInteger(page) || page < 0 || page > 100000) throw fail('页码无效')
  const sort = query.get('sort') || 'time'
  if (!['time', 'size'].includes(sort)) throw fail('排序无效')
  const chars = "length(coalesce(json_extract(body,'$.user'),''))+length(coalesce(json_extract(body,'$.answer'),''))"
  const total = store.db.prepare(`SELECT count(*) AS n FROM records WHERE ${clause}`).get(...args).n
  const rows = store.db.prepare(`SELECT id,day,project,excluded,substr(json_extract(body,'$.user'),1,120) AS preview,
    json_extract(body,'$.time') AS time, json_extract(body,'$.captureKind') AS captureKind, ${chars} AS chars
    FROM records WHERE ${clause} ORDER BY ${sort === 'size' ? 'chars DESC,' : ''} rowid DESC LIMIT ? OFFSET ?`).all(...args, limit, page * limit)
  return { records: rows, total, page, limit }
}
export function sourceDetail(store, id) {
  if (typeof id !== 'string' || id.length > 4096) throw fail('来源编号无效')
  const row = store.db.prepare('SELECT body,excluded FROM records WHERE id=?').get(id)
  if (!row) throw fail('来源不存在', 404)
  return { ...JSON.parse(row.body), excluded: !!row.excluded }
}
export function daySummary(store, day) {
  validDay(day)
  const report = store.report(day), latest = store.db.prepare('SELECT * FROM jobs WHERE day=? ORDER BY rowid DESC LIMIT 1').get(day)
  const stats = store.db.prepare(`SELECT count(*) AS total, coalesce(sum(excluded=0),0) AS included,
    coalesce(sum(CASE WHEN excluded=0 THEN length(body) ELSE 0 END),0) AS chars,
    coalesce(sum(excluded=0 AND id NOT IN (SELECT value FROM json_each(?))),0) AS pending
    FROM records WHERE day=?`).get(JSON.stringify(report.covered), day)
  return { day, report, ...stats,
    projects: store.db.prepare('SELECT DISTINCT project FROM records WHERE day=? ORDER BY project').all(day).map(r => r.project).filter(Boolean),
    historyCount: store.db.prepare('SELECT count(*) AS n FROM history WHERE day=?').get(day).n,
    job: latest ? { id: latest.id, status: latest.status, attempts: latest.attempts, error: JSON.parse(latest.body).error, progress: store.progress(latest) } : null }
}
export function excludeSources(store, data) {
  if (typeof data.excluded !== 'boolean' || !Array.isArray(data.ids) || !data.ids.length || data.ids.length > 1000 || data.ids.some(id => typeof id !== 'string' || id.length > 4096)) throw fail('请选择 1–1000 条来源')
  const ids = [...new Set(data.ids)]
  store.db.exec('BEGIN IMMEDIATE')
  try {
    const update = store.db.prepare('UPDATE records SET excluded=? WHERE id=?')
    for (const id of ids) if (!update.run(+data.excluded, id).changes) throw fail('部分来源已不存在，请刷新后重试', 409)
    store.db.exec('COMMIT'); return { updated: ids.length }
  } catch (e) { store.db.exec('ROLLBACK'); throw e }
}
export function sourceRoutes(store, method, path, data, query) {
  if (method === 'GET' && path === '/day-summary') return daySummary(store, query.get('day'))
  if (method === 'GET' && path === '/sources') return sourcePage(store, query)
  if (method === 'GET' && path === '/source') return sourceDetail(store, query.get('id'))
  if (method === 'GET' && path === '/history') {
    const day = validDay(query.get('day'))
    if (query.has('id')) {
      const row = store.db.prepare('SELECT body FROM history WHERE day=? AND id=?').get(day, Number(query.get('id')))
      if (!row) throw fail('历史版本不存在', 404)
      return JSON.parse(row.body)
    }
    return store.db.prepare("SELECT id,json_extract(body,'$.updated') AS updated,json_extract(body,'$.revision') AS revision FROM history WHERE day=? ORDER BY id DESC LIMIT 30").all(day)
  }
  if (method === 'POST' && path === '/exclude-batch') return excludeSources(store, data)
}
