import { dayOf, fail, validDay, text } from './domain.js'

// Host web authentication remains mandatory. This header + Origin check is
// CSRF protection, not a substitute for the host's authentication boundary.
export function authorize(req) {
  if (req.headers['x-dsh-worklog-client'] !== 'workspace') throw fail('缺少工作记录客户端标识', 403)
  const origin = req.headers.origin, host = req.headers.host
  const desktop = origin === 'dsh-app://app' && /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host || '')
  if (desktop) return
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) throw fail('拒绝跨站请求', 403)
  if (origin) {
    let parsed
    try { parsed = new URL(origin) } catch { throw fail('来源无效', 403) }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host !== host) throw fail('拒绝跨站请求', 403)
  }
}
async function body(req) {
  const chunks = []; let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 256000) throw fail('内容过大', 413)
    chunks.push(Buffer.from(chunk))
  }
  try { const data = JSON.parse(Buffer.concat(chunks).toString()); if (!data || Array.isArray(data) || typeof data !== 'object') throw 0; return data } catch { throw fail('请求必须是 JSON 对象') }
}
export function handler(store, worker, authenticate = () => 401, models = async () => [], dispatch) {
  return async (req, res) => {
    try {
      authorize(req)
      // Desktop's exact custom origin was checked above. Adapt only its
      // transport origin; the official Host cookie verifier still runs.
      const request = req.headers.origin === 'dsh-app://app'
        ? { headers: { ...req.headers, origin: `http://${req.headers.host}`, 'sec-fetch-site': 'same-origin' } }
        : req
      const rejection = authenticate(request)
      if (rejection !== undefined) throw fail(rejection === 401 ? '请重新登录 DSH 后打开工作记录' : 'DSH 拒绝此请求来源', rejection)
      const url = new URL(req.url, 'http://localhost'), path = url.pathname.slice('/worklog-control/v1'.length)
      let result
      if (dispatch) {
        if (!['GET', 'POST'].includes(req.method)) throw fail('请求方法不支持', 405)
        result = await dispatch(req.method, path, req.method === 'POST' ? await body(req) : {}, url.searchParams)
      }
      else if (req.method === 'GET' && path === '/version') result = { version: `${store.version()}:${dayOf(Date.now(), store.config().timezone)}` }
      else if (req.method === 'GET' && path === '/models') result = { providers: await models() }
      else if (req.method === 'GET' && path === '/state') result = { ...store.overview(), today: dayOf(Date.now(), store.config().timezone) }
      else if (req.method === 'GET' && path === '/day') result = store.detail(validDay(url.searchParams.get('day')))
      else if (req.method === 'POST') {
        const data = await body(req)
        if (path === '/settings') result = store.configure(data)
        else if (path === '/note') { store.note(data.day, data.text, data.project ? text(data.project, 4096) : ''); result = {} }
        else if (path === '/exclude') { store.exclude(text(data.id, 4096), data.excluded); result = {} }
        else if (path === '/save') { store.save(validDay(data.day), text(data.markdown), data.revision); result = {} }
        else if (path === '/generate') { result = { id: store.enqueue(data.day, data.allowReplace === true) }; void worker.tick() }
        else if (path === '/retry') { result = { id: store.retry(data.id) }; void worker.tick() }
        else if (path === '/cancel') { worker.cancel(data.id); result = {} }
        else throw fail('接口不存在', 404)
      } else throw fail('接口或请求方法不存在', 404)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(result))
    } catch (e) {
      res.writeHead(e.status || 500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify({ error: e.status ? e.message : '工作记录服务异常，请检查服务日志或设置。' }))
    }
  }
}
