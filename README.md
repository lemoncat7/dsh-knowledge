# dsh-knowledge

`dsh-knowledge` 是面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的知识库插件。它不修改 DSH Agent Loop，同一个插件既能使用本地 SQLite，也能连接远程中央知识库。

当前版本 `0.4.0-alpha.3` 已实现可部署的多知识库与文档型 Web 管理台：

- 回答完成后同步调用 DSH 当前模型判断是否产生知识，并在回答下方显示逐库回写结果。
- 回写结果只作为 UI 状态展示，在下一次模型请求前会被移除，不占用会话上下文。
- 可创建多个知识库，分别设定说明、默认标签和提取要求。
- 每个知识库可选择专用回写模型；未设定时跟随当前会话模型。
- 项目和会话挂载；会话默认继承项目，也可独立覆盖或关闭。
- 每个挂载支持仅召回、审核写入、直接写入，以及包含/排除标签和额外提取要求。
- `create / update / conflict / skip` 提取决策；直写模式自动写入普通结果，冲突仍进入人工审核。
- 未挂载知识库时，不召回、不提取、不回写。
- 全局与项目范围，以及偏好、事实、决策、流程、经验五类知识。
- SQLite WAL、FTS5 全文搜索、原子事务、完整版本历史和幂等提取任务。
- 审核通过的知识在下一轮 `agent/pre-step` 中作为可追踪的 `recall` 上下文注入。
- 本地与远程 Provider 使用同一接口；远程模式不做隐式双向同步。
- Bearer Token 仅保存 SHA-256 摘要，支持 `read / propose / write / admin` 权限及吊销。
- 认证 HTTP API，可作为其他 DSH 客户端和未来桌面端的中央知识库。
- Apple 风格三栏文档界面，按知识库浏览自动整理的 `README.md`、`facts.md`、`decisions.md` 等文档。
- 知识库栏和文档栏可拖拽或用方向键调宽；DSH 内的管理窗口可缩放、最大化和还原。
- 随插件安装的响应式 Web 管理台，覆盖概览、文档浏览、条目维护、AI 候选审核和客户端令牌管理。
- DSH 浏览器端插件：在左侧工作区下方显示“知识库”，并在当前页面内打开管理面板。
- 明暗主题、键盘操作、窄屏布局以及不依赖颜色的状态标签。

## 安装

```bash
dsh plugin --profile web add ./lemoncat7-dsh-knowledge-0.4.0-alpha.3.tgz
```

卸载：

```bash
dsh plugin --profile web remove @lemoncat7/dsh-knowledge
```

插件是标准 DSH profile bundle：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`。安装后不需要单独运行知识库容器。

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
    autoRecallLimit: 5
    exposeApi: false
```

提取模型默认沿用刚完成回答的 provider/model。可在单个知识库中设置专用回写模型；以下全局配置仅作为兼容性后备：

```yaml
    extractionProvider: deepseek-official
    extractionModel: deepseek-chat
```

独立模型必须先在 DSH 的模型设置中注册。不论使用 Kimi 还是其他会话模型，首次超限后都会保持原 provider/model，用精简提示和低推理重试，不会暗中换模型。

提取输出达到模型上限时会自动用双倍预算重试一次（最高 8192 tokens）。其他提取失败会将幂等任务标为 `failed`，失败任务最多可重新领取两次，并在回答下方记录回写通知，不会阻断下一轮。

## 中央服务端

本地实例可以同时开放认证 API：

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

启用后访问 `http://<DSH 地址>:<端口>/knowledge`。管理台要求输入 API 令牌，令牌只保存在当前浏览器标签页的 `sessionStorage` 中，关闭标签页后自动清除。`exposeWeb` 必须与 `exposeApi` 一起启用，管理台和 API 均由 DSH 自身 WebServer 提供，不需要额外容器。

管理台功能：

- 查看准确的知识、候选和提取任务统计。
- 创建和编辑多个知识库，管理默认标签与提取要求。
- 管理当前项目挂载和会话覆盖，设定召回、写入模式与标签范围。
- 在三栏界面中搜索和阅读 Markdown 文档，并保留条目管理作为兼容入口。
- 查看 AI 提取依据，直接通过、编辑后通过或拒绝候选。
- 创建、查看和撤销客户端令牌；新令牌原文只显示一次。

知识库的 `description` 是回写路由描述：提取器只有在当前对话中的可复用知识符合该描述时，才能选择这个库。挂载只表示“可选”，不代表每次回答都要写入。`extractionInstructions` 用于在匹配后继续限定具体收录规则。

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
| GET | `/search` | read | FTS 检索 |
| GET/POST | `/knowledge-bases` | read/write | 知识库列表和创建 |
| GET/PUT/PATCH | `/knowledge-bases/:id` | read/write | 详情、完整替换和局部修改 |
| POST | `/knowledge-bases/:id/archive` | admin | 归档并关闭相关挂载 |
| POST | `/knowledge-bases/:id/restore` | admin | 恢复已归档知识库 |
| GET/POST/DELETE | `/mounts` | read/write | 挂载查询、更新和删除 |
| POST | `/mounts/bulk` | write | 事务型批量挂载与取消 |
| GET | `/mounts/resolve` | read | 解析项目继承与会话覆盖 |
| GET | `/documents` | read | 按知识库或正文搜索 Markdown 文档 |
| GET | `/documents/:id` | read | 读取单篇 Markdown 文档 |
| GET/POST | `/entries` | read/write | 列表和直接创建 |
| GET/PUT/DELETE | `/entries/:id` | read/write/admin | 详情、更新、彻底删除 |
| GET | `/entries/:id/versions` | read | 版本历史 |
| GET/POST | `/candidates` | read/propose | 候选列表和提交 |
| POST | `/candidates/:id/review` | write | 审核候选 |
| GET/POST/DELETE | `/tokens` | admin | 客户端令牌管理 |

路径均位于配置的 `apiPrefix` 下。创建令牌时，原始令牌只在响应中返回一次。

## 远程客户端

```yaml
- id: knowledge
  name: '@lemoncat7/dsh-knowledge'
  config:
    backend: remote
    remoteUrl: 'https://knowledge.example.com/knowledge-api/v1'
    remoteToken: !!js process.env.DSH_KNOWLEDGE_REMOTE_TOKEN
    extractionEnabled: true
    autoRecallLimit: 5
```

远程地址必须是 HTTPS；只有 `localhost` 和回环 IP 的测试地址允许 HTTP。普通客户端建议只分配 `read + propose` 权限。

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
