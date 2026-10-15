# DSH Knowledge

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的知识库、笔记与工作日报插件。支持本地使用和远程中央知识库，不修改 DSH Agent Loop。

[![npm](https://img.shields.io/npm/v/%40lemoncat7%2Fdsh-knowledge)](https://www.npmjs.com/package/@lemoncat7/dsh-knowledge)

## 功能

- 知识库与文档分组、全文检索、项目和会话挂载，按权限召回与回写。
- 回答完成后在后台独立提取知识，提供审核、版本历史、冲突保护、任务重试与文档封存。
- 独立笔记文档与目录：编辑、预览、分享、历史恢复；输入框 `@` 可搜索并引用笔记文档。
- 内置工作日报：按本机工作目录选择采集范围，可显式包含子目录；支持补记、整理与导出。
- 本地 SQLite 或认证的中央知识服务，多个客户端可连接同一服务。

## 安装

适配 DeepSeek Harness **0.2.0-rc.2**（宿主仍为 RC），需要 Node.js **^22.19.0 或 >=24.0.0**。其他宿主版本请先查阅[兼容说明](docs/dsh-020-compatibility.md)和对应版本的发布说明。

```bash
dsh plugin --profile web add @lemoncat7/dsh-knowledge@latest
```

安装或升级后重启对应的 DSH Profile；`web` 请按实际使用的 Profile 调整。

打开侧栏「知识库」创建知识库，在「项目与会话挂载」选择使用范围和写入模式。笔记不需要先挂载知识库；工作日报在「工作记录」中单独开启采集。

## 使用边界

未挂载知识库不召回、不回写。笔记默认不参与知识自动回写，引用笔记不授予修改或删除权限；修改按工具确认流程执行。日报采集默认关闭，不补采历史会话。远程模式不做隐式双向同步；公开访问应配置认证，升级前备份数据。

## 文档

- [使用、权限与部署配置](docs/usage.md)
- [文档分组](docs/document-groups.md)
- [笔记 @ 引用](docs/note-mentions.md)
- [版本与发布说明](https://github.com/lemoncat7/dsh-knowledge/releases)
- [发布维护约定](docs/releases/README.md)
