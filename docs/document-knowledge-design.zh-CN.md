# DSH Knowledge 文档型知识库设计

状态：演进设计记录。当前实现以 `docs/architecture.md` 为准：SQLite 负责事务、索引与版本权威状态；一个生效 Entry 语义上就是一篇主题 Markdown 文档，相关知识通过章节和增量合并进入同一文档，管理台采用“知识库树 + 文档编辑器”双栏结构。
参考：Nomifun Desktop 文档型知识库、DSH 插件现有多库/挂载/审核能力、Apple 桌面端信息架构原则

## 1. 结论

知识库以主题 Markdown 文档作为用户可见内容单位，不再把每个事实作为一级对象。

- 用户看到并维护的是知识库、目录和 Markdown 文档。
- 模型回写的是某篇文档中的一段新内容，而不是一张孤立知识卡片。
- 搜索与召回仍按标题、段落和标签切块，内部索引不暴露为满屏卡片。
- 待审核内容仍按提案逐条展示，因为审核对象需要明确的目标文档、变更内容和理由。
- 现有项目/会话挂载、每库回写模型、审核/直写模式继续保留。

这是一种“文档真源 + 段落索引 + 变更提案”的混合架构。

`0.4.0-alpha.3` 为了安全兼容已有召回与版本历史，暂时由已生效条目自动投影 Markdown 文档；用户已可以三栏浏览和搜索。后续迁移完成后再将 Markdown 目录切换为唯一内容真源。

## 2. 从 Nomifun 采用的设计

采用：

1. 一个知识库对应一个 Markdown 目录。
2. 目录和 `.md` 文件是可浏览、可编辑的知识内容。
3. 根 `README.md` 提供知识库摘要，目录树生成有界 TOC。
4. 回写模型输出 `knowledgeBaseId + relPath + content`。
5. 更新已有文档时只追加真正的新材料，不让模型重写整篇文档。
6. 文件写入采用目标锁、内容比对、原子替换和 CAS，避免并发覆盖人工编辑。
7. 会话只向模型暴露挂载知识库的摘要和 TOC，不把整个知识库塞进提示词。

不直接照搬：

1. DSH 保留审核写入；Nomifun 当前主线更偏直接写入。
2. DSH 保留每知识库独立回写模型，未指定时跟随当前会话模型。
3. DSH 保留知识库描述作为回写匹配规则。
4. DSH 需要原生远程 API，使其他客户端可连接中央知识服务。
5. DSH 的直接写入由服务端执行重复检测、兼容合并和冲突保护；冲突永远进入审核。

## 3. 内容与存储模型

### 3.1 知识库

```ts
interface KnowledgeBase {
  id: string
  name: string
  description: string              // 判断当前对话是否属于这个库
  defaultTags: string[]
  extractionInstructions: string
  storage: {
    kind: 'managed' | 'directory'
    rootPath: string
  }
  writebackRoute?: {
    provider: string
    model: string
  }                                 // 缺省即跟随当前会话模型
  status: 'active' | 'archived'
}
```

- `managed`：服务拥有目录，默认位于 `/data/knowledge/bases/{id}`，允许创建、重命名和删除文档。
- `directory`：引用用户已有的绝对路径，服务不删除目录结构，只在授权范围内编辑 Markdown。
- 远程客户端不直接访问文件路径，统一通过文档 API 操作。

### 3.2 文档

文件系统中的 `.md` 是内容真源；SQLite 保存注册信息、索引、版本和写入任务。

```ts
interface KnowledgeDocument {
  id: string
  knowledgeBaseId: string
  relPath: string                   // 例如 architecture/runtime.md
  title: string                     // 第一处 Markdown 标题，缺省取文件名
  content: string
  contentHash: string
  version: number
  size: number
  modifiedAt: string
}
```

内部派生表 `document_chunks` 按标题和段落切块，保存 FTS 文本、标签、类型、范围和来源。它用于召回，不作为用户界面的一级实体。

### 3.3 版本与提案

```ts
interface DocumentWriteProposal {
  id: string
  knowledgeBaseId: string
  relPath: string
  operation: 'create' | 'append' | 'conflict'
  baseContentHash?: string
  markdown: string                  // 仅新增内容
  reason: string
  confidence: number
  source: { sessionId: string; turn: number; messageId?: string }
  status: 'pending' | 'approved' | 'rejected'
}
```

