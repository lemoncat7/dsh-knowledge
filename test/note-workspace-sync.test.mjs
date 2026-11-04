import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, readdir, mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { NoteStore } from '../lib/notes/store.js'
import { NoteReplica } from '../lib/notes/replica.js'
import { NoteVault } from '../lib/notes/vault.js'
import { noteFingerprint, treeFingerprint } from '../lib/notes/sync-protocol.js'
const bytes = (s) => Buffer.from(s)
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'note-workspace-')),
    server = new NoteStore(join(root, 'server'))
  let online = true,
    loseReply = false
  const transport = async (path, method, body) => {
    if (!online) throw Error('offline')
    if (path === 'note-sync') {
      if (method === 'POST') {
        const result = server.applySyncChange('client', body)
        if (loseReply) {
          loseReply = false
          throw Error('response lost')
        }
        return result
      }
      return server.syncManifest()
    }
    return (await server.read(path.split('/')[1])).content
  }
  const path = join(root, 'client.sqlite')
  let client = new NoteReplica(path, transport, false)
  t.after(async () => {
    await client.close()
    await server.close()
    await rm(root, { recursive: true, force: true })
  })
  return {
    root,
    server,
    get client() {
      return client
    },
    offline: () => (online = false),
    online: () => (online = true),
    loseReply: () => (loseReply = true),
    restart: async () => {
      await client.close()
      client = new NoteReplica(path, transport, false)
    },
  }
}
test('offline create survives restart; lost response is reconciled without duplicate', async (t) => {
  const f = await fixture(t)
  await f.client.sync()
  f.offline()
  const n = await f.client.create('document', '离线.md', null, bytes('正文'))
  await f.client.sync()
  assert.equal(f.client.status().pending, 1)
  await f.restart()
  assert.equal(f.client.read(n.id).content.toString(), '正文')
  f.online()
  f.loseReply()
  await f.client.sync()
  assert.equal(f.server.syncManifest().nodes.length, 1)
  assert.equal(f.client.status().pending, 1)
  await f.restart()
  await f.client.sync()
  assert.equal(f.client.status().pending, 0)
  assert.equal(f.server.syncManifest().nodes.length, 1)
  assert.equal((await f.server.read(n.id)).content.toString(), '正文')
})
test('two-sided edits are preserved and conflict confirmation is version-bound', async (t) => {
  const f = await fixture(t),
    n = await f.server.createDocument('test', null, 'base')
  await f.client.sync()
  f.offline()
  await f.client.change(n.id, { content: bytes('local') }, 1)
  await f.client.sync()
  await f.server.updateContent(n.id, bytes('remote'))
  f.online()
  await f.client.sync()
  assert.equal(f.client.status().conflicts.length, 1)
  assert.equal(f.client.read(n.id).content.toString(), 'local')
  assert.equal((await f.server.read(n.id)).content.toString(), 'remote')
  const detail = await f.client.conflictDetail(n.id)
  await f.server.updateContent(n.id, bytes('newer'))
  await assert.rejects(() => f.client.resolve(n.id, 'local', detail.remoteFingerprint, detail.localVersion), /变化/)
  const next = await f.client.conflictDetail(n.id)
  await f.client.resolve(n.id, 'remote', next.remoteFingerprint, next.localVersion)
  await f.client.sync()
  assert.equal(f.client.read(n.id).content.toString(), 'newer')
  assert.ok(f.client.versions(n.id).some((v) => f.client.readVersion(n.id, v.version).content.toString() === 'local'))
})
test('subtree deletion is atomic and rejects newly created remote children', async (t) => {
  const f = await fixture(t),
    dir = await f.server.createFolder('dir'),
    n = await f.server.createDocument('a', dir.id, 'a')
  await f.client.sync()
  f.offline()
  await f.client.delete(dir.id)
  await f.client.sync()
  await f.server.createDocument('new', dir.id, 'new')
  f.online()
  await f.client.sync()
  assert.equal(f.client.status().conflicts.length, 1)
  assert.equal(f.server.subtree(dir.id).length, 3)
  assert.ok(f.server.get(n.id))
  const detail = await f.client.conflictDetail(dir.id)
  await f.client.resolve(dir.id, 'remote', detail.remoteFingerprint, detail.localVersion)
  await f.client.sync()
  assert.equal(f.client.all().length, 3)
  await f.client.delete(dir.id)
  await f.client.sync()
  assert.equal(f.server.syncManifest().nodes.length, 0)
  assert.equal(f.client.status().pending, 0)
})
test('server receipt, content and history persist atomically and remain readable by ordinary tools', async (t) => {
  const f = await fixture(t),
    n = await f.server.createDocument('a', null, 'original')
  const change = {
    instance: f.server.syncManifest().instance,
    operationId: randomUUID(),
    id: n.id,
    base: noteFingerprint(n),
    value: {
      kind: n.kind,
      name: n.name,
      parentId: null,
      mediaType: n.mediaType,
      content: bytes('sync').toString('base64'),
    },
  }
  const result = f.server.applySyncChange('client', change)
  assert.deepEqual(f.server.applySyncChange('client', change), result)
  assert.equal((await f.server.read(n.id)).content.toString(), 'sync')
  assert.equal((await f.server.readPreview(n.id, 2)).content.toString(), 'sy')
  assert.equal((await f.server.readVersion(n.id, 2)).content.toString(), 'sync')
  await f.server.updateContent(n.id, bytes('normal'), 2)
  assert.equal((await f.server.read(n.id)).content.toString(), 'normal')
  assert.equal((await f.server.readVersion(n.id, 2)).content.toString(), 'sync')
  assert.throws(
    () =>
      f.server.applySyncChange('client', {
        ...change,
        value: { ...change.value, content: bytes('changed').toString('base64') },
      }),
    /reused/,
  )
})
test('remote database replacement refuses to upload local drafts', async (t) => {
  const f = await fixture(t)
  await f.client.sync()
  f.offline()
  await f.client.create('document', 'draft', null, bytes('private'))
  await f.client.sync()
  const old = f.server.syncManifest.bind(f.server)
  f.server.syncManifest = () => ({ ...old(), instance: randomUUID() })
  f.online()
  await f.client.sync()
  assert.equal(f.client.status().state, 'blocked')
  assert.equal(f.server.syncManifest().nodes.length, 0)
})
test('Markdown vault supports OB-style atomic saves, imports, ignores app files and preserves conflicts', async (t) => {
  const f = await fixture(t),
    n = await f.server.createDocument('中文笔记', null, '# hello\n')
  const dir = join(f.root, 'vault')
  const vault = new NoteVault(
    dir,
    {
      all: () => f.server.syncManifest().nodes,
      read: (id) => f.server.read(id),
      update: (id, b, v) => f.server.updateContent(id, b, v),
      create: (k, n, p, b) =>
        k === 'folder' ? f.server.createFolder(n, p) : f.server.createDocument(n, p, b.toString()),
    },
    join(f.root, 'vault-index.json'),
    false,
    {stableMs:0, missingMs:30000, now:()=>Date.now()},
  )
  t.after(() => vault.close())
  await vault.scan()
  const filename = (await readdir(dir)).find(name=>!name.startsWith('.'))
  assert.match(filename, /\.md$/)
  assert.equal(await readFile(join(dir, filename), 'utf8'), '# hello\n')
  await writeFile(join(dir, filename), 'OB edited')
  await vault.scan()
  assert.equal((await f.server.read(n.id)).content.toString(), 'OB edited')
  await mkdir(join(dir, '.obsidian'))
  await writeFile(join(dir, '.obsidian', 'config.md'), 'ignore')
  await writeFile(join(dir, '新建.md'), 'new doc')
  await vault.scan()
  assert.equal(f.server.syncManifest().nodes.length, 2)
  await vault.scan()
  assert.equal(f.server.syncManifest().nodes.length, 2)
  await writeFile(join(dir, filename), 'external conflict')
  await f.server.updateContent(n.id, bytes('web conflict'))
  await vault.scan()
  assert.equal(await readFile(join(dir, filename), 'utf8'), 'external conflict')
  assert.equal((await f.server.read(n.id)).content.toString(), 'web conflict')
  assert.equal(vault.status().externalConflicts, 1)
})
test('vault refuses symlinks and external removal never deletes the source note', async (t) => {
  const f = await fixture(t),
    n = await f.server.createDocument('keep', null, 'kept'),
    dir = join(f.root, 'vault')
  const v = new NoteVault(
    dir,
    {
      all: () => f.server.syncManifest().nodes,
      read: (id) => f.server.read(id),
      update: (id, b, v) => f.server.updateContent(id, b, v),
      create: (k, n, p, b) => f.server.createDocument(n, p, b.toString()),
    },
    join(f.root, 'index.json'),
    false,
  )
  t.after(() => v.close())
  await v.scan()
  const file = join(dir, (await readdir(dir)).find(name=>!name.startsWith('.')))
  await rm(file)
  await v.scan()
  assert.ok(f.server.get(n.id))
  assert.equal(v.status().externalMissing, 1)
  await symlink('/etc/passwd', file)
  await v.scan()
  assert.match(v.status().warning, /符号链接/)
  assert.equal((await f.server.read(n.id)).content.toString(), 'kept')
})

