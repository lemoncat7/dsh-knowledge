import {moveVaultEntry, type VaultMove} from './vault-move.js'
import {installVaultFile} from './vault-file.js'
import { constants, watch, type FSWatcher } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { snapshotVault, vaultIdentity, type VaultEntry } from './vault-snapshot.js'
import { mergeVaultText } from './vault-merge.js'
import { mkdir, lstat, open, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep, extname, basename } from 'node:path'
import { atomicWriteFile } from '../atomic-file.js'
import { hash, syncError, noteFingerprint } from './sync-protocol.js'
import type { NoteNode } from './domain.js'

export interface VaultNotes {
  readVersion?(id: string, version: number): Promise<{content: Uint8Array}> | {content: Uint8Array}
  relocate?(id: string, name: string, parentId: string | null, expected: string): Promise<NoteNode>
  all(): NoteNode[] | Promise<NoteNode[]>
  read(id: string): Promise<{ node: NoteNode; content: Uint8Array }> | { node: NoteNode; content: Uint8Array }
  update(id: string, bytes: Uint8Array, version: number): Promise<NoteNode>
  create(kind: 'folder' | 'document', name: string, parentId: string | null, content: Uint8Array): Promise<NoteNode>
}
interface Mapping {
  id: string
  path: string
  hash: string | null
  version: number
  kind: NoteNode['kind']
  pendingMove?: VaultMove
  identity?: string
  name?: string
  parentId?: string | null
  missingSince?: number
  missingScans?: number
  trash?: { name: string; parentId: string | null; path: string; at: string; target: string }
  missing?: boolean
  conflict?: boolean
}
/** Plain files are an interoperable projection. The journal lives outside the vault. */
export class NoteVault {
  private mappings: Mapping[] = []
  private running: Promise<void> | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private stopped = false
  private loaded = false
  private rescan = false
  private token: string | undefined
  private rootIdentity: string | undefined
  private watcher: FSWatcher | undefined
  private debounce: ReturnType<typeof setTimeout> | undefined
  private blockedDirectories: string[] = []
  private previousSnapshot = new Map<string, VaultEntry>()
  private observations = new Map<string, {signature: string; since: number}>()
  private events: {id: string; version: number; path: string; action: string; time: string}[] = []
  private trashFolder: string | undefined
  private warning = ''
  constructor(
    readonly path: string,
    private readonly notes: VaultNotes,
    private readonly manifestPath: string,
    private readonly autoStart = true,
    private readonly timing = { stableMs: 1500, missingMs: 30000, now: () => Date.now() },
  ) {
    if (autoStart) {
      this.timer = setInterval(() => {
        if (!this.running) void this.scan()
      }, 5000)
      this.timer.unref()
      void this.scan()
    }
  }
  status() {
    return {
      path: this.path,
      events: this.events.slice(-100).reverse(),
      recycle: this.mappings.filter(m => m.trash).map(m => ({ id: m.id, path: m.trash!.path, time: m.trash!.at })),
      externalIssues: this.mappings.filter(m => m.conflict).map(m => ({id: m.id, path: m.path})),
      warning: this.warning,
      externalConflicts: this.mappings.filter((m) => m.conflict).length,
      externalMissing: this.mappings.filter((m) => m.missing && !this.recycled(m.path)).length,
    }
  }
  private async safe(path: string, allowMissing = false) {
    const root = resolve(this.path),
      target = resolve(path)
    if (target !== root && !target.startsWith(root + sep)) throw syncError(400, '路径超出笔记工作区')
    const parts = relative(root, target).split(sep).filter(Boolean)
    let current = root
    for (const part of ['', ...parts]) {
      if (part) current = join(current, part)
      try {
        const info = await lstat(current)
        if (info.isSymbolicLink()) throw syncError(409, '笔记工作区不读取或写入符号链接')
      } catch (e) {
        if (allowMissing && (e as NodeJS.ErrnoException).code === 'ENOENT') return
        throw e
      }
    }
  }
  private async bytes(path: string) {
    await this.safe(path)
    const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const st = await f.stat()
      if (!st.isFile() || st.size > 64 * 1024 * 1024) throw syncError(413, '文件过大或不是普通文件')
      return await f.readFile()
    } finally {
      await f.close()
    }
  }
  private async persist() {
    await mkdir(dirname(this.manifestPath), { recursive: true, mode: 0o700 })
    await atomicWriteFile(this.manifestPath, JSON.stringify({ format: 2, token: this.token, rootIdentity: this.rootIdentity, trashFolder: this.trashFolder, events: this.events, mappings: this.mappings }), { mode: 0o600 })
  }
  scan(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.running) {
      this.rescan = true
      return this.running
    }
    this.running = (async () => {
      do {
        this.rescan = false
        await this.cycle()
      } while (this.rescan && !this.stopped)
    })()
      .catch((e) => {
        for (const m of this.mappings) { delete m.missingSince; delete m.missingScans }
        this.warning = e instanceof Error ? e.message : '本地文件工作区暂不可用'
      })
      .finally(() => {
        this.running = undefined
      })
    return this.running
  }
  private async cycle() {
    if (!this.loaded) {
      try {
        const saved = JSON.parse(await readFile(this.manifestPath, 'utf8'))
        if (![1, 2].includes(saved.format) || !Array.isArray(saved.mappings)) throw Error('工作区索引格式无效')
        this.mappings = saved.mappings
        this.token = saved.token
        this.rootIdentity = saved.rootIdentity
        this.trashFolder = saved.trashFolder
        this.events = saved.events ?? []
        for (const m of this.mappings) {
          if (typeof m.path !== 'string' || resolve(this.path, m.path) === resolve(this.path) || !resolve(this.path, m.path).startsWith(resolve(this.path) + sep)) throw Error('工作区索引包含无效路径')
          // Missing confirmation never survives a process restart.
          delete m.missingSince; delete m.missingScans
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      }
      this.loaded = true
    }
    this.warning = ''
    await this.verifyRoot()
    let snapshot = await snapshotVault(this.path, this.previousSnapshot)
    await this.verifyRoot()
    this.previousSnapshot = snapshot
    this.blockedDirectories = this.mappings.filter(m => m.kind === 'folder' && m.identity && snapshot.has(m.path) && snapshot.get(m.path)!.identity !== m.identity).map(m => m.path)
    for (const m of this.mappings) if (this.blockedDirectories.includes(m.path)) {
      m.conflict = true
      this.warning = '子目录身份或挂载发生变化，已暂停该目录同步，请确认后恢复或关联'
    }
    let nodes = await this.notes.all()
    const removed = await this.reconcileNativeDeletes(nodes, snapshot)
    if (await this.reconcileNativePaths(nodes, snapshot) || removed) {
      snapshot = await snapshotVault(this.path)
      this.previousSnapshot = snapshot
    }
    await this.reconcilePaths(snapshot, nodes)
    nodes = await this.notes.all()
    const known = new Map(nodes.map((n) => [n.id, n]))
    // Import external edits before exporting. Dirty files are never overwritten.
    for (const m of this.mappings) {
      if (m.kind === 'folder' || m.pendingMove || this.recycled(m.path) || this.blocked(m.path)) continue
      const path = join(this.path, m.path)
      const unchanged = snapshot.get(m.path)
      if (unchanged && unchanged.digest === m.hash && !m.conflict) {
        m.missing = false; delete m.missingSince; delete m.missingScans
        m.identity = unchanged.identity; this.stable(unchanged)
        continue
      }
      let bytes: Buffer
      try {
        bytes = await this.bytes(path)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          m.missing = true
          continue
        }
        throw e
      }
      m.missing = false
      delete m.missingSince; delete m.missingScans
      const digest = hash(bytes)
      const entry = snapshot.get(m.path)
      if (!entry || entry.digest !== digest || !this.stable(entry)) continue
      const node = known.get(m.id)
      if (digest === node?.sha256) {
        m.hash = digest; m.version = node.version; m.conflict = false; m.identity = entry.identity
        continue
      }
      if (digest === m.hash) { m.conflict = false; continue }
      if (!node || !node.editable) { m.conflict = true; continue }
      let imported: Uint8Array = bytes
      if (node.sha256 !== m.hash) {
        let merged: Buffer | null = null
        if (this.notes.readVersion) {
          try {
            const base = await this.notes.readVersion(m.id, m.version)
            const current = await this.notes.read(m.id)
            if (hash(base.content) === m.hash && current.node.version === node.version) merged = mergeVaultText(base.content, current.content, bytes)
          } catch { /* A missing base must remain a conflict. */ }
        }
        if (!merged) {
          m.conflict = true
          this.warning = '外部文件与网页修改重叠，双方已保留；可在同步与本地文件中处理'
          continue
        }
        imported = merged
      }
      if (hash(await this.bytes(path)) !== digest) continue
      try {
        const updated = await this.notes.update(m.id, imported, node.version)
        if (hash(imported) !== digest && !await installVaultFile(path, imported, digest)) {
          m.conflict = true
          this.record(updated, m.path, '自动合并后文件再次变化，保留双方')
          continue
        }
        m.hash = updated.sha256
        m.version = updated.version
        m.conflict = false
        m.identity = (await vaultIdentity(path)).identity
        this.record(updated, m.path, hash(imported) === digest ? '外部文件修改' : '外部与应用修改自动合并')
        known.set(m.id, updated)
      } catch (e) {
        m.conflict = true
        this.warning = e instanceof Error ? e.message : '外部编辑冲突'
      }
    }
    await this.persist()
    nodes = await this.notes.all()
    const pathFor = (n: NoteNode, seen = new Set<string>()): string => {
      if (seen.has(n.id)) throw Error('笔记目录循环')
      seen.add(n.id)
      // Keep ordinary names so standard Markdown relative links work in OB.
      const clean =
        n.name
          .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
          .replace(/[. ]+$/g, '')
          .slice(0, 100) || '未命名'
      const ext =
        n.kind === 'document'
          ? /\.(md|markdown)$/i.test(clean)
            ? extname(clean)
            : '.md'
          : n.kind === 'file'
            ? extname(clean)
            : ''
      const stem = ext && clean.endsWith(ext) ? clean.slice(0, -ext.length) : clean
      const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)
      const component = reserved ? `${stem} [${n.id.slice(5, 13)}]${ext}` : `${stem}${ext}`
      const stored = this.mappings.find((m) => m.id === n.id)
      if (stored) return stored.path
      const parent = n.parentId ? nodes.find((x) => x.id === n.parentId) : undefined
      return parent ? join(pathFor(parent, seen), component) : component
    }
    for (const n of nodes) {
      if (n.id === this.trashFolder || this.inTrash(n, nodes)) continue
      let m = this.mappings.find((m) => m.id === n.id)
      if (m?.conflict || m?.missing || m?.trash || m?.pendingMove || m && this.blocked(m.path)) continue
      const rel = m?.path ?? pathFor(n),
        path = join(this.path, rel)
      await this.safe(path, true)
      if (n.kind === 'folder') {
        if (m && m.name === n.name && m.parentId === n.parentId) m.version = n.version
        await mkdir(path, { recursive: true, mode: 0o700 })
        if (!m) {
          m = { id: n.id, path: rel, hash: null, version: n.version, kind: n.kind, name: n.name, parentId: n.parentId, identity: (await vaultIdentity(path)).identity }
          this.mappings.push(m)
        }
        continue
      }
      if (m && m.hash === n.sha256) { m.version = n.version; if (snapshot.get(m.path)) m.identity = snapshot.get(m.path)!.identity; continue }
      if (m && snapshot.get(m.path) && !this.stable(snapshot.get(m.path)!)) continue
      if (!m) {
        try {
          await lstat(path)
          this.warning = '目标文件已存在，未覆盖；请检查工作区文件'
          continue
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
        }
      }
      const { node, content } = await this.notes.read(n.id)
      if (node.sha256 !== n.sha256) continue
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await this.safe(path, true)
      // Check again immediately before replacement (external editors may save during I/O).
      if (m && m.hash !== null) {
        const current = await this.bytes(join(this.path, m.path))
        if (hash(current) !== m.hash) {
          m.conflict = true
          continue
        }
      }
      if(!await installVaultFile(path,content,m?.hash??null)){if(m)m.conflict=true;this.warning='外部文件在保存期间变化，已保留原文件及历史，请整理后再同步';continue}
      if (m && m.path !== rel) {
        this.warning = '笔记路径发生变化，旧路径保留，避免误删外部文件'
      }
      const updated = { id: n.id, path: rel, hash: n.sha256, version: n.version, kind: n.kind, name: n.name, parentId: n.parentId, identity: (await vaultIdentity(path)).identity }
      if (m) Object.assign(m, updated)
      else this.mappings.push(updated)
    }
    // New Markdown files can be created in OB; configuration, symlinks and hidden files are excluded.
    const mapped = new Set(this.mappings.map((m) => m.path))
    let count = 0
    const walk = async (dir: string, parentId: string | null, depth: number): Promise<void> => {
      if (depth > 24) throw Error('工作区目录层级过深')
      for (const entry of await readdir(join(this.path, dir), { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
        if (++count > 10000) throw Error('工作区文件数量超过第一版上限')
        const rel = join(dir, entry.name)
        if (this.recycled(rel) || this.blocked(rel)) continue
        const m = this.mappings.find((m) => m.path === rel)
        if (entry.isDirectory()) {
          if (m) {
            await walk(rel, m.id, depth + 1)
          } else {
            // Only import folders that contain Markdown, not arbitrary application folders.
            if (![...snapshot.values()].some(x => x.path.startsWith(rel + sep) && !x.directory && /\.(md|markdown)$/i.test(x.path))) continue
            if (this.mappings.some(m => m.missing && !m.trash)) { this.warning = '存在待识别的移动或删除，新文件暂缓导入'; continue }
            const node = await this.notes.create('folder', entry.name, parentId, new Uint8Array())
            this.mappings.push({ id: node.id, path: rel, hash: null, version: node.version, kind: 'folder' })
            await this.persist()
            await walk(rel, node.id, depth + 1)
          }
        } else if (entry.isFile() && !mapped.has(rel) && /\.(md|markdown)$/i.test(entry.name)) {
          const entrySnapshot = snapshot.get(rel)
          if (!entrySnapshot || !this.stable(entrySnapshot)) continue
          if (this.mappings.some(m => m.missing && !m.trash)) { this.warning = '存在待识别的移动或删除，新文件暂缓导入'; continue }
          const bytes = await this.bytes(join(this.path, rel))
          if (hash(bytes) !== entrySnapshot.digest) continue
          const node = await this.notes.create('document', entry.name, parentId, bytes)
          this.mappings.push({ id: node.id, path: rel, hash: hash(bytes), version: node.version, kind: 'document' })
          this.record(node, rel, '外部文件新建')
          await this.persist()
        }
      }
    }
    await walk('', null, 0)
    for (const m of this.mappings) {
      if (m.trash || m.missing || m.conflict || m.pendingMove || this.blocked(m.path)) continue
      const n = nodes.find(n => n.id === m.id)
      if (n) { m.name ??= n.name; if (m.parentId === undefined) m.parentId = n.parentId }
      try { m.identity = (await vaultIdentity(join(this.path, m.path))).identity } catch { /* Next complete scan decides. */ }
    }
    await this.persist()
  }
  private async reconcileNativeDeletes(nodes: NoteNode[], snapshot: Map<string, VaultEntry>) {
    let changed = false
    for (const m of [...this.mappings].sort((a,b) => a.path.length - b.path.length)) {
      if (nodes.some(n => n.id === m.id) || !this.mappings.includes(m)) continue
      // Never treat a deleted parent as permission to archive a still-live child.
      const affected = this.mappings.filter(x => x.path === m.path || x.path.startsWith(m.path + sep))
      if (affected.some(x => nodes.some(n => n.id === x.id))) { m.conflict = true; continue }
      try {
        if (m.pendingMove && !m.pendingMove.to.includes(sep + '.dsh-deleted' + sep)) {
          await this.safe(m.pendingMove.stage, true); await this.safe(m.pendingMove.to, true); await this.safe(m.pendingMove.from, true)
          await moveVaultEntry(m.pendingMove, () => this.persist())
          const old = m.path, dest = relative(this.path, m.pendingMove.to)
          for (const child of affected) child.path = dest + child.path.slice(old.length)
          delete m.pendingMove
          await this.persist()
        }
        if (!m.pendingMove) {
          let entry: {identity: string; directory: boolean} | undefined = snapshot.get(m.path)
          if (!entry) {
            try { const actual = await vaultIdentity(join(this.path, m.path)); entry = {identity: actual.identity, directory: actual.stat.isDirectory()} }
            catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
          }
          if (entry) {
            const op = randomUUID()
            m.pendingMove = {from: join(this.path,m.path), to: join(this.path,'.dsh-deleted',op), stage: join(this.path,'.dsh-moves',op), identity: entry.identity, directory: entry.directory, name: m.name ?? basename(m.path), parentId: m.parentId ?? null}
            await this.persist()
          }
        }
        if (m.pendingMove) {
          await this.verifyRoot()
          await this.safe(m.pendingMove.from,true); await this.safe(m.pendingMove.to,true); await this.safe(m.pendingMove.stage,true)
          await mkdir(dirname(m.pendingMove.to), {recursive: true, mode: 0o700})
          await atomicWriteFile(m.pendingMove.to + '.json', JSON.stringify({noteId: m.id, originalPath: m.path, archivedAt: new Date().toISOString()}), {mode: 0o600})
          await moveVaultEntry(m.pendingMove, () => this.persist())
        }
        this.record(m, m.path, '原生删除：磁盘副本归档到 .dsh-deleted')
        this.mappings = this.mappings.filter(x => !affected.includes(x))
        await this.persist()
        changed = true
      } catch(e) { m.conflict = true; this.warning = e instanceof Error ? e.message : '原生删除归档失败，文件已保留' }
    }
    return changed
  }
  private nativeComponent(n: NoteNode) {
    const clean = n.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100) || '未命名'
    const ext = n.kind === 'document' ? /\.(md|markdown)$/i.test(clean) ? extname(clean) : '.md' : n.kind === 'file' ? extname(clean) : ''
    const stem = ext && clean.endsWith(ext) ? clean.slice(0, -ext.length) : clean
    return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem) ? `${stem} [${n.id.slice(5,13)}]${ext}` : stem + ext
  }
  private async reconcileNativePaths(nodes: NoteNode[], snapshot: Map<string, VaultEntry>) {
    let changed = false
    const wanted = (n: NoteNode, seen = new Set<string>()): string => {
      if (seen.has(n.id)) throw Error('笔记目录循环')
      seen.add(n.id)
      const parent = nodes.find(p => p.id === n.parentId)
      return parent ? join(wanted(parent, seen), this.nativeComponent(n)) : this.nativeComponent(n)
    }
    // Finish parents first; update descendant mappings as one journal write.
    const ordered = [...this.mappings].sort((a,b) => a.path.split(sep).length - b.path.split(sep).length)
    for (const m of ordered) {
      const n = nodes.find(n => n.id === m.id)
      if (!n || m.trash || this.recycled(m.path) || this.inTrash(n, nodes) || this.blockedDirectories.some(dir => m.path === dir || m.path.startsWith(dir + sep))) continue
      const target = wanted(n)
      if (!m.pendingMove && target === m.path) continue
      // An external rename has priority only when the native metadata did not change.
      if (!m.pendingMove && n.name === m.name && n.parentId === m.parentId && !snapshot.has(m.path)) continue
      // A parent move may have failed; do not pull its children out individually.
      if (this.mappings.some(p => p !== m && p.pendingMove && m.path.startsWith(p.path + sep))) continue
      try {
        if (!m.pendingMove) {
          const entry = snapshot.get(m.path)
          if (!entry) { m.conflict = true; continue }
          await this.safe(join(this.path, target), true)
          const op = randomUUID()
          m.pendingMove = {from: join(this.path, m.path), to: join(this.path, target), stage: join(this.path, dirname(m.path), '.dsh-moves', op), identity: entry.identity, directory: entry.directory, name: n.name, parentId: n.parentId}
          await this.persist()
        }
        const move = m.pendingMove
        await this.verifyRoot()
        await this.safe(move.from, true); await this.safe(move.to, true); await this.safe(move.stage, true)
        await moveVaultEntry(move, () => this.persist())
        const old = m.path, destination = relative(this.path, move.to)
        const affected = this.mappings.filter(child => child.path === old || move.directory && child.path.startsWith(old + sep))
        for (const child of affected) {
          child.path = destination + child.path.slice(old.length)
          child.missing = false; child.conflict = false
          delete child.missingSince; delete child.missingScans
        }
        m.name = move.name; m.parentId = move.parentId; m.identity = move.identity
        delete m.pendingMove
        this.record(n, destination, '原生改名或移动同步到文件')
        await this.persist()
        changed = true
      } catch(e) {
        m.conflict = true
        this.warning = e instanceof Error ? e.message : '原生路径同步失败，内容保留'
      }
    }
    return changed
  }
  private record(node: Pick<NoteNode, 'id' | 'version'>, path: string, action: string) {
    this.events.push({ id: node.id, version: node.version, path, action, time: new Date(this.timing.now()).toISOString() })
    this.events = this.events.slice(-500)
  }
  private stable(entry: VaultEntry) {
    const old = this.observations.get(entry.path), now = this.timing.now()
    if (!old || old.signature !== entry.signature) {
      this.observations.set(entry.path, {signature: entry.signature, since: now})
      return this.timing.stableMs === 0
    }
    return now - old.since >= this.timing.stableMs
  }
  private blocked(path: string) {
    return path.split(sep).some(part => part.startsWith('.')) || this.mappings.some(m => m.pendingMove && (path === m.path || path.startsWith(m.path + sep) || path === relative(this.path, m.pendingMove.to) || path.startsWith(relative(this.path, m.pendingMove.to) + sep))) || this.blockedDirectories.some(dir => path === dir || path.startsWith(dir + sep))
  }
  private recycled(path: string) {
    return this.mappings.some(m => m.trash && (path === m.path || path.startsWith(m.path + sep)))
  }
  private inTrash(node: NoteNode, nodes: NoteNode[]) {
    let parent = node.parentId
    const seen = new Set<string>()
    while (parent && !seen.has(parent)) {
      if (parent === this.trashFolder) return true
      seen.add(parent); parent = nodes.find(n => n.id === parent)?.parentId ?? null
    }
    return false
  }
  private async verifyRoot() {
    const sentinel = join(this.path, '.dsh-vault-id')
    if (!this.token) {
      // An established vault may be a missing mount. Never recreate it silently.
      if (!this.mappings.length) await mkdir(this.path, {recursive: true, mode: 0o700})
      await this.safe(this.path)
      const identity = await vaultIdentity(this.path)
      if (!identity.stat.isDirectory()) throw Error('工作区不是目录')
      for (const m of this.mappings) await this.safe(join(this.path, m.path))
      const token = randomUUID()
      try { await writeFile(sentinel, token, {flag: 'wx', mode: 0o600}); this.token = token }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
        await this.safe(sentinel)
        const existing = await readFile(sentinel, 'utf8')
        if (!/^[a-f0-9-]{36}$/.test(existing)) throw Error('工作区标识无效')
        this.token = existing
      }
      this.rootIdentity = identity.identity
      await this.persist()
    }
    await this.safe(sentinel)
    const root = await vaultIdentity(this.path)
    if (root.identity !== this.rootIdentity || await readFile(sentinel, 'utf8') !== this.token) throw Error('工作区挂载或标识发生变化，已暂停同步；请恢复原挂载')
    if (this.autoStart && !this.watcher) {
      try {
        this.watcher = watch(this.path, {recursive: true}, (_event, name) => {
          if (name && String(name).split(/[\\/]/).some(part => part.startsWith('.'))) return
          if (this.debounce) clearTimeout(this.debounce)
          this.debounce = setTimeout(() => { void this.scan() }, this.timing.stableMs + 100)
          this.debounce.unref()
        })
        this.watcher.on('error', () => { this.watcher?.close(); this.watcher = undefined })
        this.watcher.unref()
      } catch { /* Polling remains authoritative where recursive watch is unavailable. */ }
    }
  }
  private async ensureFolder(path: string, snapshot: Map<string, VaultEntry>): Promise<string | null> {
    if (path === '.' || path === '') return null
    const found = this.mappings.find(m => m.path === path && m.kind === 'folder' && !m.trash)
    if (found) return found.id
    const entry = snapshot.get(path)
    if (!entry?.directory) throw Error('目标目录不存在')
    await this.safe(join(this.path, path))
    const parent = await this.ensureFolder(dirname(path), snapshot)
    const node = await this.notes.create('folder', basename(path), parent, new Uint8Array())
    this.mappings.push({id: node.id, path, hash: null, version: node.version, kind: 'folder', name: node.name, parentId: parent, identity: entry.identity})
    await this.persist()
    return node.id
  }
  private async reconcilePaths(snapshot: Map<string, VaultEntry>, nodes: NoteNode[]) {
    for (const key of this.observations.keys()) if (!snapshot.has(key)) this.observations.delete(key)
    const missing = this.mappings.filter(m => !m.trash && !m.pendingMove && !this.recycled(m.path) && !this.blocked(m.path) && !snapshot.has(m.path))
    for (const m of missing) {
      m.missing = true
      m.missingSince ??= this.timing.now()
      m.missingScans = (m.missingScans ?? 0) + 1
    }
    const mapped = new Set(this.mappings.map(m => m.path))
    const fresh = [...snapshot.values()].filter(e => !mapped.has(e.path) && !this.recycled(e.path) && !this.blocked(e.path))
    // Parents first: a directory rename carries all descendants without losing note IDs.
    for (const m of missing.sort((a,b) => a.path.length - b.path.length)) {
      if (snapshot.has(m.path) || this.recycled(m.path)) continue
      if (missing.some(parent => parent !== m && parent.kind === 'folder' && m.path.startsWith(parent.path + sep) && !snapshot.has(parent.path))) continue
      const node = nodes.find(n => n.id === m.id)
      if (!node || !this.notes.relocate) continue
      let candidates = fresh.filter(e => !this.mappings.some(other => other.path === e.path) && e.directory === (m.kind === 'folder') && e.identity === m.identity)
      if (!candidates.length && m.kind !== 'folder') {
        candidates = fresh.filter(e => !e.directory && e.digest === m.hash)
        // Identical content alone cannot distinguish duplicated files.
        if (this.mappings.filter(x => x.hash === m.hash).length !== 1 || [...snapshot.values()].filter(e => e.digest === m.hash).length !== 1) candidates = []
      }
      if (candidates.length !== 1) continue
      const entry = candidates[0]!
      if (!this.stable(entry)) continue
      if (node.name !== (m.name ?? node.name) || node.parentId !== (m.parentId === undefined ? node.parentId : m.parentId)) { m.conflict = true; continue }
      // Do not remap a child to a path already owned by another note.
      const affected = this.mappings.filter(x => x.path === m.path || (m.kind === 'folder' && x.path.startsWith(m.path + sep)))
      const oldPath = m.path
      if (affected.some(x => this.mappings.some(other => !affected.includes(other) && other.path === entry.path + x.path.slice(oldPath.length)))) { m.conflict = true; continue }
      await this.verifyRoot()
      await this.safe(join(this.path, entry.path))
      if ((await vaultIdentity(join(this.path, entry.path))).identity !== entry.identity) continue
      const parentId = await this.ensureFolder(dirname(entry.path), snapshot)
      const updated = await this.notes.relocate(m.id, basename(entry.path), parentId, noteFingerprint(node)!)
      for (const child of affected) {
        child.path = entry.path + child.path.slice(oldPath.length)
        child.missing = false; delete child.missingSince; delete child.missingScans
      }
      m.name = updated.name; m.parentId = updated.parentId; m.identity = entry.identity; if (m.kind === 'folder' || m.hash === updated.sha256) m.version = updated.version; m.conflict = false
      Object.assign(node, updated)
      this.record(updated, entry.path, '外部文件改名或移动')
      await this.persist()
    }
    const remainingFresh = fresh.filter(e => !e.directory && !this.mappings.some(m => m.path === e.path))
    for (const m of missing) {
      if (snapshot.has(m.path) || this.recycled(m.path) || !m.missing || m.conflict) continue
      const node = nodes.find(n => n.id === m.id)
      if (!node || !this.notes.relocate) continue
      if ((m.missingScans ?? 0) < 3 || this.timing.now() - m.missingSince! < this.timing.missingMs) continue
      if (remainingFresh.length) { m.conflict = true; this.warning = '文件缺失且有未识别的新路径，请确认移动或删除'; continue }
      const affected = this.mappings.filter(x => x.path === m.path || x.path.startsWith(m.path + sep))
      if (affected.some(x => {
        const n = nodes.find(n => n.id === x.id)
        return !n || n.sha256 !== x.hash || n.version !== x.version || n.name !== (x.name ?? n.name) || n.parentId !== (x.parentId === undefined ? n.parentId : x.parentId) || snapshot.has(x.path)
      })) { m.conflict = true; continue }
      // New application children invalidate a folder deletion, even if not yet exported.
      if (m.kind === 'folder' && nodes.some(n => affected.some(x => x.id === n.parentId) && !affected.some(x => x.id === n.id))) { m.conflict = true; continue }
      await this.verifyRoot()
      try { await lstat(join(this.path, m.path)); continue } catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      if (!this.trashFolder || !nodes.some(n => n.id === this.trashFolder)) {
        const folder = await this.notes.create('folder', `回收站（外部文件）-${randomUUID().slice(0,8)}`, null, new Uint8Array())
        this.trashFolder = folder.id; nodes.push(folder); await this.persist()
      }
      // Intent is durable before the metadata mutation; retries use the original note ID.
      m.trash = {name: node.name, parentId: node.parentId, path: m.path, at: new Date(this.timing.now()).toISOString(), target: this.trashFolder}
      await this.persist()
      try {
        const updated = await this.notes.relocate(m.id, `${node.name.slice(0, 210)} [${node.id.slice(5,13)}]`, this.trashFolder, noteFingerprint(node)!)
        this.record(updated, m.path, '外部删除移入回收站')
      } catch(e) { delete m.trash; m.conflict = true; throw e }
      await this.persist()
    }
  }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    while (this.running) await this.running
    let result!: T
    const task = (async () => { result = await action() })()
    this.running = task
    try { await task; return result } finally { if (this.running === task) this.running = undefined }
  }
  async restore(id: string) { await this.exclusive(() => this.restoreNow(id)); await this.scan() }
  private async restoreNow(id: string) {
    const m = this.mappings.find(m => m.id === id)
    if (!m?.trash || !this.notes.relocate) throw syncError(404, '回收记录不存在')
    await this.verifyRoot()
    const nodes = await this.notes.all(), node = nodes.find(n => n.id === id), original = m.trash
    if (!node) throw syncError(404, '回收内容已不存在')
    if (original.parentId && !nodes.some(n => n.id === original.parentId && !this.inTrash(n, nodes))) throw syncError(409, '原目录已不存在，请先恢复父目录')
    const affected = this.mappings.filter(x => x.path === m.path || x.path.startsWith(m.path + sep))
    for (const child of affected.sort((a,b) => a.path.length - b.path.length)) {
      const target = join(this.path, child.path)
      await this.safe(target, true)
      if (child.kind === 'folder') { await mkdir(target, {recursive: true, mode: 0o700}); continue }
      const content = await this.notes.read(child.id)
      try {
        const existing = await this.bytes(target)
        if (hash(existing) !== content.node.sha256) throw syncError(409, '原路径已被占用，未覆盖；请先移开同名文件')
      } catch(e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
        await mkdir(dirname(target), {recursive: true, mode: 0o700})
        if (!await installVaultFile(target, content.content, null)) throw syncError(409, '恢复期间原路径被占用，未覆盖')
      }
      child.hash = content.node.sha256; child.version = content.node.version
    }
    const updated = node.parentId === original.target
      ? await this.notes.relocate(id, original.name, original.parentId, noteFingerprint(node)!) : node
    delete m.trash
    m.version = updated.version; m.name = updated.name; m.parentId = updated.parentId
    for (const child of affected) { child.missing = false; child.conflict = false; child.identity = (await vaultIdentity(join(this.path, child.path))).identity; delete child.missingSince; delete child.missingScans }
    this.record(updated, original.path, '恢复外部删除')
    await this.persist()
  }
  async conflictDetail(id: string) { return this.exclusive(() => this.detailNow(id)) }
  private async detailNow(id: string) {
    const m = this.mappings.find(m => m.id === id && !m.trash)
    if (!m) throw syncError(404, '外部文件记录不存在')
    await this.verifyRoot()
    const node = (await this.notes.all()).find(n => n.id === id)
    if (!node) throw syncError(404, '知识库笔记不存在')
    const current = node.kind === 'folder' ? {node, content: new Uint8Array()} : await this.notes.read(id)
    const snapshot = await snapshotVault(this.path)
    const candidates = [...snapshot.values()].filter(e => e.directory === (m.kind === 'folder') && !this.mappings.some(x => x.path === e.path)).slice(0, 100).map(e => ({path: e.path, signature: e.signature}))
    let external: Buffer | null = null
    try { if (node.kind !== 'folder') external = await this.bytes(join(this.path, m.path)) } catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    if (current.content.length > 1024 * 1024 || (external?.length ?? 0) > 1024 * 1024) throw syncError(413, '文件过大，请在编辑器中合并')
    if (!Buffer.from(Buffer.from(current.content).toString('utf8')).equals(Buffer.from(current.content)) || external && !Buffer.from(external.toString('utf8')).equals(external)) throw syncError(409, '文件不是有效 UTF-8，请用原编辑器处理，未转换内容')
    return {id, directory: node.kind === 'folder', candidates, path: m.path, version: current.node.version, fingerprint: noteFingerprint(current.node), externalHash: external ? hash(external) : null,
      applicationText: Buffer.from(current.content).toString('utf8'), externalText: external?.toString('utf8') ?? null}
  }
  async resolveExternal(id: string, choice: string, expected: string, externalHash: string | null) {
    await this.exclusive(() => this.resolveNow(id, choice, expected, externalHash)); await this.scan()
  }
  private async resolveNow(id: string, choice: string, expected: string, externalHash: string | null) {
    const detail = await this.detailNow(id)
    if (detail.fingerprint !== expected || detail.externalHash !== externalHash) throw syncError(409, '内容已变化，请重新查看再处理')
    const m = this.mappings.find(m => m.id === id)!
    if (detail.directory && choice === 'application') {
      const m = this.mappings.find(m => m.id === id)!
      const node = (await this.notes.all()).find(n => n.id === id)!
      m.trash = {name: node.name, parentId: node.parentId, path: m.path, at: new Date().toISOString(), target: ''}
      await this.persist()
      await this.restoreNow(id)
      return
    }
    if (choice === 'external') {
      if (detail.externalText === null) throw syncError(409, '外部文件不存在')
      const node = await this.notes.update(id, Buffer.from(detail.externalText), detail.version)
      m.hash = node.sha256; m.version = node.version
      this.record(node, m.path, '确认采用外部文件')
    } else if (choice === 'application') {
      await this.safe(join(this.path, m.path), true)
      await mkdir(dirname(join(this.path, m.path)), {recursive: true, mode: 0o700})
      if (!await installVaultFile(join(this.path, m.path), Buffer.from(detail.applicationText), externalHash)) throw syncError(409, '文件在确认期间发生变化，已保留')
      m.hash = hash(detail.applicationText); m.version = detail.version
    } else throw syncError(400, '请选择保留版本')
    m.conflict = false; m.missing = false; delete m.missingSince; delete m.missingScans
    await this.persist()
  }
  async linkExternalPath(id: string, path: string, signature: string, expected: string) {
    await this.exclusive(async () => {
      await this.verifyRoot()
      const m = this.mappings.find(m => m.id === id && !m.trash)
      const node = (await this.notes.all()).find(n => n.id === id)
      if (!m || !node || !this.notes.relocate || noteFingerprint(node) !== expected) throw syncError(409, '笔记已变化')
      const snapshot = await snapshotVault(this.path), entry = snapshot.get(path)
      if (!entry || entry.signature !== signature || entry.directory !== (node.kind === 'folder') || this.mappings.some(x => x.path === path) || snapshot.has(m.path)) throw syncError(409, '目标或原路径已变化，请重新选择')
      const parent = await this.ensureFolder(dirname(path), snapshot)
      const updated = await this.notes.relocate(id, basename(path), parent, expected)
      const old = m.path
      for (const child of this.mappings.filter(x => x.path === old || x.path.startsWith(old + sep))) {
        child.path = path + child.path.slice(old.length); child.missing = false; child.conflict = false
        delete child.missingSince; delete child.missingScans
      }
      m.name = updated.name; m.parentId = updated.parentId; m.identity = entry.identity
      this.record(updated, path, '用户确认外部移动路径')
      await this.persist()
    })
    await this.scan()
  }
  async close() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    if (this.debounce) clearTimeout(this.debounce)
    this.watcher?.close()
    await this.running
  }
}
