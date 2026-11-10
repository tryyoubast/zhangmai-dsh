---
description: "面向 AI 小说草稿和长篇上下文的工作区隔离 PostgreSQL 服务。"
kind: "package-library"
---

# @deepseek-ai/dsh-novel-authoring

[English](README.md) | 中文

## 概述

调用方可以持久化工作区和小说、排队 AI 生成、保存人物与地点等草稿，并在独立审核后发布。生成重试复用已记录的上下文，章节和版本保存在 PostgreSQL 中。宿主提供认证身份、数据库、模型及外部存储适配器；模型只能返回固定实体类型的结构化草稿。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [当前限制](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

宿主通过 [公开导出](src/index.ts) 组合创作服务，并注入数据库、认证身份和生成适配器；本库没有独立的插件挂载项。

### 安全约定

用户服务可以排队生成任务并审核草稿。只有单独认证的 Agent 身份才能推进任务状态或写入提案和 `draft` 记录；Agent 不能审核、批准、发布或回滚内容。幂等键保证工作区内重试不会重复创建。正式发布必须经过独立的审核事务，执行工作区权限检查、提案与目标锁定、乐观版本校验和不可变审计。

服务只接受经过校验的结构化输入，不执行模型提供的 SQL 或 DDL；所有数据库操作都通过认证后的事务上下文执行。跨工作区输入会在持久化前拒绝，并由 PostgreSQL 约束和 RLS 再次强制隔离。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现细节 — 点击展开</summary>

本宿主侧包提供工作区与小说生命周期服务、固定实体草稿写入、提案审核／发布边界、章节／版本持久化和生成上下文记录。每次写入都使用认证身份与事务级 PostgreSQL RLS 上下文。

`NovelAuthoringService` 为已认证编辑者创建排队中的生成任务。单独组合的 Worker 身份负责创建提案，以及大纲、人物、技能、地点、阵营、物品、剧情线、人物技能关联、通用实体关系、章节摘要、世界观事实和时间线事件的幂等草稿。这些都是预先存在的版本化数据库表中的数据记录；模型不会创建 PostgreSQL 表。

`WorkspaceAuthoringService` 管理工作区和小说创建、成员邀请与撤销、角色变更、所有权转移以及归档／恢复。`ProposalReviewService` 将生成提案绑定到草稿目标，并支持批准、拒绝和重新打开。`ProposalPublicationService` 在审核者授权后调用数据库侧的发布与回滚事务。

`LongformAuthoringService` 持久化章节草稿、章节版本、摘要以及一次生成任务实际选用的上下文条目，包括提交给模型的原文片段和选取时的来源生命周期状态。它校验 SHA-256 和字节数：较小正文存储在 PostgreSQL 文本列，超过 1 MiB 的正文必须提供对象存储元数据。章节、摘要、事实、时间线和上下文记录持久化后，即使浏览器或服务重启，也能继续写作。

`LongformGenerationService` 提供与模型 Provider 无关的生成边界。它按工作区和小说检索候选上下文，排序并记录一次生成实际使用的上下文，校验结构化草稿输出，并通过幂等键去重重试。如果服务在上下文持久化后中断，重试会复用已记录的上下文，不会静默选择另一组内容。`DeepSeekNovelGenerationAdapter` 提供基于 fetch 的结构化 JSON 适配器，`GenerationMaterializationService` 将校验后的记录映射到固定草稿表并创建审核提案，`NovelGenerationWorkflowService` 负责生成任务生命周期、可选的生成后抽取、物化和安全失败码。宿主可以注入抽取适配器，把章节结果转成需要审核的摘要、事实和时间线草稿，模型仍然没有 SQL 权限。

`GenerationMaterializationService` 还会在当前进程复用已完成的结果，并让使用相同工作区、小说、生成任务和幂等键的并发重试共享同一个进行中的操作。失败操作不会被缓存为已完成。进程重启后，持久化 writer 和数据库幂等约束仍然是最终事实来源。

`isNovelDraftTargetType()` 为 HTTP 和物化调用方识别现有的固定草稿目标类型。Provider 数组遇到非法元素会拒绝整项响应，不会丢弃元素；物化在调用 writer 前校验原始目标和操作字段。可选的持久化锁方法通过仓库对象调用，可以依赖仓库实例状态。PostgreSQL 结果仓库通过所属连接池获取连接，并在锁事务完成后释放每个已获取的连接。

所有 AI 生成记录都使用针对工作区幂等约束的 `INSERT ... ON CONFLICT DO NOTHING RETURNING id`。并发冲突时，服务按同一个唯一键回读记录，并校验工作区、小说、生成任务和请求内容；记录一致则返回已有 ID，复用幂等键但内容不同则明确报错。带部分唯一索引的来源幂等键会使用 `IS NOT NULL` 冲突谓词。上下文条目先在内存中去重，再针对现有的 `(generationRunId, sourceType, sourceId)` 约束执行一次多行插入；只有缺失的冲突键才会通过一次查询回读，不一致的冲突会回滚整批写入。已有记录不会被更新，其他业务唯一约束冲突仍透传为数据库错误。

生成请求的 `limit: 0` 明确表示不检索也不保存上下文；如果后续需要根据已保存上下文继续生成，应使用大于零的限制值。

`PostgresNovelContextRepository` 是生产检索适配器。它在 `withRequestContext` 事务中读取大纲、章节、摘要、事实、时间线和小说实体，先使用每个来源的 GIN 表达式索引进行 PostgreSQL 全文匹配，再计算相关度排序，限制片段大小，并在写入新快照前校验哈希。重试和续写按原顺序重放数据库快照，不会再次读取来源实体。宿主仍需注入真实 LLM 适配器和持久化结果仓库；生产结果仓库必须实现 `withIdempotencyLock` 或等价的数据库级幂等声明/锁。

`validateNovelGenerationAdapterResult()` 校验后始终返回 `records` 与 `proposals` 两个数组；省略的数组归一为空数组。物化只分派共享类型守卫接受的目标类型。结果仓库在进入普通请求事务或已有幂等事务前，校验工作区和 agent 身份。

本包不发布不变量伴生模块，因为草稿归属、幂等性及发布条件由创作服务及其 Repository 事务直接保证。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [PostgreSQL 库](../../database/database-postgres/README.zh.md)：固定实体表与发布约束。
- [HTTP 适配器](../../api/novel-authoring-http/README.zh.md)：浏览器和 Worker 接入。

-----

<a id="model-experience"></a>
## 模型体验

### DeepSeek 结构化生成

#### What the model sees

`DeepSeekNovelGenerationAdapter` 发送下列固定系统指令，以及包含写作指令、工作区／小说／任务 ID、幂等键和选定上下文的用户 JSON。每个上下文条目包含来源身份、状态、哈希、token 计数及受字符上限约束的片段；API Key 只放在 HTTP Authorization header，不进入消息。

##### 固定系统指令

```markdown
Return only a JSON object with records and/or proposals. Use fixed target types, draft status only, and never return SQL, DDL, queries, migrations, credentials, or publication commands.
```

#### Token effect

每次实际 Provider 调用都包含固定指令和序列化后的动态输入。输入 token 随写作指令、上下文条目数量及片段长度增长；条目 tokenCount 不等于整个请求的精确 token 数，字符上限也不是模型 token 上限。重试重放已保存的片段，避免重新检索引入内容漂移。

#### KV Cache effect

固定系统消息保持稳定；用户 JSON 在指令、身份、任务、幂等键或上下文改变时发生变化。相同快照重放保留片段内容，但不保证跨任务前缀相同或缓存命中。KV cache 由 Provider 管理，本包不管理缓存或承诺命中率。

## 当前限制

<a id="known-limitations-and-deferred-work"></a>

- 本包不包含实际对象存储客户端、具体的摘要／事实抽取模型或 Web 审核界面。工作流提供可注入的抽取接口。DeepSeek 适配器需要宿主注入 API Key 并制定网络策略；提交对象存储元数据前，调用方必须先确保正文已成功保存。生成服务提供有界的确定性排序和精确上下文重放，但候选检索、部署路由和发布界面仍由调用方负责。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