- 创建文档：目标路径不存在时原子创建。
- 追加文档：读取现有内容，块级去重后追加，发布前验证 `baseContentHash`。
- 冲突：绝不自动写入，必须审核。
- 版本表保留每次创建、追加、人工编辑、归档的快照，支持查看和恢复。

## 4. 回写流程

```text
回答完成
  → 解析当前项目/会话挂载
  → 按有效回写模型分组
  → 每组加载知识库描述、README 摘要、TOC、相关文档片段
  → 模型判断是否值得收录并选择目标文档
  → 安全校验、去重、路径校验
  → 审核提案 或 直接追加
  → 在回答下方显示可点击的回写结果
```

### 4.1 模型选择

优先级固定为：

1. 知识库显式设置的 `writebackRoute`。
2. 旧版全局提取模型（只用于配置兼容，不在新部署中强制设置）。
3. 当前回答实际使用的会话模型。

同一轮挂载多个模型时按路由分组调用。每次调用只能看到本组知识库，防止写入错误目标。

### 4.2 Kimi 等推理模型的稳定性

- 首次调用使用原模型和配置预算，不偷换模型。
- `max-tokens` 时以更短的严格 JSON 提示重试。
- 重试使用 `reasoningEffort: low` 和最高 8192 输出预算。
- 模型不支持该参数时，只撤掉该参数重试，不切换 provider/model。
- 每组只提供有界 TOC 和相关片段，减少模型在路径选择上的推理消耗。
- 明确指定的模型不可用时显示失败，不静默换成其他模型。

### 4.3 模型输出

```json
{
  "candidates": [
    {
      "knowledgeBaseId": "kb-id",
      "relPath": "deployment/docker.md",
      "operation": "append",
      "markdown": "## 生产部署端口\n\n服务统一监听 3080。",
      "confidence": 0.93,
      "reason": "这是可跨会话复用的已确认部署约定"
    }
  ]
}
```

限制：

- 路径必须为库内相对 `.md` 路径，禁止绝对路径、路径穿越和隐藏系统目录。
- 内容必须是新增 Markdown，不允许要求模型返回整篇修改后的文件。
- 回写前后各执行一次凭据脱敏。
- 相同 Markdown 块已存在时视为幂等成功，不重复追加。
- 不以固定提案条数控制回写力度；严谨模式改用长期性和明确/已验证证据门槛。单提案和模型总输出仍受长度与 token 预算保护。

## 5. Apple 桌面端界面

主界面采用三栏 `NavigationSplitView` 思路，检查器按需展开。

```text
┌──────────────┬──────────────────────┬───────────────────────────────────┐
│ 知识库       │ 文档                 │ 项目规范 / deployment/docker.md  │
│              │                      │                                   │
│ ⌕ 搜索       │ ⌕ 搜索当前库         │ # Docker 部署                     │
│              │                      │                                   │
│ 智能列表     │ README.md            │ 正文阅读 / 编辑                    │
│  待审核  3   │ architecture/        │                                   │
│  最近更新    │   runtime.md         │                                   │
│              │ deployment/          │                                   │
│ 我的知识库   │   docker.md          │                                   │
│  项目规范    │                      │                                   │
│  个人偏好    │                      │                                   │
│              │                      │                                   │
│ ＋ 新建      │ ＋ 新建文档          │ 标签  历史  来源  ⋯               │
└──────────────┴──────────────────────┴───────────────────────────────────┘
```

### 5.1 第一栏：知识库导航

- 常驻全局搜索。
- 顶部智能列表：待审核、最近更新、已归档。
- 下方显示知识库名称、标签色点和文档数量。
- 单击切换知识库；上下方向键移动选择；回车打开。
- “挂载范围”作为工具栏按钮打开批量管理 Sheet，不与文档树混排。

### 5.2 第二栏：文档浏览器

- 默认显示目录树；可切换“树 / 最近更新”视图。
- 文件行显示标题、相对路径、更新时间；目录懒加载。
- 搜索匹配标题、路径、正文和标签。
- 支持新建文档/目录、重命名和移动。
- `README.md` 固定靠前，作为当前库的说明首页。
- 选择状态表现为整行填充 + 前导强调条，不能只靠颜色。

### 5.3 主区：文档阅读与编辑

- 默认阅读模式，工具栏切换编辑。
- Markdown 编辑器和预览不同时占用主区；需要时使用分栏预览。
- 标题、正文是一级内容；路径、标签、模型、范围、来源、版本放入可收起检查器。
- 自动保存前显示保存状态；外部文件发生变化时提供“重新加载 / 查看差异”，不直接覆盖。
- 窄窗口依次折叠检查器、文档栏；手机宽度使用逐级导航，不强挤三栏。

