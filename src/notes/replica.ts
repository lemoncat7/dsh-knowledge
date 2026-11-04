import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { normalizeNoteName } from './store.js'
import { isEditableNoteNode, isNoteId, type NoteNode, type NoteListRequest, type NoteVersion } from './domain.js'
import {
  hash,
  noteFingerprint,
  treeFingerprint,
  syncError,
  type NoteManifest,
  type NoteSyncChange,
} from './sync-protocol.js'

type Row = {
  id: string
  node: string
  base: string | null
  content: Uint8Array
  dirty: number
  deleted: number
  conflict: string | null
  operation: string | null
}
export type NoteTransport = (path: string, method?: string, body?: unknown) => Promise<unknown>
export class NoteReplica {
  private readonly db: DatabaseSync
  private running: Promise<void> | undefined
  private tail: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setInterval> | undefined
  private closed = false
  private closing = false
  private resync = false
  private message = '尚未连接远程，当前显示本地副本'
  private state = 'offline'
  constructor(
    path: string,
    private readonly remote: NoteTransport,
    autoStart = true,
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS replica(id TEXT PRIMARY KEY,node TEXT NOT NULL,base TEXT,content BLOB NOT NULL,dirty INTEGER NOT NULL DEFAULT 0,deleted INTEGER NOT NULL DEFAULT 0,conflict TEXT,operation TEXT);
      CREATE TABLE IF NOT EXISTS versions(id TEXT NOT NULL,version INTEGER NOT NULL,node TEXT NOT NULL,content BLOB NOT NULL,PRIMARY KEY(id,version));
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS incoming(id TEXT PRIMARY KEY,node TEXT NOT NULL,content BLOB NOT NULL);`)
    if (autoStart) this.start()
  }
  start() {
    if (this.timer || this.closed || this.closing) return
    this.timer = setInterval(() => {
      if (!this.running) void this.sync()
    }, 30000)
    this.timer.unref()
    void this.sync()
  }
  private serial<T>(fn: () => Promise<T> | T): Promise<T> {
    const work = this.tail.then(() => {
      if (this.closed) throw Error('note replica closed')
      return fn()
    })
    this.tail = work.catch(() => {})
    return work
  }
  private row(id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM replica WHERE id=?').get(id) as Row | undefined
  }
  private rows(): Row[] {
    return this.db
      .prepare(
        'SELECT id,node,base,dirty,deleted,conflict,operation,zeroblob(0) AS content FROM replica ORDER BY rowid',
      )
      .all() as Row[]
  }
  private node(r: Row): NoteNode {
    return JSON.parse(r.node) as NoteNode
  }
  private save(node: NoteNode, content: Uint8Array, base: NoteNode | null, dirty: boolean, deleted = false): void {
    this.db
      .prepare(
        `INSERT INTO replica(id,node,base,content,dirty,deleted) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET node=excluded.node,base=excluded.base,content=excluded.content,dirty=excluded.dirty,deleted=excluded.deleted,conflict=NULL,operation=NULL`,
      )
      .run(
        node.id,
        JSON.stringify(node),
        base ? JSON.stringify(base) : null,
        Buffer.from(content),
        Number(dirty),
        Number(deleted),
      )
    if (node.kind !== 'folder')
      this.db
        .prepare('INSERT OR IGNORE INTO versions VALUES(?,?,?,?)')
        .run(node.id, node.version, JSON.stringify(node), Buffer.from(content))
  }
  status() {
    const rows = this.rows()
    return {
      mode: 'remote',
      state: this.state,
      message: this.message,
      pending: rows.filter((r) => r.dirty).length,
      conflicts: rows.filter((r) => r.conflict).map((r) => ({ id: r.id, name: this.node(r).name, reason: r.conflict })),
      cached: rows.filter((r) => !r.deleted).length,
    }
  }
  all(): NoteNode[] {
    return this.rows()
      .filter((r) => !r.deleted)
      .map((r) => this.node(r))
  }
  list(request: NoteListRequest = {}): NoteNode[] {
    const q = request.query?.trim().toLocaleLowerCase()
    return this.all()
      .filter(
        (n) =>
          (!request.kind || n.kind === request.kind) &&
          (q ? n.name.toLocaleLowerCase().includes(q) : request.recursive || n.parentId === (request.parentId ?? null)),
      )
      .sort(
        (a, b) =>
          Number(b.kind === 'folder') - Number(a.kind === 'folder') ||
          a.name.localeCompare(b.name) ||
          a.id.localeCompare(b.id),
      )
      .slice(0, Math.max(1, Math.min(request.limit ?? 200, 10000)))
  }
  get(id: string): NoteNode | undefined {
    const r = this.row(id)
    return r && !r.deleted ? this.node(r) : undefined
  }
  read(id: string): { node: NoteNode; content: Buffer } {
    const r = this.row(id)
    if (!r || r.deleted) throw syncError(404, '笔记尚未缓存或已删除')
    const node = this.node(r)
    if (node.kind === 'folder') throw syncError(400, '目录没有正文')
    return { node, content: Buffer.from(r.content) }
  }
  versions(id: string, limit = 100): NoteVersion[] {
    return (
      this.db
        .prepare('SELECT node FROM versions WHERE id=? ORDER BY version DESC LIMIT ?')
        .all(id, Math.min(200, Math.max(1, limit))) as { node: string }[]
    ).map((r) => {
      const n = JSON.parse(r.node) as NoteNode
      return {
        noteId: n.id,
        version: n.version,
        name: n.name,
        mediaType: n.mediaType,
        size: n.size,
        sha256: n.sha256!,
        createdAt: n.updatedAt,
      }
    })
  }
  readVersion(id: string, version: number) {
    const r = this.db.prepare('SELECT node,content FROM versions WHERE id=? AND version=?').get(id, version) as
      | { node: string; content: Uint8Array }
      | undefined
    if (!r) throw syncError(404, '此历史版本尚未保存在本机')
    const node = this.get(id)
    if (!node) throw syncError(404, '笔记不存在')
    const n = JSON.parse(r.node) as NoteNode
    return {
      node,
      version: {
        noteId: id,
        version,
        name: n.name,
        mediaType: n.mediaType,
        size: n.size,
        sha256: n.sha256!,
        createdAt: n.updatedAt,
      },
      content: Buffer.from(r.content),
    }
  }
  private destination(name: string, parentId: string | null, except?: string) {
    if (parentId !== null && this.get(parentId)?.kind !== 'folder') throw syncError(409, '目标目录不存在或尚未缓存')
    if (
      this.all().some((n) => n.id !== except && n.parentId === parentId && n.name.toLowerCase() === name.toLowerCase())
    )
      throw syncError(409, '目录中已有同名笔记')
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const r = fn()
      this.db.exec('COMMIT')
      return r
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
  create(
    kind: NoteNode['kind'],
    name: string,
    parentId: string | null = null,
    content: Uint8Array = new Uint8Array(),
    mediaType: string | null = 'text/markdown',
  ) {
    return this.serial(() => {
      if (kind === 'document' && !name.trim().toLowerCase().endsWith('.md')) name += '.md'
      name = normalizeNoteName(name)
      this.destination(name, parentId)
      if (content.length > 64 * 1024 * 1024) throw syncError(413, '笔记超过 64 MiB')
      const now = new Date().toISOString()
      const n: NoteNode = {
        id: 'note_' + randomUUID().replaceAll('-', ''),
        kind,
        name,
        parentId,
        mediaType: kind === 'folder' ? null : mediaType,
        size: content.length,
        sha256: kind === 'folder' ? null : hash(content),
        version: 1,
        createdAt: now,
        updatedAt: now,
        editable: isEditableNoteNode({ kind, name, mediaType }),
      }
      this.transaction(() => this.save(n, content, null, true))
      void this.sync()
      return n
    })
  }
  change(
    id: string,
    patch: { name?: string; parentId?: string | null; content?: Uint8Array },
    expectedVersion?: number,
  ) {
    return this.serial(() => {
      const row = this.row(id),
        node = this.get(id)
      if (!row || !node) throw syncError(404, '笔记不存在')
      if (row.conflict || row.operation) throw syncError(409, '此笔记有待处理冲突或未确认操作，内容仍保留，请先同步')
      if (expectedVersion !== undefined && expectedVersion !== node.version)
        throw syncError(409, '笔记已变化，请合并后保存')
      const name = patch.name === undefined ? node.name : normalizeNoteName(patch.name),
        parentId = patch.parentId === undefined ? node.parentId : patch.parentId
      this.destination(name, parentId, id)
      let p = parentId
      const visited = new Set<string>()
      while (p) {
        if (p === id || visited.has(p)) throw syncError(409, '目录不能移动到自身内部')
        visited.add(p)
        p = this.get(p)?.parentId ?? null
      }
      const bytes = patch.content ?? row.content
      if (bytes.length > 64 * 1024 * 1024) throw syncError(413, '笔记超过 64 MiB')
      if (patch.content && !node.editable) throw syncError(400, '此文件不可编辑')
      const n = {
        ...node,
        name,
        parentId,
        size: bytes.length,
        sha256: node.kind === 'folder' ? null : hash(bytes),
        version: node.version + 1,
        updatedAt: new Date().toISOString(),
      }
      this.transaction(() => this.save(n, bytes, row.base ? JSON.parse(row.base) : null, true))
      void this.sync()
      return n
    })
  }
  subtree(id: string): NoteNode[] {
    const nodes = this.all(),
      found: NoteNode[] = []
    const walk = (key: string) => {
      const n = nodes.find((n) => n.id === key)
      if (!n) return
      found.push(n)
      for (const child of nodes.filter((n) => n.parentId === key)) walk(child.id)
    }
    walk(id)
    return found
  }
  delete(id: string) {
    return this.serial(() => {
      const nodes = this.subtree(id)
      if (!nodes.length) throw syncError(404, '笔记不存在')
      if (
        nodes.some((n) => {
          const r = this.row(n.id)!
          return r.dirty || r.conflict || r.operation
        })
      )
        throw syncError(409, '请先同步目录中的修改，再执行删除')
      const bases = nodes.map((n) => JSON.parse(this.row(n.id)!.base!) as NoteNode),
        root = this.row(id)!
      const instance = this.db.prepare("SELECT value FROM meta WHERE key='instance'").get() as
        | { value: string }
        | undefined
      if (!instance) throw syncError(409, '尚未确认远程身份，不能删除')
      const change: NoteSyncChange = {
        instance: instance.value,
        operationId: randomUUID(),
        id,
        base: noteFingerprint(JSON.parse(root.base!)),
        subtree: treeFingerprint(bases),
        value: null,
      }
      this.transaction(() => {
        for (const n of nodes) this.db.prepare('UPDATE replica SET dirty=1,deleted=1 WHERE id=?').run(n.id)
        this.db.prepare('UPDATE replica SET operation=? WHERE id=?').run(JSON.stringify(change), id)
      })
      void this.sync()
    })
  }
  private descendantRows(id: string) {
    return this.rows().filter((r) => {
      let p: string | null = r.id
      const seen = new Set<string>()
      while (p && !seen.has(p)) {
        if (p === id) return true
        seen.add(p)
        const ancestor = this.row(p)
        p = ancestor ? this.node(ancestor).parentId : null
      }
      return false
    })
  }
  async restore(id: string, version: number, expected?: number) {
    return this.change(id, { content: this.readVersion(id, version).content }, expected)
  }
  // Taking the remote version archives local bytes in versions; it never erases the history.
  async conflictDetail(id: string) {
    const row = this.row(id)
    if (!row?.conflict) throw syncError(409, '没有待处理冲突')
    const m = (await this.remote('note-sync')) as NoteManifest
    this.checkInstance(m)
    const n = m.nodes.find((n) => n.id === id)
    const bytes = n ? await this.bytes(n) : new Uint8Array()
    return {
      localVersion: this.node(row).version,
      remoteFingerprint: noteFingerprint(n),
      localText: this.node(row).editable ? Buffer.from(row.content).toString('utf8') : '[附件或目录]',
      remoteText: n ? (n.editable ? Buffer.from(bytes).toString('utf8') : '[附件或目录]') : '[远程已删除]',
      canKeepLocal: !!n && !row.deleted,
    }
  }
  resolve(id: string, choice: 'remote' | 'local', expectedRemote: string | null, expectedLocal: number) {
    return this.serial(async () => {
      const row = this.row(id)
      if (!row?.conflict) throw syncError(409, '没有待处理冲突')
      const manifest = (await this.remote('note-sync')) as NoteManifest
      this.checkInstance(manifest)
      const remote = manifest.nodes.find((n) => n.id === id)
      if (noteFingerprint(remote) !== expectedRemote || this.node(row).version !== expectedLocal)
        throw syncError(409, '冲突内容已变化，请重新查看')
      if (choice === 'local') {
        if (row.deleted) throw syncError(409, '删除冲突不能强制覆盖，请先保留远程版本后重新确认删除')
        if (!remote) throw syncError(409, '远程已删除此笔记，请将本地内容另存为新笔记')
        this.db
          .prepare('UPDATE replica SET base=?,conflict=NULL,operation=NULL WHERE id=?')
          .run(JSON.stringify(remote), id)
      } else {
        if (row.deleted) {
          this.transaction(() => {
            for (const child of this.descendantRows(id))
              this.db
                .prepare('UPDATE replica SET base=NULL,dirty=0,conflict=NULL,operation=NULL WHERE id=?')
                .run(child.id)
          })
        }
        if (remote) {
          const bytes = await this.bytes(remote)
          const n = { ...remote, version: this.node(row).version + 1 }
          this.transaction(() => this.save(n, bytes, remote, false))
        } else this.db.prepare('UPDATE replica SET dirty=0,deleted=1,conflict=NULL,operation=NULL WHERE id=?').run(id)
      }
      void this.sync()
    })
  }
  private checkInstance(manifest: NoteManifest) {
    if (manifest.protocol !== 1 || !Array.isArray(manifest.nodes) || manifest.nodes.length > 10000)
      throw syncError(426, '远程尚不支持此离线同步协议')
    const known = this.db.prepare("SELECT value FROM meta WHERE key='instance'").get() as { value: string } | undefined
    if (known && known.value !== manifest.instance)
      throw syncError(409, '远程数据库身份已变化，已停止上传，原本地副本保留')
    if (!known) this.db.prepare("INSERT INTO meta VALUES('instance',?)").run(manifest.instance)
  }
  private async bytes(node: NoteNode): Promise<Uint8Array> {
    if (node.kind === 'folder') return new Uint8Array()
    const result = (await this.remote(`notes/${node.id}/content`)) as Uint8Array
    if (!(result instanceof Uint8Array) || result.length !== node.size || hash(result) !== node.sha256)
      throw syncError(409, '远程正文变化或校验失败，下次重新同步')
    return result
  }
  sync(): Promise<void> {
    if (this.closed || this.closing) return Promise.resolve()
    if (this.running) {
      this.resync = true
      return this.running
    }
    this.running = (async () => {
      do {
        this.resync = false
        await this.cycle()
      } while (this.resync && !this.closing)
    })().finally(() => {
      this.running = undefined
    })
    return this.running
  }
  private async cycle() {
    try {
      this.state = 'syncing'
      let manifest = (await this.remote('note-sync')) as NoteManifest
      this.checkInstance(manifest)
      // A parent deletion carries the complete subtree precondition; never split it into child deletes.
      for (const candidate of this.rows()
        .filter((r) => r.dirty && !r.conflict)
        .sort((a, b) =>
          a.deleted && b.deleted
            ? this.depth(this.node(a)) - this.depth(this.node(b))
            : Number(a.deleted) - Number(b.deleted),
        )) {
        const row = this.row(candidate.id)!
        const node = this.node(row),
          remote = manifest.nodes.find((n) => n.id === row.id),
          base = row.base ? (JSON.parse(row.base) as NoteNode) : null
        if (!row.operation && noteFingerprint(remote) !== noteFingerprint(base)) {
          this.conflict(row.id, '远程和本地都有变化，已保留双方内容')
          continue
        }
        let ancestor = node.parentId,
          skip = false
        while (ancestor) {
          const a = this.row(ancestor)
          if (!a) break
          if (a.deleted && a.dirty) {
            skip = true
            break
          }
          ancestor = this.node(a).parentId
        }
        if (skip) continue
        if (!this.row(row.id)?.dirty) continue
        const parent = node.parentId && this.row(node.parentId)
        if (!row.deleted && parent && (parent.dirty || parent.conflict)) continue
        const change: NoteSyncChange = row.operation
          ? JSON.parse(row.operation)
          : {
              instance: manifest.instance,
              operationId: randomUUID(),
              id: node.id,
              base: noteFingerprint(base),
              ...(row.deleted ? { subtree: treeFingerprint(remote ? [remote] : []) } : {}),
              value: row.deleted
                ? null
                : {
                    kind: node.kind,
                    name: node.name,
                    parentId: node.parentId,
                    mediaType: node.mediaType,
                    content: Buffer.from(row.content).toString('base64'),
                  },
            }
        this.db.prepare('UPDATE replica SET operation=? WHERE id=?').run(JSON.stringify(change), row.id)
        try {
          const result = (await this.remote('note-sync', 'POST', change)) as NoteNode | null
          this.transaction(() => {
            if (result) this.save({ ...result, version: node.version }, row.content, result, false)
            else
              for (const child of this.descendantRows(row.id))
                this.db.prepare('UPDATE replica SET base=NULL,dirty=0,operation=NULL WHERE id=?').run(child.id)
          })
          manifest.nodes = manifest.nodes.filter((n) => n.id !== row.id)
          if (result) manifest.nodes.push(result)
        } catch (e) {
          const status = (e as { status?: number }).status
          if (status === 409 || status === 400 || status === 413) {
            this.conflict(row.id, e instanceof Error ? e.message : '同步冲突')
            continue
          }
          throw e
        }
      }
      manifest = (await this.remote('note-sync')) as NoteManifest
      this.checkInstance(manifest)
      // Stage downloads first. Never infer deletion from a partial/failed listing.
      this.db.exec('DELETE FROM incoming')
      for (const node of manifest.nodes) {
        if (!isNoteId(node.id)) throw syncError(502, 'invalid remote note ID')
        const r = this.row(node.id)
        if (r?.dirty) continue
        if (r && !r.deleted && noteFingerprint(r.base ? JSON.parse(r.base) : null) === noteFingerprint(node)) continue
        this.db.prepare('INSERT INTO incoming VALUES(?,?,?)').run(node.id, JSON.stringify(node), await this.bytes(node))
      }
      const confirmed = (await this.remote('note-sync')) as NoteManifest
      this.checkInstance(confirmed)
      if (confirmed.revision !== manifest.revision) throw syncError(423, '远程正在变化，已保留本地副本，稍后再同步')
      this.transaction(() => {
        for (const { id } of this.db.prepare('SELECT id FROM incoming').all() as { id: string }[]) {
          const item = this.db.prepare('SELECT node,content FROM incoming WHERE id=?').get(id) as {
            node: string
            content: Uint8Array
          }
          const node = JSON.parse(item.node) as NoteNode,
            old = this.row(node.id)
          if (old?.dirty) continue // An offline edit may arrive while a download is in flight.
          this.save({ ...node, version: old ? this.node(old).version + 1 : node.version }, item.content, node, false)
        }
        this.db.exec('DELETE FROM incoming')
        const present = new Set(manifest.nodes.map((n) => n.id))
        for (const r of this.rows()) {
          if (!r.dirty && !present.has(r.id)) this.db.prepare('UPDATE replica SET deleted=1 WHERE id=?').run(r.id)
        }
      })
      this.state = 'online'
      this.message = '远程已连接，本地副本已更新'
    } catch (e) {
      const status = (e as { status?: number }).status
      this.state =
        status === 401 || status === 403
          ? 'auth'
          : status === 404 || status === 426
            ? 'unsupported'
            : status === 409
              ? 'blocked'
              : 'offline'
      this.message =
        status === 401 || status === 403
          ? '远程授权失效，已停止同步，本地内容保留'
          : status === 404 || status === 426
            ? '远程需要升级以支持离线同步，本地内容保留'
            : e instanceof Error
              ? e.message
              : '远程暂不可用，本地内容已保留'
    }
  }
  private depth(n: NoteNode) {
    let count = 0,
      p = n.parentId
    const seen = new Set<string>()
    while (p && !seen.has(p)) {
      seen.add(p)
      count++
      p = this.row(p) ? this.node(this.row(p)!).parentId : null
    }
    return count
  }
  private conflict(id: string, reason: string) {
    this.db.prepare('UPDATE replica SET conflict=? WHERE id=?').run(reason, id)
  }
  async close() {
    this.closing = true
    if (this.timer) clearInterval(this.timer)
    await Promise.all([this.tail, this.running])
    this.closed = true
    this.db.close()
  }
}
