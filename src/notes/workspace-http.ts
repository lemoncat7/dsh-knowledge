import type { IncomingMessage, ServerResponse } from 'node:http'
import type { NoteReplica } from './replica.js'
import type { NoteVault } from './vault.js'
import type { NoteListRequest } from './domain.js'
import { syncError, hash } from './sync-protocol.js'
import { decodePageCursor, encodePageCursor } from '../page-cursor.js'
export interface NoteWorkspace {
  replica?: NoteReplica | undefined
  vault?: NoteVault | undefined
}
export async function handleNoteWorkspace(
  workspace: NoteWorkspace,
  path: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const r = workspace.replica,
    v = workspace.vault,
    method = req.method ?? 'GET',
    parts = path.split('/').map(decodeURIComponent)
  const json = (value: unknown, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(value))
    return true
  }
  const binary = (bytes: Uint8Array, type: string) => {
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    })
    res.end(bytes)
    return true
  }
  const body = async () => {
    const chunks: Buffer[] = []
    let length = 0
    for await (const chunk of req) {
      const b = Buffer.from(chunk)
      length += b.length
      if (length > 64 * 1024 * 1024) throw syncError(413, '笔记内容超过 64 MiB')
      chunks.push(b)
    }
    return Buffer.concat(chunks)
  }
  const object = async () => {
    const b = await body()
    if (b.length > 1048576) throw syncError(413, '请求过大')
    const parsed = JSON.parse(b.toString() || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw syncError(400, '请求格式错误')
    return parsed as Record<string, unknown>
  }
  const text = (v: unknown) => {
    if (typeof v !== 'string' || !v.trim()) throw syncError(400, '名称不能为空')
    return v
  }
  const parent = (v: unknown) => {
    if (v === undefined || v === null || v === '') return null
    if (typeof v !== 'string') throw syncError(400, '目录格式错误')
    return v
  }
  const version = (v: unknown) => {
    if (v === undefined || v === null) return undefined
    const n = Number(v)
    if (!Number.isSafeInteger(n) || n < 1) throw syncError(400, '版本格式错误')
    return n
  }
  if (path === 'note-workspace') {
    if (method === 'POST') {
      await v?.scan()
      await r?.sync()
      await v?.scan()
    } else if (method !== 'GET') throw syncError(405, '不支持此操作')
    return json({ ...r?.status(), ...v?.status(), mode: r ? 'remote' : 'local' })
  }
  if (path === 'note-workspace/conflict' && method === 'GET') {
    if (!r) throw syncError(409, '当前不是远程工作区')
    return json(await r.conflictDetail(text(url.searchParams.get('id'))))
  }
  if (path === 'note-workspace/resolve' && method === 'POST') {
    if (!r) throw syncError(409, '当前不是远程工作区')
    const b = await object()
    if (b.choice !== 'local' && b.choice !== 'remote') throw syncError(400, '请选择保留的版本')
    await r.resolve(
      text(b.id),
      b.choice,
      b.remoteFingerprint === null ? null : text(b.remoteFingerprint),
      version(b.localVersion) ?? 0,
    )
    return json({ ok: true })
  }
  if (!r || parts[0] !== 'notes') return false
  if (method === 'GET' && parts.length === 1) {
    const request: NoteListRequest = {
      parentId: url.searchParams.get('parentId'),
      ...(url.searchParams.has('q') ? { query: url.searchParams.get('q')! } : {}),
      recursive: url.searchParams.get('recursive') === '1',
      limit: 10000,
    }
    const kind = url.searchParams.get('kind')
    if (kind) {
      if (!['folder', 'file', 'document'].includes(kind)) throw syncError(400, '类型无效')
      request.kind = kind as NoteListRequest['kind'] & string
    }
    const all = r.list(request),
      limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200))
    if (url.searchParams.get('paged') !== '1') return json(all.slice(0, limit))
    const scope = hash(JSON.stringify([request, all.map((n) => [n.id, n.version])])),
      cursor = decodePageCursor(url.searchParams.get('cursor') ?? undefined, scope, ['number'])
    const offset = Number(cursor?.[0] ?? 0),
      items = all.slice(offset, offset + limit)
    return json({
      items,
      total: all.length,
      nextCursor: offset + limit < all.length ? encodePageCursor(scope, [offset + limit]) : null,
    })
  }
  if (method === 'POST' && parts.length === 2 && ['folders', 'documents', 'files'].includes(parts[1]!)) {
    if (parts[1] === 'files')
      return json(
        await r.create(
          'file',
          text(url.searchParams.get('name')),
          parent(url.searchParams.get('parentId')),
          await body(),
          String(req.headers['content-type'] ?? 'application/octet-stream'),
        ),
        201,
      )
    const b = await object()
    return json(
      await r.create(
        parts[1] === 'folders' ? 'folder' : 'document',
        text(b.name),
        parent(b.parentId),
        Buffer.from(typeof b.content === 'string' ? b.content : ''),
      ),
      201,
    )
  }
  const id = parts[1]
  if (!id) return false
  if (parts.length === 2 && method === 'GET' && !['shares'].includes(id)) {
    const n = r.get(id)
    if (!n) throw syncError(404, '笔记尚未缓存或不存在')
    return json(n)
  }
  if (parts[2] === 'content' && parts.length === 3) {
    if (method === 'GET') {
      const n = r.read(id)
      return binary(n.content, n.node.mediaType ?? 'application/octet-stream')
    }
    if (method === 'PUT')
      return json(await r.change(id, { content: await body() }, version(url.searchParams.get('expectedVersion'))))
  }
  if (method === 'PATCH' && parts.length === 2) {
    const b = await object()
    const node = r.get(id)
    if (b.expectedName !== undefined && b.expectedName !== node?.name) throw syncError(409, '标题已变化')
    return json(
      await r.change(id, {
        ...(b.name === undefined ? {} : { name: text(b.name) }),
        ...(b.parentId === undefined ? {} : { parentId: parent(b.parentId) }),
      }),
    )
  }
  if (method === 'DELETE' && parts.length === 2) {
    await r.delete(id)
    return json({ ok: true })
  }
  if (parts[2] === 'versions') {
    if (parts.length === 3 && method === 'GET') return json(r.versions(id))
    if (parts.length === 5 && parts[4] === 'content' && method === 'GET') {
      const n = r.readVersion(id, version(parts[3])!)
      return binary(n.content, n.version.mediaType ?? 'application/octet-stream')
    }
    if (parts.length === 5 && parts[4] === 'restore' && method === 'POST') {
      const b = await object()
      return json(await r.restore(id, version(parts[3])!, version(b.expectedVersion)))
    }
  }
  if (parts[2] === 'copy' && method === 'POST') {
    const b = await object(),
      n = r.get(id)
    if (!n) throw syncError(404, '笔记不存在')
    if (n.kind === 'folder') throw syncError(409, '第一版离线副本暂不支持复制整个目录，可新建目录后复制单篇笔记')
    return json(
      await r.create(
        n.kind,
        b.name === undefined ? n.name : text(b.name),
        b.parentId === undefined ? n.parentId : parent(b.parentId),
        r.read(id).content,
        n.mediaType,
      ),
      201,
    )
  }
  // Sharing/references remain remote-only and may not refer to uncommitted local revisions.
  if (r.status().pending) throw syncError(409, '请先同步本地修改，再执行分享、关联或导入操作')
  return false
}