test('slow remote downloads do not block local saves or overwrite edits made during pull', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'note-slow-pull-')),
    server = new NoteStore(join(root, 'server'))
  let release,
    started,
    delay = false
  const entered = new Promise((r) => (started = r)),
    gate = new Promise((r) => (release = r))
  const transport = async (path, method, body) => {
    if (path === 'note-sync') return method === 'POST' ? server.applySyncChange('client', body) : server.syncManifest()
    const result = await server.read(path.split('/')[1])
    if (delay) {
      delay = false
      started()
      await gate
    }
    return result.content
  }
  const client = new NoteReplica(join(root, 'client.sqlite'), transport, false)
  t.after(async () => {
    release()
    await client.close()
    await server.close()
    await rm(root, { recursive: true, force: true })
  })
  const n = await server.createDocument('test', null, 'base')
  await client.sync()
  await server.updateContent(n.id, bytes('remote'))
  delay = true
  const pull = client.sync()
  await entered
  try {
    await Promise.race([
      client.change(n.id, { content: bytes('local while downloading') }, client.get(n.id).version),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(Error('local save blocked on network')), 1000)
        timer.unref()
      }),
    ])
  } finally {
    release()
  }
  await pull
  assert.equal(client.read(n.id).content.toString(), 'local while downloading')
  assert.equal((await server.read(n.id)).content.toString(), 'remote')
  assert.equal(client.status().conflicts.length, 1)
})

