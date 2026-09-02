import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectSensitiveContent } from '../lib/content-safety.js'
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
  assert.equal(explicitlyRequestsKnowledgeNote('聊聊不停机设计', 'inspect'), false)
  assert.equal(explicitlyRequestsKnowledgeNote('请把这段内容保存到笔记文档。', 'create', 'document'), true)
  assert.equal(explicitlyRequestsKnowledgeNote('在笔记工作区建一个发布资料目录。', 'create', 'folder'), true)
  assert.equal(explicitlyRequestsKnowledgeNote('把项目笔记目录改名为归档。', 'update', 'folder'), true)
  assert.equal(explicitlyRequestsKnowledgeNote('删除这个笔记文件夹。', 'delete', 'folder'), true)
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
