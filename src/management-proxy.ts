import type { IncomingMessage, ServerResponse } from 'node:http'
import type { KnowledgeConnectionSettings } from './connection.js'
import type { RuntimeContextLike } from './runtime.js'

const MAX_JSON_REQUEST_BYTES = 1_048_576
const MAX_JSON_RESPONSE_BYTES = 10_485_760
const MAX_NOTE_FILE_BYTES = 64 * 1024 * 1024

export function registerRemoteManagementProxy(
  ctx: RuntimeContextLike,
  prefix: string,
  current: () => KnowledgeConnectionSettings,
  localService: {
    current(): { writebackProvider?: string; writebackModel?: string }
    update(patch: { writebackProvider?: string | null; writebackModel?: string | null }): Promise<{ writebackProvider?: string; writebackModel?: string }>
  },
): () => void {
  const webServer = ctx.webServer ?? ctx.get('webServer') as RuntimeContextLike['webServer']
  if (webServer === undefined) throw new Error('remote knowledge management requires the DSH webServer service')
  return webServer.register({
    kind: 'prefix',
    path: prefix,
    handler: async (req, res) => {
      try { await dispatch(prefix, current(), localService, req, res) } catch (error) { sendError(res, error) }
    },
  })
}

async function dispatch(
  prefix: string,
  settings: KnowledgeConnectionSettings,
  localService: {
    current(): { writebackProvider?: string; writebackModel?: string }
    update(patch: { writebackProvider?: string | null; writebackModel?: string | null }): Promise<{ writebackProvider?: string; writebackModel?: string }>
  },
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
    if (method === 'GET') {
      const local = localService.current()
      return sendJson(res, 200, {
      publicApiEnabled: true,
      publicApiPrefix: settings.remoteUrl,
      remote: true,
      ...local.writebackProvider && local.writebackModel
        ? { writebackProvider: local.writebackProvider, writebackModel: local.writebackModel }
        : {},
      })
    }
    if (method !== 'PUT') throw httpError(405, '不支持此本机设置请求方法。')
    const body = JSON.parse((await readBody(req, MAX_JSON_REQUEST_BYTES))?.toString('utf8') ?? '{}') as Record<string, unknown>
    if (body.publicApiEnabled !== undefined) throw httpError(409, '请在中央 DSH 的知识库管理台中修改远程 API 状态。')
    const writebackProvider = body.writebackProvider
    const writebackModel = body.writebackModel
    if (writebackProvider !== undefined && writebackProvider !== null && typeof writebackProvider !== 'string') throw httpError(400, 'writebackProvider must be a string or null')
    if (writebackModel !== undefined && writebackModel !== null && typeof writebackModel !== 'string') throw httpError(400, 'writebackModel must be a string or null')
    const updated = await localService.update({
      ...writebackProvider === undefined ? {} : { writebackProvider },
      ...writebackModel === undefined ? {} : { writebackModel },
    })
    return sendJson(res, 200, {
      publicApiEnabled: true,
      publicApiPrefix: settings.remoteUrl,
      remote: true,
      ...updated.writebackProvider && updated.writebackModel
        ? { writebackProvider: updated.writebackProvider, writebackModel: updated.writebackModel }
        : {},
    })
  }
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw httpError(405, '不支持此远程管理请求方法。')
  const base = settings.remoteUrl.endsWith('/') ? settings.remoteUrl : `${settings.remoteUrl}/`
  const target = new URL(`${relative}${incoming.search}`, base)
  const noteContentRoute = relative.startsWith('notes/files') || /notes\/[^/]+\/(?:content|versions\/\d+\/content)(?:\?|$)/.test(relative)
  const body = method === 'GET' ? undefined : await readBody(req, noteContentRoute ? MAX_NOTE_FILE_BYTES : MAX_JSON_REQUEST_BYTES)
  const controller = new AbortController()
  const abort = () => { controller.abort() }
  req.once('aborted', abort)
  try {
    const response = await fetch(target, {
      method,
      headers: {
        accept: firstHeader(req.headers.accept) ?? 'application/json',
        authorization: `Bearer ${settings.remoteToken}`,
        ...body === undefined ? {} : { 'content-type': firstHeader(req.headers['content-type']) ?? 'application/octet-stream' },
      },
      ...body === undefined ? {} : { body: new Uint8Array(body) },
      signal: controller.signal,
      redirect: 'manual',
    })
    const maximumResponseBytes = noteContentRoute ? MAX_NOTE_FILE_BYTES : MAX_JSON_RESPONSE_BYTES
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (Number.isFinite(declared) && declared > maximumResponseBytes) throw httpError(502, '中央知识库响应过大。')
    const payload = Buffer.from(await response.arrayBuffer())
    if (payload.byteLength > maximumResponseBytes) throw httpError(502, '中央知识库响应过大。')
    res.writeHead(response.status, {
      'content-type': response.headers.get('content-type') ?? 'application/json; charset=utf-8',
      'content-length': payload.byteLength,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...response.headers.get('content-disposition') === null
        ? {}
        : { 'content-disposition': response.headers.get('content-disposition') as string },
      ...response.headers.get('content-security-policy') === null
        ? {}
        : { 'content-security-policy': response.headers.get('content-security-policy') as string },
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

async function readBody(req: IncomingMessage, maximumBytes: number): Promise<Buffer | undefined> {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (Number.isFinite(declared) && declared > maximumBytes) throw httpError(413, '远程管理请求内容过大。')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maximumBytes) throw httpError(413, '远程管理请求内容过大。')
    chunks.push(buffer)
  }
  return size === 0 ? undefined : Buffer.concat(chunks)
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