test('sync-created empty documents and folders survive a server restart', async (t) => {
  const f = await fixture(t)
  await f.client.sync()
  const folder = await f.client.create('folder', 'empty')
  await f.client.sync()
  const n = await f.client.create('document', 'blank', folder.id, bytes(''))
  await f.client.sync()
  assert.equal(f.client.status().pending, 0)
  await f.server.close()
  const reopened = new NoteStore(join(f.root, 'server'))
  t.after(() => reopened.close())
  assert.equal((await reopened.read(n.id)).content.length, 0)
  assert.equal(reopened.get(folder.id).kind, 'folder')
})


test('vault output keeps previous inodes and refuses a changed external file',async t=>{
 const {installVaultFile}=await import('../lib/notes/vault-file.js')
 const {hash}=await import('../lib/notes/sync-protocol.js')
 const root=await mkdtemp(join(tmpdir(),'vault-exclusive-')),file=join(root,'文档.md');t.after(()=>rm(root,{recursive:true,force:true}))
 assert.equal(await installVaultFile(file,bytes('first'),null),true)
 assert.equal(await installVaultFile(file,bytes('must not overwrite'),null),false)
 assert.equal(await readFile(file,'utf8'),'first')
 await writeFile(file,'external change')
 assert.equal(await installVaultFile(file,bytes('stale web'),hash(bytes('first'))),false)
 assert.equal(await readFile(file,'utf8'),'external change')
 assert.equal(await installVaultFile(file,bytes('new web'),hash(bytes('external change'))),true)
 assert.equal(await readFile(file,'utf8'),'new web')
 const history=await readdir(join(root,'.dsh-history'));assert.ok(history.length>=2)
 assert.ok((await Promise.all(history.map(n=>readFile(join(root,'.dsh-history',n),'utf8')))).includes('external change'))
})

