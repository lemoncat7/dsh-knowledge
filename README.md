# dsh-knowledge

`dsh-knowledge` 是面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的知识库插件。它不修改 DSH Agent Loop，同一个插件既能使用本地 SQLite，也能连接远程中央知识库。

当前版本 `0.2.0-alpha.3` 已实现可部署的知识库与 Web 管理台：

- 回答成功完成后，异步调用 DSH 当前模型判断是否产生知识候选。
- `create / update / conflict / skip` 提取决策；非 `skip` 内容默认等待人工审核。
- 全局与项目范围，以及偏好、事实、决策、流程、经验五类知识。
- SQLite WAL、FTS5 全文搜索、原子事务、完整版本历史和幂等提取任务。
- 审核通过的知识在下一轮 `agent/pre-step` 中作为可追踪的 `recall` 上下文注入。
- 本地与远程 Provider 使用同一接口；远程模式不做隐式双向同步。
- Bearer Token 仅保存 SHA-256 摘要，支持 `read / propose / write / admin` 权限及吊销。
- 认证 HTTP API，可作为其他 DSH 客户端和未来桌面端的中央知识库。
- 随插件安装的响应式 Web 管理台，覆盖概览、知识维护、AI 候选审核和客户端令牌管理。
- 明暗主题、键盘操作、窄屏布局以及不依赖颜色的状态标签。

## 安装

```bash
dsh plugin --profile web add ./lemoncat7-dsh-knowledge-0.2.0-alpha.3.tgz
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

提取模型默认沿用刚完成回答的 provider/model。也可以为知识提取指定独立模型：

```yaml
    extractionProvider: deepseek-official
    extractionModel: deepseek-chat
```

提取失败只会将幂等任务标为 `failed` 并写日志，不会改变原会话，也不会阻断下一轮。

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
- 检索、筛选、新建、编辑、归档知识并查看版本历史。
- 查看 AI 提取依据，直接通过、编辑后通过或拒绝候选。
- 创建、查看和撤销客户端令牌；新令牌原文只显示一次。

主要 API：

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | public | 健康检查 |
| GET | `/search` | read | FTS 检索 |
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

架构和一致性设计见 [docs/architecture.md](docs/architecture.md)，首版产品边界见 [docs/requirements.md](docs/requirements.md)。

本项目采用 MIT License。
