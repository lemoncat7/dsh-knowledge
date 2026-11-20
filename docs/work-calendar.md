# 工作日历

「工作记录」下有两个独立功能：「工作日历」和「工作日报」。分别通过左侧导航进入各自页面；原有 view=worklog 链接仍打开日报，view=calendar 打开日历。日历用于手工或通过 AI 记录每天目标；未指定时间时创建全天目标，也可安排跨日时段。月视图浏览日期分布，周视图浏览时间安排；手机按日期查看当天清单。支持进度、优先级、标签、关联项目、编辑改期、回收站和 iCalendar 文件导出。日历不自动执行目标，不发送提醒，不调用模型生成计划。

数据与日报分别保存，使用相同的工作记录 SQLite 文件和当前知识库连接。远程连接失败不会静默写到本地。数据不自动加入模型上下文，AI 按需查询。界面仅在可见时每 15 秒检查更新，离开日历后停止。

点开已保存的目标后，可在独立的「每日进度」弹窗查看、补写、编辑和删除每一天的进度。结转后的目标默认补写结转前一天，前后条目共用记录。编辑进度保留它所属的日期。创建日期显示最初创建目标的日期。开启「安排具体时段」后，开始和结束各用一个日期时间输入框，两者并排。

## AI 与 API

统一 `knowledge` 工具的 `knowledge_calendar` 操作包含 `info/list/read/create/update/delete/restore/changes/export/progress-read/progress-write`。先 `info` 获取日历身份与时区，再查指定日期范围。`list` 的 `from` 包含当天，`to` 不包含当天，最大 370 天；支持状态、标签、关键词和分页。

写操作均需唯一 `requestId`；网络结果不确定时必须在原连接以相同编号和相同参数重试。更新、删除和恢复需要当前 `revision`，冲突需重读。可传 `calendarId` 防止在切换后的连接上误写。`create` 传 `event`，`update` 传 `patch`。日期使用 YYYY-MM-DD；全天 `endDay` 为不含当天的结束日期，默认下一天；定时条目必须提供带 UTC 偏移的 `startAt/endAt`，使用 IANA `timeZone`。界面显示全天结束日期为包含当天。

每日进度通过 `progress-read` 传 `id` 和 `day` 读取，通过 `progress-write` 传相同日期、读取到的 `revision`、`text` 和 `requestId` 保存。空白记录的修订号为 0。AI 可以在获得授权后引用日报中的已有进展补记，日历不会在后台自动读取日报填充。

删除仅产生可恢复墓碑，无永久删除接口，不与笔记的覆盖/永久删除确认流程混用。目标完成状态以真实反馈为准，不从聊天中臆测完成。工具不会获得外部日历账号凭据。Bearer API 读取需要 read，写操作需要 write；界面沿用 DSH 认证与来源校验。

HTTP 路径在知识库 API `/worklog/` 下：GET `calendar-info`、`calendar`、`calendar-event`、`calendar-changes`、`calendar-export`、`calendar-progress`、`calendar-progress-history`，POST `calendar-create`、`calendar-update`、`calendar-delete`、`calendar-restore`、`calendar-progress-write`。浏览器认证入口为 `/worklog-control/v1/` 下同名路径。

## 外部日历预留

`@lemoncat7/dsh-knowledge/calendar` 导出 `CalendarProviderAdapter` 等类型。条目有稳定 `uid`、递增 `revision` 和变更游标，删除也记录在增量里。`changes` 的非零 `after` 必须同时提交原 `calendarId`，不能跨连接复用游标。适配器约定支持远端 etag 冲突、持久同步游标与幂等操作编号。

本版没有 Google/iCloud OAuth、CalDAV 同步任务或双向同步。导出 `.ics` 可用于其他日历手工导入；不等于订阅或自动同步。后续接入需另行实现账号认证、远端映射、重试/冲突处理、游标过期恢复和循环事件策略。暂不支持循环规则、邀请、提醒或附件。