test('long ASCII and multibyte filenames remain editable and their histories stay within filename limits',async t=>{
 const {installVaultFile}=await import('../lib/notes/vault-file.js');const{hash}=await import('../lib/notes/sync-protocol.js')
 const root=await mkdtemp(join(tmpdir(),'vault-long-name-'));t.after(()=>rm(root,{recursive:true,force:true}))
 for(const name of ['x'.repeat(220)+'.md','文'.repeat(80)+'.md']){
  const path=join(root,name);await writeFile(path,'old');assert.equal(await installVaultFile(path,bytes('new'),hash('old')),true);assert.equal(await readFile(path,'utf8'),'new')
 }
 const history=await readdir(join(root,'.dsh-history'));assert.equal(history.length,2);assert.ok(history.every(name=>Buffer.byteLength(name)<=255));for(const name of history)assert.equal(await readFile(join(root,'.dsh-history',name),'utf8'),'old')
})

test('a failed temporary write keeps the original and removes the incomplete file',async t=>{
 const {installVaultFile}=await import('../lib/notes/vault-file.js');const{hash}=await import('../lib/notes/sync-protocol.js');const{open}=await import('node:fs/promises')
 const root=await mkdtemp(join(tmpdir(),'vault-write-failure-'));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'note.md');await writeFile(path,'original')
 const handle=await open(path,'r');const prototype=Object.getPrototypeOf(handle),original=prototype.writeFile;await handle.close()
 prototype.writeFile=async function(){throw Object.assign(Error('simulated disk full'),{code:'ENOSPC'})}
 try{await assert.rejects(()=>installVaultFile(path,bytes('replacement'),hash('original')),e=>e.code==='ENOSPC')}finally{prototype.writeFile=original}
 assert.equal(await readFile(path,'utf8'),'original');assert.deepEqual(await readdir(root),['note.md'])
})
test('remote web rename, move and delete reach the client vault without editing on the client', async t => {
  const f = await fixture(t)
  const source = await f.server.createFolder('原目录'), target = await f.server.createFolder('目标目录')
  const note = await f.server.createDocument('原笔记', source.id, '正文')
  await f.client.sync()
  const path = join(f.root, 'remote-client-vault')
  const vault = new NoteVault(path, {
    all: () => f.client.all(), read: id => f.client.read(id), readVersion: (id,v) => f.client.readVersion(id,v),
    update: (id,b,v) => f.client.change(id,{content:b},v), create: (k,n,p,b) => f.client.create(k,n,p,b),
    relocate: (id,name,parentId,expected) => f.client.change(id,{name,parentId},undefined,expected),
  },join(f.root,'remote-client-index.json'),false,{stableMs:0,missingMs:30000,now:()=>Date.now()})
  t.after(()=>vault.close())
  await vault.scan()
  assert.equal(await readFile(join(path,'原目录/原笔记.md'),'utf8'),'正文')
  f.server.rename(note.id,'改名.md');f.server.move(note.id,target.id)
  await f.client.sync();await vault.scan()
  assert.equal(await readFile(join(path,'目标目录/改名.md'),'utf8'),'正文')
  await assert.rejects(readFile(join(path,'原目录/原笔记.md')))
  f.server.rename(target.id,'移动后的目录')
  await f.client.sync();await vault.scan()
  assert.equal(await readFile(join(path,'移动后的目录/改名.md'),'utf8'),'正文')
  await f.server.delete(note.id);await f.client.sync();await vault.scan()
  await assert.rejects(readFile(join(path,'移动后的目录/改名.md')))
  assert.equal(vault.status().externalConflicts,0)
})
