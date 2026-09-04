import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectSensitiveContent } from '../lib/content-safety.js'
import { normalizeTrustedShareOrigins } from '../lib/config.js'
import { createPinnedLookup, resolveShareTarget } from '../lib/notes/share-import.js'
import { explicitlyRequestsKnowledgeBaseManagement, explicitlyRequestsKnowledgeNote } from '../lib/tool-authorization.js'

test('knowledge-base management authorization requires an explicit matching user operation', () => {
  assert.equal(explicitlyRequestsKnowledgeBaseManagement('请创建一个 SSH 资料知识库', 'create'), true)
  assert.equal(explicitlyRequestsKnowledgeBaseManagement('把 SSH 知识库的描述修改一下', 'update'), true)
  assert.equal(explicitlyRequestsKnowledgeBaseManagement('How should I design a knowledge base?', 'create'), false)
  assert.equal(explicitlyRequestsKnowledgeBaseManagement('不要创建知识库，只讨论设计', 'create'), false)
  assert.equal(explicitlyRequestsKnowledgeBaseManagement('Please update the knowledge base description.', 'update'), true)
  assert.equal(explicitlyRequestsKnowledgeBaseManagement('Please create a folder.', 'create'), false)
  assert.equal(explicitlyRequestsKnowledgeBaseManagement('给知识库添加两个标签', 'create'), false)
  assert.equal(explicitlyRequestsKnowledgeBaseManagement('给知识库添加两个标签', 'update'), true)
  assert.equal(explicitlyRequestsKnowledgeBaseManagement('不要修改现有知识库，请创建一个新知识库', 'create'), true)
  assert.equal(explicitlyRequestsKnowledgeBaseManagement('知识库不要创建，只调整现有描述', 'create'), false)
})

test('knowledge-note authorization understands documents and folders without widening to arbitrary files', () => {
  assert.equal(explicitlyRequestsKnowledgeNote('查询笔记文档', 'inspect'), true)
  assert.equal(explicitlyRequestsKnowledgeNote('我说的是笔记文档中的不停机文档', 'inspect'), true)
  assert.equal(explicitlyRequestsKnowledgeNote('笔记文档里的不停机文档', 'inspect'), true)
  assert.equal(explicitlyRequestsKnowledgeNote('聊聊不停机设计', 'inspect'), false)
  assert.equal(explicitlyRequestsKnowledgeNote('请把这段内容保存到笔记文档。', 'create', 'document'), true)
  assert.equal(explicitlyRequestsKnowledgeNote('笔记文档，内容整理成刚才确认的结论。', 'update', 'document'), true)
  assert.equal(explicitlyRequestsKnowledgeNote('笔记工作区的发布资料目录。', 'create', 'folder'), true)
  assert.equal(explicitlyRequestsKnowledgeNote('在笔记工作区建一个发布资料目录。', 'create', 'folder'), true)
  assert.equal(explicitlyRequestsKnowledgeNote('把项目笔记目录改名为归档。', 'update', 'folder'), true)
  assert.equal(explicitlyRequestsKnowledgeNote('删除这个笔记文件夹。', 'delete', 'folder'), true)
  assert.equal(explicitlyRequestsKnowledgeNote('这个笔记文档不用再关注。', 'delete', 'document'), false)
  assert.equal(explicitlyRequestsKnowledgeNote('请创建一个本地目录。', 'create', 'folder'), false)
  assert.equal(explicitlyRequestsKnowledgeNote('请新建一个 Markdown 文档。', 'create', 'document'), false)
  assert.equal(explicitlyRequestsKnowledgeNote('不要在笔记工作区创建目录。', 'create', 'folder'), false)
})

test('direct-write safety detects credentials without flagging documented placeholders', () => {
  assert.deepEqual(inspectSensitiveContent('password = ${SSH_PASSWORD}'), [])
  assert.deepEqual(inspectSensitiveContent('api_key: <YOUR_API_KEY>'), [])
  assert.deepEqual(inspectSensitiveContent('普通可复用的部署说明，不包含凭证。'), [])
  assert.deepEqual(inspectSensitiveContent('Authorization: Bearer abcdefghijklmnopqrstuvwxyz').map(item => item.kind), ['authorization-header'])
  assert.ok(inspectSensitiveContent('password: actual-secret-value').some(item => item.kind === 'credential-assignment'))
  assert.ok(inspectSensitiveContent('-----BEGIN OPENSSH PRIVATE KEY-----\nsecret').some(item => item.kind === 'private-key'))
  assert.ok(inspectSensitiveContent('remote=https://user:secret-value@example.com/repo').some(item => item.kind === 'embedded-url-credential'))
})

test('trusted share origins permit only exact DSH share resources through private DNS', async () => {
  const token = `share_${'a'.repeat(32)}`
  const privateLookup = async () => [{ address: '192.168.2.9', family: 4 }]
  const policy = { trustedPrivateOrigins: ['https://dsh.example.com:1443'] }
  assert.deepEqual(
    await resolveShareTarget(new URL(`https://dsh.example.com:1443/knowledge-api/v1/shared/${token}/manifest`), policy, privateLookup),
    { address: '192.168.2.9', family: 4 },
  )
  await assert.rejects(
    resolveShareTarget(new URL(`https://dsh.example.com/knowledge-api/v1/shared/${token}/manifest`), policy, privateLookup),
    /\u79c1\u6709\u7f51\u7edc/u,
  )
  await assert.rejects(
    resolveShareTarget(new URL('https://dsh.example.com:1443/knowledge-api/v1/search'), policy, privateLookup),
    /\u79c1\u6709\u7f51\u7edc/u,
  )
})

test('ordinary public share targets remain available without a trusted origin', async () => {
  const lookup = async () => [{ address: '8.8.8.8', family: 4 }]
  assert.deepEqual(
    await resolveShareTarget(new URL(`https://public.example.com/knowledge-api/v1/shared/share_${'b'.repeat(32)}`), {}, lookup),
    { address: '8.8.8.8', family: 4 },
  )
})

test('validated DNS targets remain pinned in single and Node 24 multi-address lookup modes', async () => {
  const lookup = createPinnedLookup({ address: '192.168.2.9', family: 4 })
  const single = await new Promise((resolve, reject) => lookup('dsh.example.com', { all: false }, (error, address, family) => {
    if (error) reject(error)
    else resolve({ address, family })
  }))
  const multiple = await new Promise((resolve, reject) => lookup('dsh.example.com', { all: true }, (error, addresses) => {
    if (error) reject(error)
    else resolve(addresses)
  }))
  assert.deepEqual(single, { address: '192.168.2.9', family: 4 })
  assert.deepEqual(multiple, [{ address: '192.168.2.9', family: 4 }])
})

test('trusted share origin configuration is exact and rejects local or literal hosts', () => {
  assert.deepEqual(normalizeTrustedShareOrigins([' https://dsh.example.com:1443 ', 'https://dsh.example.com:1443']), ['https://dsh.example.com:1443'])
  assert.throws(() => normalizeTrustedShareOrigins(['https://dsh.example.com/path']), /exact HTTP\(S\) origin/u)
  assert.throws(() => normalizeTrustedShareOrigins(['http://127.0.0.1:3080']), /DNS hostname/u)
  assert.throws(() => normalizeTrustedShareOrigins(['http://localhost:3080']), /DNS hostname/u)
})
