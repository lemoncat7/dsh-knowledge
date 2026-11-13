import { dayOf, fail, validDay } from './domain.js'

function integer(query, key, fallback, min, max) {
  const raw = query.get(key)
  const value = raw === null ? fallback : /^\d+$/.test(raw) ? Number(raw) : NaN
  if (!Number.isSafeInteger(value) || value < min || value > max) throw fail(`日报 ${key} 参数无效`)
  return value
}

/** Bounded read surfaces: never return collection settings, raw conversations or model routes. */
export function reportReadRoutes(store, method, path, query) {
  if (method !== 'GET' || !['/reports', '/report'].includes(path)) return undefined
  if (path === '/reports') {
    const limit = integer(query, 'limit', 20, 1, 50), offset = integer(query, 'offset', 0, 0, 100000)
    const from = query.has('from') ? validDay(query.get('from')) : null
    const to = query.has('to') ? validDay(query.get('to')) : null
    if (from && to && from > to) throw fail('开始日期不能晚于结束日期')
    const search = query.get('query') || ''
    if (search.length > 200) throw fail('日报搜索词过长')
    const clauses = [], args = []
    if (from) { clauses.push('day>=?'); args.push(from) }
    if (to) { clauses.push('day<=?'); args.push(to) }
    if (search) { clauses.push("instr(lower(json_extract(body,'$.markdown')),lower(?))>0"); args.push(search) }
    const where = clauses.length ? ' WHERE '+clauses.join(' AND ') : ''
    const total = store.db.prepare('SELECT count(*) AS n FROM reports'+where).get(...args).n
    const items = store.db.prepare(`SELECT day,revision,coalesce(json_extract(body,'$.updated'),0) AS updated,
      coalesce(json_extract(body,'$.edited'),0) AS edited,length(json_extract(body,'$.markdown')) AS chars
      FROM reports${where} ORDER BY day DESC LIMIT ? OFFSET ?`).all(...args, limit, offset).map(r=>({...r,edited:!!r.edited}))
    return { items, total, offset, limit, nextOffset:offset+items.length<total?offset+items.length:null,
      today:dayOf(Date.now(),store.config().timezone),timezone:store.config().timezone }
  }
  const day = validDay(query.get('day')), offset = integer(query, 'offset', 0, 0, 100000)
  const limit = integer(query, 'limit', 6000, 1, 12000)
  const revision = query.has('revision') ? integer(query, 'revision', 0, 0, Number.MAX_SAFE_INTEGER) : null
  if (offset > 0 && revision === null) throw fail('续读日报请携带上一页的 revision，避免混合不同版本')
  const row = store.db.prepare('SELECT body,revision FROM reports WHERE day=?').get(day)
  if (!row) {
    if (offset > 0 || revision !== null) throw fail('日报已不存在，请重新查询',409)
    return {day,exists:false,status:'not_generated',markdown:'',revision:0,totalChars:0,offset:0,nextOffset:null}
  }
  if (revision !== null && row.revision !== revision) throw fail('日报已更新，请从第一页重新读取',409)
  const value = JSON.parse(row.body), body = value.markdown
  if (offset > body.length) throw fail('日报 offset 超出正文范围')
  let end = Math.min(body.length,offset+limit)
  if (end < body.length && /[\uD800-\uDBFF]/.test(body[end-1])) end++
  return {day,exists:true,revision:row.revision,updated:value.updated??0,edited:!!value.edited,
    markdown:body.slice(offset,end),totalChars:body.length,offset,nextOffset:end<body.length?end:null}
}
