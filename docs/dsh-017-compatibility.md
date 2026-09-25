# DSH 0.1.7 客户端适配

以 0.1.7-rc.2 宿主的槽位、会话与设置机制为准；不修改 DSH 核心、槽位声明或权限校验。
0.1.5 及更早宿主由 2.10.1 覆盖，本版不做双版本运行时回退。

## 边界

五项宿主破坏性变更（均以 DSH 提交号锚定，首含版本见《DSH版本更新与运行时核查》；第五项由 web profile 运行时验收暴露）：

- **图标字重新名**（`4937343a5e`，0.1.7-alpha.1 起）：`client.tsx`、`knowledge-activity-panel.tsx`、`knowledge-activity-notes.tsx` 以 `XxxOutlineRegular as XxxOutline16` 别名导入 11 个图标，调用点与契约测试保持旧名；新名在 0.1.5 不存在，属单向迁移。
- **`conversation.chat.turnTail` chain→list**（`577e4a036d`，0.1.6-alpha.2 起）：注册带必填 `id: 'knowledge-writeback-status'`，状态条轮次从 `props.turn.turn`（`TurnTailOwnerProps.turn: TurnLocation`）读取，不再使用 chain 的 `select`/`matched`。
- **`SessionListState.current` 移除**（`6830e1460d`，0.1.6-alpha.2 起）：`knowledge-activity-state.ts` 新增 `deriveCurrentSession` —— 优先 `Object.entries(byId)` 找 `retainedBy.mainView > 0`（0.1.7 官方推导，`ui-session/index.ts:437-443` 同源），回退旧 `current` 字段；launcher、工作区、活动控制器（3 处）与停靠「等待会话提交」统一走该桥，`byId` 缺失时容错。
- **`settings.plugin.item` 退役**（`90af3110b7`，0.1.6-alpha.2 起）：连接卡片改注册 `settings.plugins.tab`（`id: 'knowledge'`、`order: 20`），该槽位在 0.1.5 与 0.1.7 均为 root list、注册选项一致（官方 `ui-settings-plugin-inventory` 两代同款写法）。
- **消息 source producer 化**（`fb79a944f5`，0.1.7 新增校验 `session-format-v3-to-v4/src/message-sources.ts`）：`agent/pre-step` 注入的 recall 消息与抽取请求消息原用 `{ kind: 'plugin', plugin: 'dsh-knowledge', form }`，0.1.7 对任何 durable 消息槽位拒绝 `'plugin'` 包装（"format v4 message requires a producer-owned source kind"，写入时拦截、整轮失败）。按官方 `producerKind` 规则改用 `kind: 'plugin:dsh-knowledge'`（保留 `form` 等非身份字段、去掉 `plugin` 字段）；`isKnowledgeSurfaceMessage` 的识别与清理同时兼容新旧形状，历史注入消息仍会被清出模型上下文。test profile 因未配置知识库挂载不触发注入，故未复现。

类型桥 `src/legacy-slots.d.ts`：按 DSH 官方声明合并扩展点（`interface SlotMap` "Owners extend via declaration merging"、`interface ILayout` "the ctx.layout face consumers type against"）回填旧宿主回退分支使用的 `SlotMap.conversation`/`SlotMap.details` 与 `ILayout.openDetails/closeDetails`。0.1.7 运行时不触达旧分支——`supportsDockedPanels` 仍以 `typeof layout.selectPanel === 'function'` 为唯一判据，与 0.1.5 适配一致。

开发依赖钉版 0.1.7-rc.2（新增 `dsh-client-ui-settings`，`PropsRuntime<'settings.plugins.tab'>` 的类型来源）；`dsh.client.inject` 10 包、`cordis.patch.yml`（insert + `!!js dshHomePath`）与 peer `^4.0.1`（DSH 0.1.7 自带 cordis 4.0.4）均不变。

## 验证范围

2026-09-25（0.1.7-rc.2 源码仓库与本机运行时）：

- `tsc --noEmit` 全绿；`npm run build` 通过（esbuild external 契约不变）。
- 186 项自动测试 168 项通过；18 项失败与 2.10.1 干净基线（git worktree 检出 HEAD + `npm ci`）完全一致 —— 本机 Windows 的 `stat.mode & 0o777 === 0o600` 权限位断言（2 项）与 SQLite 临时文件 EBUSY 锁（16 项），与升级无关。
- 契约测试同步修订：bundle 断言 `settings.plugin.item`/`key: KNOWLEDGE_SETTINGS_NAMESPACE` → `settings.plugins.tab`/`id: "knowledge"`/`knowledge-writeback-status`；其余断言（`IconFullscreenOutline16`、`name: "conversation"`、`details`、`openDetails` 等）经别名与类型桥原样保留。
- source producer 化修复后：`tsc --noEmit` 全绿、168/186 测试通过（失败集合仍为基线 18 项）；`plugin-runtime` 的历史消息 fixture 保持旧形状，作为新旧双兼容回归用例。最近 40 个会话文件无 `kind:"plugin"` 污染行——校验在写入时拦截、坏行从未落盘，修复部署后旧会话可直接继续。
- 浏览器运行时验收（图标渲染、停靠 tab 打开、设置标签页、回写状态条、pageerror=0、深浅主题）待安装后人工执行，清单见 `D:\Code\dsh-doc\dsh-knowledge-适配核查与升级方案.md` §5。

这不是生产升级记录。真实模型凭据、外部连接与数据迁移仍需升级前验收。
