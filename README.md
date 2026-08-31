# dsh-knowledge

[![npm](https://img.shields.io/npm/v/%40lemoncat7%2Fdsh-knowledge)](https://www.npmjs.com/package/@lemoncat7/dsh-knowledge)
[![GitHub Release](https://img.shields.io/github/v/release/lemoncat7/dsh-knowledge)](https://github.com/lemoncat7/dsh-knowledge/releases/latest)
[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

`dsh-knowledge` 是面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的知识库插件。它不修改 DSH Agent Loop，同一个插件既能使用本地 SQLite，也能连接远程中央知识库。

当前版本提供可部署的多知识库、按需检索工具、本地与远程中央服务、文档型 Web 管理台，以及全局回写策略与安全直写协调：

- 回答完成后同步调用 DSH 当前模型判断是否产生知识，并在回答下方显示逐库回写结果。
- 知识标题、正文、自然语言标签和提取理由默认跟随本轮用户语言；代码、命令和技术标识保持原样。
- 回写结果只作为 UI 状态展示，在下一次模型请求前会被移除，不占用会话上下文。
- 全局“严谨 / 主动”回写策略保存在权威知识库服务中；远程客户端自动跟随中央设置。严谨模式不限制候选数量，而是以长期价值和较高置信度为门槛，接受用户明确陈述以及带具体来源的可靠调研结论。
- 可创建多个知识库，分别设定说明、默认标签和提取要求。
- 每个知识库可选择专用回写模型；未设定时跟随当前会话模型。
- 项目和会话挂载；会话默认继承项目，也可独立覆盖或关闭。
- 每个挂载支持仅召回、审核写入、直接写入，以及包含/排除标签和额外提取要求。
- `create / update / conflict / skip` 文档变更决策；更新会明确区分“补充新内容”和“修订过时原文”，不再用追加文本冒充原文修改。
- 原文修订使用唯一旧文本锚点和目标版本，由服务端在完整文档上原子执行。无关并发补充可安全重放；同一区域已变化时才转为真实冲突并进入人工解决。
- 未挂载知识库时，不召回、不提取、不回写。
- 全局与项目范围，以及偏好、事实、决策、流程、经验五类知识。
- SQLite WAL、FTS5 全文搜索、原子事务、完整版本历史和幂等提取任务。
- 回答前通过 DSH 官方提示组装接口提供有界的挂载库地图，并自动召回最多 3 条达到相关性门槛的摘要；不自动注入完整文档。模型可继续按“`knowledge_base_search` 找库 → `knowledge_search` 搜索指定库 → `knowledge_read` 读取文档”的顺序核对完整内容。
- 内容回写完全独立于主 Agent：主模型不暴露 `knowledge_write`，普通沉淀和用户明确提出的“写入知识库”都在回答完整结束后由独立提取调用处理；正文不得叙述尝试、拒绝或结果，真实状态只显示在回答下方，也不追加伪用户消息。
- 用户明确要求时，模型可调用 `knowledge_base_create` 和 `knowledge_base_update` 创建或修改知识库，包括描述、标签、回写策略与专用回写模型；工具内部跟随当前 Provider 自动写入本地 SQLite 或远程中央服务，模型不传也不猜存储位置。
- 创建或修改工具不会自动挂载知识库，也不会回退、双写或同步到另一端；结果会明确返回实际写入的 `local` 或 `remote`。
- 搜索和读取由服务端按当前会话挂载、项目范围及包含/排除标签强制限权，读取句柄带签名且仅限当前会话。
- 本地与远程 Provider 使用同一接口；远程模式不做隐式双向同步。
- DSH“设置 → 插件”提供“知识库连接”卡片，可选择本地来源或填写中央服务地址和只写客户端令牌，保存后实时验证并切换 Provider。
- Bearer Token 仅保存 SHA-256 摘要，支持 `read / propose / write / admin` 权限及吊销。
- 认证 HTTP API，可作为其他 DSH 客户端和未来桌面端的中央知识库。
- 笔记软件式双栏文档界面：左侧以“知识库 → 文档”树形目录浏览和新建，右侧支持 Markdown 编辑与安全预览；目录按知识库懒加载并分页，只有打开文档时才读取正文。已有文档默认预览，新建文档默认编辑。
- 每个生效主题对应一篇真实 Markdown 文档；相似知识作为章节或增量内容写入同一文档。创建、改名、保存、归档和删除会同步 SQLite、全文索引、版本历史与物理文件。
- 独立的笔记工作区：在知识工作区上方提供可无限嵌套的目录树，支持 Markdown 与常见文本文件直接编辑，图片和 PDF 就地浏览，以及任意文件的拖拽移动、复制、重命名和下载。笔记默认不参与知识检索、自动召回或 AI 回写。
- 知识文档使用独立的“关联笔记”列表引用笔记文档或文件，正文不再插入引用语法。关系绑定稳定编号，笔记移动或改名不会失效；旧 `note://` 引用会在升级时安全回填为结构化关系。
- 用户明确要求时，AI 可使用 `knowledge_note_list / search / read / create / update / move / delete` 浏览和维护笔记工作区；所有目标都使用当前会话签名句柄，远程操作继续服从令牌权限，删除被知识文档引用的笔记会被拒绝。
- `knowledge_note_references` 单独负责查看、添加或移除知识文档与笔记的结构化关联，并在执行时重新检查知识挂载范围、写入模式和文档封存状态。
- 文档可标记为“已解决”或“已收集完成”。结束后的文档仍参与搜索和召回，但被服务端强制封存为只读；AI 回写、候选审核和人工编辑都必须先重新打开文档。
- 知识库管理拆分为“知识库”和“项目与会话挂载”两个工作区；支持按名称、描述、标签和模型即时搜索，避免知识库较多时逐张翻找。
- 随插件安装的响应式 Web 管理台，覆盖概览、文档树与编辑器、AI 候选审核和客户端令牌管理。
- DSH 浏览器端插件：在左侧工作区下方显示“知识库”，并在当前页面内打开管理面板。
- 明暗主题、键盘操作、窄屏布局以及不依赖颜色的状态标签。

## 安装

从 npm 安装正式版：

```bash
dsh plugin --profile web add @lemoncat7/dsh-knowledge
```

需要固定本次正式版本时：

```bash
dsh plugin --profile web add @lemoncat7/dsh-knowledge@1.0.2
```

也可以从 [GitHub Releases](https://github.com/lemoncat7/dsh-knowledge/releases) 下载对应版本的完整预构建包后安装：

```bash
dsh plugin --profile web add ./lemoncat7-dsh-knowledge-1.0.2.tgz
```

卸载：

```bash
dsh plugin --profile web remove @lemoncat7/dsh-knowledge
```

插件是标准 DSH profile bundle：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`。安装后不需要单独运行知识库容器。

安装或更新后请重启对应的 DSH profile。Web 版重启命令：

```bash
pnpm dsh web
```

## DSH 插件商店

本仓库符合 DSH 社区目录的安装要求：声明了 `dsh.bundle`、发布了 npm 预构建包，并使用 GitHub `dsh-plugin` Topic。目录收录完成后，可在 DSH 的插件市场搜索 `dsh-knowledge` 或“知识库”，安装源为 `@lemoncat7/dsh-knowledge`。

插件商店的数据来自 [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com)，不是单靠 npm 标签自动生成。若商店尚未刷新，可先使用上面的 npm 命令安装。

## 本地模式

默认配置使用 DSH 持久目录中的 SQLite 文件：

```yaml
- id: knowledge
  name: '@lemoncat7/dsh-knowledge'
  config:
    backend: local
    databasePath: !!js dshHomePath('knowledge/knowledge.sqlite')
    extractionEnabled: true
    defaultScope: project
    autoRecallLimit: 3
    autoRecallMinScore: 0.2
    recallMaxChars: 5000
    exposeApi: false
    exposeWeb: true
```

本地管理台默认开启。它使用独立的同源管理接口，不要求开放远程 API，也不要求输入访问令牌；侧栏“知识库”安装后即可使用。任何能访问 DSH Web 的用户都具有本地管理权限，因此把 DSH 暴露到公网时，应继续使用反向代理登录保护整个 DSH 站点。

提取模型默认沿用刚完成回答的 provider/model。可在单个知识库中设置专用回写模型；“本机回写模型”是当前客户端的最高优先级覆盖，适合中央知识库在不同客户端使用不同模型。实际优先级为：本机覆盖 → 知识库专用模型 → 当前会话模型 → 以下兼容性后备配置：

```yaml
    extractionProvider: deepseek-official
    extractionModel: deepseek-chat
```

独立模型必须先在 DSH 的模型设置中注册。不论使用 Kimi 还是其他会话模型，首次超限后都会保持原 provider/model，用精简提示和低推理重试，不会暗中换模型。

提取输出达到模型上限时会自动用双倍预算重试一次（最高 8192 tokens）。其他提取失败会将幂等任务标为 `failed`，失败任务最多可重新领取两次，并在回答下方记录回写通知，不会阻断下一轮。

## 中央服务端

需要作为中央知识库时，进入“知识库 → 访问管理”，点击“开启远程 API”。开关会持久化，页面会显示其他客户端应填写的完整 API 地址；然后为每台客户端创建独立令牌。已撤销令牌可以永久删除。

部署自动化仍可通过配置直接启用认证 API：

```yaml
    backend: local
    databasePath: !!js dshHomePath('knowledge/knowledge.sqlite')
    exposeApi: true
    apiToken: !!js process.env.DSH_KNOWLEDGE_API_TOKEN
    apiPrefix: /knowledge-api/v1
    exposeWeb: true
    webPath: /knowledge
```

`DSH_KNOWLEDGE_API_TOKEN` 至少 24 个字符。该值只用于创建或恢复 bootstrap admin 身份；数据库只保存摘要。服务端没有 TLS，非回环部署必须放在 HTTPS 反向代理之后。

启用后访问 `http://<DSH 地址>:<端口>/knowledge`。本地管理台使用同源管理权限；开放给其他客户端的 `apiPrefix` 仍强制要求 Bearer Token。管理台和 API 均由 DSH 自身 WebServer 提供，不需要额外容器。

管理台功能：

- 查看准确的知识、候选和提取任务统计。
- 创建和编辑多个知识库，管理默认标签与提取要求。
- 在知识库页切换全局“严谨 / 主动”回写策略。
- 管理当前项目挂载和会话覆盖，设定召回、写入模式与标签范围。
- 在左侧知识目录中搜索、新建和切换文档，在右侧进行 Markdown 编辑与安全预览；文档区域随窗口自适应，窄屏时知识目录切换为抽屉。
- 在“笔记工作区”中建立多级目录，直接编辑 Markdown、文本、JSON、YAML、代码和配置文件，并上传、拖放、复制、移动、搜索、就地浏览图片与 PDF；知识文档底部的“关联笔记”栏用于查看、打开、添加和移除资料关系。
- 查看 AI 提取依据和真实增删差异，直接通过、编辑最终文档后通过或拒绝候选。
- 创建、查看和撤销客户端令牌；新令牌原文只显示一次。

知识库的 `description` 同时用于读取和回写路由：它以轻量目录形式告诉模型每个挂载库覆盖什么主题，`knowledge_base_search` 也用它匹配当前信息需求；文档正文不会随目录注入。主模型不执行内容回写，所有回答都在完整结束后进行一次独立的严格提取，同时判断长期价值、目标知识库、重复、更新与冲突；用户明确要求保存时也走同一条回答后链路。挂载只表示“可选”，不代表每次回答都要写入。`extractionInstructions` 用于匹配后继续限定具体收录规则。

笔记工具与知识回写相互独立。AI 只有在当前用户直接要求查看或维护笔记时才能调用：先用 `knowledge_note_list` 浏览目录或按名称搜索，也可用 `knowledge_note_search` 查找非目录节点；随后把返回的精确句柄传给 `knowledge_note_read / update / move / delete`。`knowledge_note_create` 未指定父目录时写入笔记根目录，指定目录时必须使用 `knowledge_note_list` 返回的文件夹句柄。本地和远程模式由当前 Provider 决定，工具不接受也不猜测存储位置。

创建示例：

```json
{
  "draft": {
    "name": "DSH 项目规范",
    "description": "只匹配 DSH 插件开发、架构决策和部署规范相关对话",
    "defaultTags": ["dsh", "project-rule"],
    "extractionInstructions": "只收录已确认且可跨会话复用的结论"
  }
}
```

局部修改标签或描述时使用 `PATCH /knowledge-bases/:id`，请求体为 `{"patch":{"description":"...","defaultTags":["..."]}}`。

主要 API：

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | public | 健康检查 |
| GET/PUT | `/settings` | read/admin | 读取或修改全局回写策略 |
| GET | `/search` | read | FTS 检索 |
| GET/POST | `/knowledge-bases` | read/write | 知识库列表和创建 |
| GET/PUT/PATCH | `/knowledge-bases/:id` | read/write | 详情、完整替换和局部修改 |
| POST | `/knowledge-bases/:id/archive` | admin | 归档并关闭相关挂载 |
| POST | `/knowledge-bases/:id/restore` | admin | 恢复已归档知识库 |
| DELETE | `/knowledge-bases/:id` | admin | 永久删除已归档知识库及全部关联数据 |
| GET/POST/DELETE | `/mounts` | read/write | 挂载查询、更新和删除 |
| POST | `/mounts/bulk` | write | 事务型批量挂载与取消 |
| GET | `/mounts/resolve` | read | 解析项目继承与会话覆盖 |
| GET | `/documents` | read | 按知识库或正文搜索 Markdown 文档 |
| GET | `/document-index` | read | 分页读取不含正文的文档目录；支持 `knowledgeBaseId`、`q`、`limit` 和 `cursor` |
| GET | `/documents/:id` | read | 读取单篇 Markdown 文档 |
| POST | `/documents/:id/finalize` | write | 标记为已解决或已收集完成并封存 |
| POST | `/documents/:id/reopen` | write | 重新打开封存文档 |
| GET | `/notes` | read | 懒加载目录子节点，或使用 `q` 搜索全部笔记文档 |
| POST | `/notes/folders` | write | 在任意层级创建目录 |
| POST | `/notes/documents` | write | 创建可编辑的 Markdown 笔记文档 |
| POST | `/notes/files` | write | 上传原始文件；名称和父目录通过查询参数传入 |
| GET/PATCH/DELETE | `/notes/:id` | read/write/admin | 读取元数据、重命名或移动、递归删除 |
| POST | `/notes/:id/copy` | write | 复制文档、文件或完整目录树 |
| GET/PUT | `/notes/:id/content` | read/write | 读取文件内容，或保存 Markdown 与受支持的文本文件；支持 `?download=1` |
| GET | `/notes/:id/references` | read | 列出引用该节点或其目录后代的知识文档 |
| GET/POST | `/entries` | read/write | 列表和直接创建 |
| GET/PUT/DELETE | `/entries/:id` | read/write/admin | 详情、更新、彻底删除 |
| GET/POST | `/entries/:id/note-references` | read/write | 查看或添加结构化笔记关联 |
| DELETE | `/entries/:id/note-references/:noteId` | write | 移除一项笔记关联 |
| GET | `/entries/:id/versions` | read | 版本历史 |
| GET/POST | `/candidates` | read/propose | 候选列表和提交 |
| POST | `/candidates/direct` | propose + write | 原子直写、兼容合并、重复跳过和冲突转审 |
| POST | `/candidates/:id/review` | write | 审核候选 |
| GET/POST/DELETE | `/tokens` | admin | 客户端令牌管理 |

路径均位于配置的 `apiPrefix` 下。创建令牌时，原始令牌只在响应中返回一次。

笔记文件上传使用请求体原始字节，不使用 Base64 或 multipart；单文件上限为 64 MiB。目录和文件元数据与知识 SQLite 分开保存在 `notes/notes.sqlite`，内容按稳定编号保存在 `notes/objects/`。知识库删除或归档不会删除笔记；仍被知识文档引用的节点及其上级目录默认禁止删除。

## 远程客户端

先在中央实例的“知识库 → 客户端令牌”中为每台客户端分别创建令牌。普通 DSH 客户端建议选择 `read + propose`。`write` 是当前中央服务的全局写权限，同时允许直接写入知识、管理知识库、挂载和笔记；只在客户端确实需要这些能力时授予。令牌原文只显示一次。

其他 DSH 客户端安装本插件后，打开“设置 → 插件 → 知识库连接”，选择“远程”，填写中央实例的知识库 API 地址和客户端令牌，再点“验证并连接”。插件会先验证地址和令牌，成功后立即热切换，并把连接持久化到 DSH 数据目录；令牌不会在页面或控制接口中回显，只能覆盖。

侧栏“知识库”入口会先通过控制接口确认当前实例是否启用了管理台，确认后才加载管理页面。管理台默认随本地模式启用；只有 profile 显式设置 `exposeWeb: false` 时才关闭。入口不会把未注册的 `/knowledge` 误交给 DSH Web 主页面，因此不会触发 `dsh-plugin-desktop` 参数错误。

如需用配置文件或环境变量部署，也可以直接设置 Provider：

```yaml
- id: knowledge
  name: '@lemoncat7/dsh-knowledge'
  config:
    backend: remote
    remoteUrl: 'https://knowledge.example.com/knowledge-api/v1'
    remoteToken: !!js process.env.DSH_KNOWLEDGE_REMOTE_TOKEN
    extractionEnabled: true
```

远程地址必须是 HTTPS；只有 `localhost` 和回环 IP 的测试地址允许 HTTP。普通客户端建议只分配 `read + propose` 权限。
远程客户端连接的是中央库，不会复制或同步一份本地数据库；断网时无法召回或回写。侧栏管理台仍在当前 DSH 内打开，插件通过同源代理携带已保存的远程令牌访问中央 API，不使用跨域 iframe，也不会把令牌交给浏览器。远程模式隐藏“访问管理”，API 开关和客户端令牌仍由中央 DSH 管理。每台客户端仍需用自己的项目/会话标识挂载所需知识库。

## 开发与 Docker 构建

要求 Node.js `^22.19.0 || >=24.0.0`。

```bash
npm install
npm test
npm run pack:check
```

推荐使用 Node 24 Docker 环境编译、测试并输出 tarball：

```bash
docker build \
  --build-arg NODE_IMAGE=docker.1ms.run/library/node:24-bookworm-slim \
  --target artifact \
  --output type=local,dest=dist .
```

架构和一致性设计见 [docs/architecture.md](docs/architecture.md)，首版产品边界见 [docs/requirements.md](docs/requirements.md)，文档型演进设计见 [docs/document-knowledge-design.zh-CN.md](docs/document-knowledge-design.zh-CN.md)。

本项目采用 MIT License。