### 5.4 审核界面

审核是文档变更，不再是孤立知识卡片：

```text
目标：项目规范 / deployment/docker.md
操作：追加 1 个章节          置信度 93%

现有文档末尾
────────────────────────────
+ ## 生产部署端口
+ 服务统一监听 3080。

[拒绝] [编辑后通过] [通过]
```

创建文档显示完整预览；追加显示目标文档上下文和新增块；冲突显示双方内容。审核动作必须有清晰文字，不使用只有图标的关键按钮。

### 5.5 项目/会话批量挂载 Sheet

- 顶部分段控件切换“项目 / 会话”。
- 常驻搜索，可按已挂载、未挂载、继承项目、已关闭筛选。
- 列表行显示库名、描述、标签、回写模型和当前模式。
- 进入选择模式后显示复选框和固定批量操作栏。
- 批量挂载以事务提交；会话“恢复继承”删除显式覆盖，而不是写入关闭状态。
- 默认批量设置：召回开启、审核写入、标签过滤为空。

### 5.6 对话内回写反馈

回答下方显示单行、可展开状态：

```text
知识库回写  ·  项目规范 / deployment/docker.md  ·  待审核 1
```

- 点击打开对应提案或文档，不跳到无关首页。
- 提取中显示进度；无需收录、失败、部分成功均使用不同文案。
- 失败要显示实际模型和可重试入口，不能只有“失败”。

## 6. 文档 API

```http
GET    /knowledge-bases/:id/tree?path=
GET    /knowledge-bases/:id/documents/:path
PUT    /knowledge-bases/:id/documents/:path
DELETE /knowledge-bases/:id/documents/:path
POST   /knowledge-bases/:id/documents/move
GET    /knowledge-bases/:id/documents/:path/versions
POST   /knowledge-bases/:id/documents/:path/restore

GET    /writeback-proposals
POST   /writeback-proposals/:id/review

POST   /mounts/bulk
```

所有写文档请求带 `expectedContentHash`。哈希不一致返回 `409 Conflict` 并提供当前版本，客户端不得自动覆盖。

## 7. 现有数据迁移

当前生效知识迁移为文档：

1. 每个知识库创建 `README.md`。
2. 旧条目按类型写入 `migrated/preferences.md`、`facts.md`、`decisions.md`、`procedures.md`、`lessons.md`。
3. 每条旧知识变成一个二级标题段落，来源、标签、范围写入隐藏的结构化注释或内部 chunk 元数据。
4. 迁移完成前后核对条目数、正文哈希和知识库归属。
5. 旧表保留一个版本周期只读兼容，确认后再移除。

示例：

```md
# 决策

## Docker 服务监听端口

生产部署统一监听 3080。
```

迁移后新回写直接选择合适文档，不继续生成“一条知识一个文件”。

## 8. 分阶段实现

### 阶段 A：文档内核

- 文件存储适配器、路径安全、原子写、CAS、版本。
- 文档树/read/write API。
- 旧知识迁移和段落索引。

### 阶段 B：文档回写

- TOC/README 摘要。
- 每库模型分组。
- create/append/conflict 提案。
- Kimi 低推理重试、幂等追加和审核差异。

### 阶段 C：Apple 三栏 Web UI

- 知识库栏、文档栏、阅读编辑区、检查器。
- 审核变更视图。
- 搜索、键盘、焦点、明暗主题和响应式。

### 阶段 D：挂载与部署

- 事务型批量挂载 Sheet。
- DSH 会话入口和回写状态深链接。
- Docker 升级、迁移备份、远程客户端联调。

## 9. 本版验收标准

1. 用户日常浏览时看到文档和目录，不再看到满屏知识卡片。
2. 模型永远不能用回写覆盖整篇人工文档。
3. Kimi 或其他推理模型在首次超限后能用同一模型完成有界重试。
4. 每库模型为空时跟随会话，显式设置时只覆盖该库。
5. 十个以上知识库可以搜索并批量挂载，无逐库滚动操作。
6. 本地目录和远程服务使用同一套文档语义与 API。
7. 迁移前后的有效知识数量和内容可核对、可回滚。
8. 界面支持键盘导航、可见焦点、明暗主题和窄窗口折叠。
