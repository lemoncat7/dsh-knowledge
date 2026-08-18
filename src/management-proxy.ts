import type { IncomingMessage, ServerResponse } from 'node:http'
import type { KnowledgeConnectionSettings } from './connection.js'
import type { RuntimeContextLike } from './runtime.js'

const MAX_REQUEST_BYTES = 1_048_576
const MAX_RESPONSE_BYTES = 10_485_760

export function registerRemoteManagementProxy(
  ctx: RuntimeContextLike,
  prefix: string,
  current: () => KnowledgeConnectionSettings,
): () => void {
  const webServer = ctx.webServer ?? ctx.get('webServer') as RuntimeContextLike['webServer']
  if (webServer === undefined) throw new Error('remote knowledge management requires the DSH webServer service')
  return webServer.register({
    kind: 'prefix',
    path: prefix,
    handler: async (req, res) => {
      try { await dispatch(prefix, current(), req, res) } catch (error) { sendError(res, error) }
    },
  })
}

async function dispatch(
  prefix: string,
  settings: KnowledgeConnectionSettings,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  assertManagementRequest(req)
  if (settings.backend !== 'remote' || settings.remoteUrl === undefined || settings.remoteToken === undefined) {
    throw httpError(409, '当前没有可用的远程知识库连接。')
  }
  const incoming = new URL(req.url ?? '/', 'http://knowledge.local')
  const relative = incoming.pathname.slice(prefix.length).replace(/^\/+/, '')
  const method = req.method ?? 'GET'
  if (relative === 'service') {
    if (method !== 'GET') throw httpError(409, '请在中央 DSH 的知识库管理台中修改远程 API 状态。')
    return sendJson(res, 200, {
      publicApiEnabled: true,
      publicApiPrefix: settings.remoteUrl,
      remote: true,
    })
  }
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw httpError(405, '不支持此远程管理请求方法。')
  const base = settings.remoteUrl.endsWith('/') ? settings.remoteUrl : `${settings.remoteUrl}/`
  const target = new URL(`${relative}${incoming.search}`, base)
  const body = method === 'GET' ? undefined : await readBody(req)
  const controller = new AbortController()
  const abort = () => { controller.abort() }
  req.once('aborted', abort)
  try {
    const response = await fetch(target, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${settings.remoteToken}`,
        ...body === undefined ? {} : { 'content-type': 'application/json' },
      },
      ...body === undefined ? {} : { body },
      signal: controller.signal,
      redirect: 'manual',
    })
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw httpError(502, '中央知识库响应过大。')
    const payload = Buffer.from(await response.arrayBuffer())
    if (payload.byteLength > MAX_RESPONSE_BYTES) throw httpError(502, '中央知识库响应过大。')
    res.writeHead(response.status, {
      'content-type': response.headers.get('content-type') ?? 'application/json; charset=utf-8',
      'content-length': payload.byteLength,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    res.end(payload)
  } finally {
    req.off('aborted', abort)
  }
}

function assertManagementRequest(req: IncomingMessage): void {
  if (req.headers['x-dsh-knowledge-client'] !== 'management-web') throw httpError(401, '缺少知识库管理客户端标识。')
  const fetchSite = req.headers['sec-fetch-site']
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') throw httpError(403, '已拒绝跨站知识库管理请求。')
  const origin = req.headers.origin
  if (origin === undefined) return
  let originHost: string
  try { originHost = new URL(origin).host } catch { throw httpError(403, '知识库管理请求来源无效。') }
  const expectedHost = firstHeader(req.headers['x-forwarded-host']) ?? req.headers.host
  if (expectedHost === undefined || originHost.toLowerCase() !== expectedHost.toLowerCase()) throw httpError(403, '已拒绝跨域知识库管理请求。')
}

async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) throw httpError(413, '远程管理请求内容过大。')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_REQUEST_BYTES) throw httpError(413, '远程管理请求内容过大。')
    chunks.push(buffer)
  }
  return size === 0 ? undefined : Buffer.concat(chunks).toString('utf8')
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  return raw?.split(',')[0]?.trim()
}

function sendError(res: ServerResponse, error: unknown): void {
  const status = error !== null && typeof error === 'object' && typeof (error as { status?: unknown }).status === 'number'
    ? (error as { status: number }).status : 502
  const message = status >= 500 ? '无法连接中央知识库，请检查网络和服务状态。' : error instanceof Error ? error.message : '远程管理请求失败。'
  sendJson(res, status, { error: message, code: `HTTP_${status}` })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.byteLength,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(payload)
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status })
}
