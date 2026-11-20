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

`PostgresGenerationWorkerIdentity` 接受仅 Worker 角色的数据库连接池与宿主配置的智能体身份。`resolve({ workspaceId, generationRunId })` 通过[仅 Worker 可调用的数据库查询](../../database/database-postgres/README.zh.md) 恢复发起用户、有效来源会话、当前写入角色、小说和任务状态。权限不可用时返回 null，数据库失败时拒绝。身份中固定的 `official-client` 类型表示 Worker 执行方式，不表示来源会话的传输类型。宿主在调用前验证队列定位符 UUID 与智能体配置；队列消息绝不提供用户、会话或角色。解析不会领取任务，也不授权后续投递；每次投递都在原子领取前重新解析。

`NovelAuthoringService` 为已认证编辑者创建排队中的生成任务。单独组合的 Worker 身份负责创建提案，以及大纲、人物、技能、地点、阵营、物品、剧情线、人物技能关联、通用实体关系、章节摘要、世界观事实和时间线事件的幂等草稿。这些都是预先存在的版本化数据库表中的数据记录；模型不会创建 PostgreSQL 表。

人类使用同一工作区幂等键重试生成时，只要小说、发起用户、来源会话、模型、提示词版本、指令和上下文数量仍一致，即使任务已分配给 Worker 或执行完成，也返回已有任务 ID。Worker 归属是可变的执行状态；智能体重试还必须匹配自身绑定身份。不可变输入不同则拒绝，且不改变持久化任务。[幂等写入决策](../../../.agents/notes/implemented/bug-fix/2026-10-29-atomic-ai-idempotent-draft-writes.zh.md) 说明了这项区别。

`WorkspaceAuthoringService` 管理工作区和小说创建、成员邀请与撤销、角色变更、所有权转移以及归档／恢复。`ProposalReviewService` 将生成提案绑定到草稿目标，并支持批准、拒绝和重新打开。`ProposalPublicationService` 在审核者授权后调用数据库侧的发布与回滚事务。

版本化实体的每个提案在现有版本表中拥有独立候选，通过 `source_type = 'generation_proposal'` 和 `source_id = proposal.id` 标识。PostgreSQL 在提案事务中创建并同步候选。多个候选可共享实体和基础版本；只有非 draft 历史占用版本号。拒绝和过期的候选保留存储，不阻塞其他候选或回滚。发布胜出者仅推进一次当前版本；竞争失败或基于回滚前旧版本的候选返回 `kind: 'conflict'` 的 `ProposalOperationError`。回滚追加新的已发布版本并保留历史。章节等长文本目标支持首次创建发布，不支持这些实体更新／回滚操作。[候选决策](../../../.agents/notes/implemented/bug-fix/2026-11-12-proposal-bound-publication.zh.md) 说明锁与迁移的取舍。

`PostgresWorkspaceIdentity` 使用 app 运行时读取已认证用户在数据库中的当前成员角色。宿主仅在成功登录后调用 `onboard(userId)`，并在普通会话验证后调用 `resolve(userId, workspaceHint?)`。初始化仅在不存在任何历史成员记录时，通过事务级用户锁创建一个个人工作区。已撤销或不可用的历史成员记录阻止重建；显式工作区提示不可用时返回 null，不回退到其他工作区。登录和刷新优先使用活跃成员关系，也可向归档工作区的现任 owner 或 admin 签发凭据。归档成员关系只能用于显式恢复该工作区；普通创作仍要求活跃成员关系。此服务不认证会话。工作区创建先写入生成的 UUID，再写入所有者成员记录，两次写入之间不要求 SELECT 可见性。

`LongformAuthoringService` 持久化章节草稿、章节版本、摘要以及一次生成任务实际选用的上下文条目，包括提交给模型的原文片段和选取时的来源生命周期状态。它校验 SHA-256 和字节数：较小正文存储在 PostgreSQL 文本列，超过 1 MiB 的正文必须提供对象存储元数据。章节、摘要、事实、时间线和上下文记录持久化后，即使浏览器或服务重启，也能继续写作。

