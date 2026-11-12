# DSH Knowledge

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的知识库、笔记与工作日报插件。支持本地使用和远程中央知识库，不修改 DSH Agent Loop。

[![npm](https://img.shields.io/npm/v/%40lemoncat7%2Fdsh-knowledge)](https://www.npmjs.com/package/@lemoncat7/dsh-knowledge)

## 功能

- 知识库与文档分组、全文检索、项目和会话挂载，按权限召回与回写。
- 会话只暴露一个 `knowledge` 工具入口，按需发现、查看参数和执行 19 项知识库／笔记操作；不改变挂载和确认权限。见[统一工具入口](docs/tool-entry.md)。
- 回答完成后在后台独立提取知识，提供审核、版本历史、冲突保护、任务重试与文档封存。
- 独立笔记文档与目录：编辑、预览、分享、历史恢复；输入框 `@` 可搜索并引用笔记文档。
- 内置工作日报：按本机工作目录选择采集范围，可显式包含子目录；支持补记、整理与导出，默认开启每天 23:30 的保底整理，可独立关闭，补充当天新增素材（按日报时区）。
- 本地 SQLite 或认证的中央知识服务，多个客户端可连接同一服务。

## 安装

当前版本 **2.19.5**，支持 DeepSeek Harness **0.2.2-rc.1 / 0.2.2-rc.2**，需要 Node.js **>=24.9.0**。rc2 隔离验证结果见[兼容说明](docs/compatibility-0.2.2-rc.2.md)。本版制品包含上述兼容声明。

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

### 2.17.2

新建笔记/目录及批量创建免确认；修改与删除已有内容仍需确认。详见 [版本说明](docs/releases/2.17.2.md)。

## 2.18.0 笔记离线副本与本地文件

笔记工作区增加远程补同步和可供 Obsidian 打开的 Markdown 目录。支持范围、冲突规则和 schema 升级注意事项见 [说明](docs/note-workspace-sync.md)。


## DSH 0.2.2 兼容性

当前版本 **2.19.5**，支持 DeepSeek Harness **0.2.2-rc.1 / 0.2.2-rc.2**，需要 Node.js **>=24.9.0**。rc2 隔离验证结果见[兼容说明](docs/compatibility-0.2.2-rc.2.md)。本版制品包含上述兼容声明。
