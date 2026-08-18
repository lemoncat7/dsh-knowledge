import type { IncomingMessage, ServerResponse } from 'node:http'
import type { KnowledgeConnectionSettings } from './connection.js'
import type { RuntimeContextLike } from './runtime.js'

export const KNOWLEDGE_CONTROL_PATH = '/knowledge-control/v1/connection'

const MAX_BODY_BYTES = 16_384

export interface KnowledgeConnectionView {
  backend: 'local' | 'remote'
  remoteUrl?: string
  remoteTimeoutMs: number
  tokenConfigured: boolean
  canSwitchRemote: boolean
  writable: boolean
  managementAvailable: boolean
  managementPath?: string
}

export interface KnowledgeConnectionUpdate {
  backend: 'local' | 'remote'
  remoteUrl?: string
  remoteToken?: string
  remoteTimeoutMs: number
}

export interface KnowledgeControlOptions {
  current(): KnowledgeConnectionSettings
  canSwitchRemote: boolean
  writable: boolean
  managementAvailable: boolean
  managementPath?: string
  update(value: KnowledgeConnectionUpdate): Promise<KnowledgeConnectionSettings>
}

/** Register the same-origin control surface used by the plugin settings card. */
export function registerKnowledgeControl(
  ctx: RuntimeContextLike,
  options: KnowledgeControlOptions,
): () => void {
  const webServer = ctx.webServer ?? ctx.get('webServer') as RuntimeContextLike['webServer']
  if (webServer === undefined) throw new Error('knowledge connection control requires the DSH webServer service')
  return webServer.register({
    kind: 'exact',
    path: KNOWLEDGE_CONTROL_PATH,
    handler: async (req, res) => {
      try {
        await dispatch(req, res, options)
      } catch (error) {
        sendControlError(res, error)
      }
    },
  })
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  options: KnowledgeControlOptions,
): Promise<void> {
  const method = req.method ?? 'GET'
  if (method === 'GET') {
    return sendJson(res, 200, connectionView(options.current(), options))
  }
  if (method !== 'PUT') {
    res.setHeader('allow', 'GET, PUT')
    throw controlError(405, '此接口仅支持读取或保存连接配置。')
  }
  assertSameOrigin(req)
  if (!isJsonContentType(req.headers['content-type'])) {
    throw controlError(415, '保存连接配置时必须使用 application/json。')
  }
  if (!options.writable) throw controlError(409, '当前插件没有配置持久化路径，无法保存连接。')
  const update = parseUpdate(await readObject(req))
  if (update.backend === 'remote' && !options.canSwitchRemote) {
    throw controlError(409, '中央知识库服务不能再连接另一台远程知识库。')
  }
  const active = await options.update(update)
  sendJson(res, 200, connectionView(active, options))
}

function connectionView(
  settings: KnowledgeConnectionSettings,
  options: Pick<KnowledgeControlOptions, 'canSwitchRemote' | 'writable' | 'managementAvailable' | 'managementPath'>,
): KnowledgeConnectionView {
  return {
    backend: settings.backend,
    remoteTimeoutMs: settings.remoteTimeoutMs,
    tokenConfigured: typeof settings.remoteToken === 'string' && settings.remoteToken.trim().length >= 24,
    canSwitchRemote: options.canSwitchRemote,
    writable: options.writable,
    managementAvailable: options.managementAvailable,
    ...settings.remoteUrl === undefined ? {} : { remoteUrl: settings.remoteUrl },
    ...options.managementAvailable && options.managementPath !== undefined
      ? { managementPath: options.managementPath }
      : {},
  }
}

function parseUpdate(body: Record<string, unknown>): KnowledgeConnectionUpdate {
  if (body.backend !== 'local' && body.backend !== 'remote') {
    throw controlError(400, '知识库来源必须是本地或远程。')
  }
  if (!Number.isInteger(body.remoteTimeoutMs) || (body.remoteTimeoutMs as number) < 100 || (body.remoteTimeoutMs as number) > 120_000) {
    throw controlError(400, '请求超时必须是 100 到 120000 毫秒之间的整数。')
  }
  if (body.remoteUrl !== undefined && typeof body.remoteUrl !== 'string') {
    throw controlError(400, '远程知识库地址格式不正确。')
  }
  if (body.remoteToken !== undefined && typeof body.remoteToken !== 'string') {
    throw controlError(400, '客户端令牌格式不正确。')
  }
  return {
    backend: body.backend,
    remoteTimeoutMs: body.remoteTimeoutMs as number,
    ...typeof body.remoteUrl === 'string' ? { remoteUrl: body.remoteUrl.trim() } : {},
    ...typeof body.remoteToken === 'string' && body.remoteToken.trim().length > 0
      ? { remoteToken: body.remoteToken.trim() }
      : {},
  }
}

function assertSameOrigin(req: IncomingMessage): void {
  const fetchSite = req.headers['sec-fetch-site']
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw controlError(403, '已拒绝跨站连接配置请求。')
  }
  const origin = req.headers.origin
  if (origin === undefined) return
  let originHost: string
  try { originHost = new URL(origin).host } catch { throw controlError(403, '请求来源无效。') }
  const forwardedHost = firstHeader(req.headers['x-forwarded-host'])
  const expectedHost = forwardedHost ?? req.headers.host
  if (expectedHost === undefined || originHost.toLowerCase() !== expectedHost.toLowerCase()) {
    throw controlError(403, '已拒绝跨站连接配置请求。')
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  return raw?.split(',')[0]?.trim()
}

function isJsonContentType(value: string | undefined): boolean {
  return value?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
}

async function readObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw controlError(413, '连接配置内容过大。')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw controlError(413, '连接配置内容过大。')
    chunks.push(buffer)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (!isRecord(value)) throw new Error()
    return value
  } catch {
    throw controlError(400, '请求正文必须是 JSON 对象。')
  }
}

function sendControlError(res: ServerResponse, error: unknown): void {
  const status = isRecord(error) && typeof error.status === 'number' ? error.status : 500
  const message = status >= 500
    ? '连接配置操作失败，请稍后重试或查看 DSH 日志。'
    : error instanceof Error ? error.message : '连接配置请求无效。'
  sendJson(res, status, { error: message, code: status >= 500 ? 'INTERNAL' : `HTTP_${status}` })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(payload)
}

function controlError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
