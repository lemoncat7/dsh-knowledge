# dsh-knowledge

`dsh-knowledge` 是面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的可安装知识库插件。

当前状态：仓库与标准 DSH bundle 骨架已经建立，知识提取、持久化、远程接口和管理界面尚未实现。首个可用版本发布前请勿用于生产数据。

## 产品目标

- 每次助手回答完成后异步判断本轮内容是否值得收录，不阻塞下一轮对话。
- 与已有知识比较，并生成“跳过、新增、更新、冲突”结果。
- 新增、更新和冲突先进入待审核区，审核通过后才参与召回。
- 支持全局和项目范围，项目知识优先于全局知识。
- 支持用户偏好、事实背景、决策约束、操作流程和经验结论等类型。
- 自动召回少量相关知识，同时提供显式搜索能力。
- 同一个插件支持本地 SQLite 与远程知识库两种后端。
- 本地后端可选择开放认证接口，由其他 DSH 客户端或未来桌面端连接。

完整的首版需求见 [docs/requirements.md](docs/requirements.md)。

## DSH 插件形式

本项目遵循 DSH profile bundle 规则：`package.json` 通过 `dsh.bundle.patch` 声明配置层，`cordis.patch.yml` 将插件行加入目标 profile。功能通过 Cordis 服务、事件和界面扩展点提供，不修改 DSH Agent Loop。

计划发布后可安装到 Web profile：

```bash
dsh plugin --profile web add @lemoncat7/dsh-knowledge
```

卸载：

```bash
dsh plugin --profile web remove @lemoncat7/dsh-knowledge
```

## 配置模型

服务端使用本地 SQLite，并按需开放远程接口：

```yaml
- id: knowledge
  config:
    backend: local
    databasePath: !!js dshHomePath('knowledge/knowledge.sqlite')
    exposeApi: true
    apiToken: !!js process.env.DSH_KNOWLEDGE_API_TOKEN
```

其他客户端连接服务端知识库：

```yaml
- id: knowledge
  config:
    backend: remote
    remoteUrl: 'https://example.com/knowledge-api'
    remoteToken: !!js process.env.DSH_KNOWLEDGE_REMOTE_TOKEN
    exposeApi: false
```

令牌不得写入仓库或 Docker 镜像。

## 开发

要求 Node.js `^22.19.0 || >=24.0.0`。

```bash
npm install
npm test
npm run pack:check
```

推荐使用 Docker 的 Node.js 24 环境编译，并把可安装的 `.tgz` 输出到 `dist/`：

```bash
docker build --target artifact --output type=local,dest=dist .
```

Docker Hub 不可达时，可以通过构建参数选择兼容镜像代理：

```bash
docker build \
  --build-arg NODE_IMAGE=docker.1ms.run/library/node:24-bookworm-slim \
  --target artifact \
  --output type=local,dest=dist .
```

生成的 tarball 可通过 `dsh plugin --profile web add ./dist/<文件名>.tgz` 安装。Docker 只负责构建插件包；插件运行时仍随 DSH 应用加载，不需要单独的知识库容器。

本项目采用 MIT License。