`LongformGenerationService` 提供与模型 Provider 无关的生成边界。它按工作区和小说检索候选上下文，排序并记录一次生成实际使用的上下文，校验结构化草稿输出，并通过幂等键去重重试。如果服务在上下文持久化后中断，重试会复用已记录的上下文，不会静默选择另一组内容。`DeepSeekNovelGenerationAdapter` 提供基于 fetch 的结构化 JSON 适配器，`GenerationMaterializationService` 将校验后的记录映射到固定草稿表并创建审核提案，`NovelGenerationWorkflowService` 负责生成任务生命周期、可选的生成后抽取、物化和安全失败码。宿主可以注入抽取适配器，把章节结果转成需要审核的摘要、事实和时间线草稿，模型仍然没有 SQL 权限。

`GenerationMaterializationService` 还会在当前进程复用已完成的结果，并让使用相同工作区、小说、生成任务和幂等键的并发重试共享同一个进行中的操作。失败操作不会被缓存为已完成。进程重启后，持久化 writer 和数据库幂等约束仍然是最终事实来源。

章节版本物化在调用草稿 writer 前省略未使用的正文或对象键字段，保留两种存储方式互斥的校验。提案 JSON 继续为缺省存储字段保存规范的 null，可空摘要也保留 null。[存储字段决策](../../../.agents/notes/implemented/bug-fix/2026-11-11-chapter-storage-materialization.zh.md) 记录了这项区别。

`isNovelDraftTargetType()` 为 HTTP 和物化调用方识别现有的固定草稿目标类型。Provider 数组遇到非法元素会拒绝整项响应，不会丢弃元素；物化在调用 writer 前校验原始目标和操作字段。可选的持久化锁方法通过仓库对象调用，可以依赖仓库实例状态。PostgreSQL 结果仓库通过所属连接池获取连接，并在锁事务完成后释放每个已获取的连接。

所有 AI 生成记录都使用针对工作区幂等约束的 `INSERT ... ON CONFLICT DO NOTHING RETURNING id`。并发冲突时，服务按同一个唯一键回读记录，并校验工作区、小说、生成任务和请求内容；记录一致则返回已有 ID，复用幂等键但内容不同则明确报错。带部分唯一索引的来源幂等键会使用 `IS NOT NULL` 冲突谓词。上下文条目先在内存中去重，再针对现有的 `(generationRunId, sourceType, sourceId)` 约束执行一次多行插入；只有缺失的冲突键才会通过一次查询回读，不一致的冲突会回滚整批写入。已有记录不会被更新，其他业务唯一约束冲突仍透传为数据库错误。

生成请求的 `limit: 0` 明确表示不检索也不保存上下文；如果后续需要根据已保存上下文继续生成，应使用大于零的限制值。

`PostgresNovelContextRepository` 是生产检索适配器。它在 `withRequestContext` 事务中读取大纲、章节、摘要、事实、时间线和小说实体，使用兼容现有 GIN 索引的全文表达式。首先要求指令的全部规范化词项匹配；只有没有可见候选时，才改为匹配任一规范化词项，匹配和相关度评分使用同一查询。无词项或没有匹配时返回空候选。片段保持大小限制；原始 SQL 时间戳解码为有限的时效分数，快照 writer 校验片段哈希。重试和续写按排名重放已保存片段，不会重新检索。生产结果仓库必须实现 `withIdempotencyLock` 或等价的数据库级幂等声明/锁。

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

- 任一词匹配可能因长指令中的格式词召回弱相关内容。排序限制所选条目，但不保证语义相关性。PostgreSQL `simple` 字典不提供中文分词；本次检索修改不等于通用中文搜索支持。

- 本包不包含实际对象存储客户端、具体的摘要／事实抽取模型或 Web 审核界面。工作流提供可注入的抽取接口。DeepSeek 适配器需要宿主注入 API Key 并制定网络策略；提交对象存储元数据前，调用方必须先确保正文已成功保存。生成服务提供有界的确定性排序和精确上下文重放，但候选检索、部署路由和发布界面仍由调用方负责。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
