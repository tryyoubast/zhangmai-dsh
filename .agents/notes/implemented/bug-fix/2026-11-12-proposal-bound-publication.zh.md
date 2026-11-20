# Agent Note: 提案绑定候选与原子审核发布

Status: implemented

[English](2026-11-12-proposal-bound-publication.md) | 中文

## 问题

生成提案与实体草稿版本需要在批准前建立同一个持久化身份。实体／版本全局唯一约束使独立提案争抢未发布的位置，而仅匹配生成任务和 JSON 内容无法区分两个提案。发布还涉及结构不同的长文本表；service 角色必须先能看到行，才能更新它们。

## 决策

[迁移 0020](../../../../packages/database/database-postgres/migrations/0020_independent_proposal_publication.sql) 复用八类实体版本表保存绑定提案的候选。`source_type = 'generation_proposal'` 与 `source_id = proposal.id` 为每个提案标识一个候选。调用者权限同步触发器在提案事务中创建或同步候选，并校验租户、目标、来源任务、作者、预期版本和内容。只有非草稿历史占用实体／版本号。拒绝或过期的提案保留其草稿候选；重新打开被拒绝提案时复用原行。

发布按目标 → 提案 → 候选的顺序加锁，校验精确批准的提案，再在同一事务中发布现有候选、投影完整内容、推进实体版本并转换提案状态。目标使用 `FOR NO KEY UPDATE`，使候选插入可取得外键 key-share 锁而不反转锁序。service 不锁定其无权访问的工作区或小说父行。人物技能的主键端点保持不可变。六类长文本目标仍按实际列仅支持创建发布，并具有限定工作区的 service 读取策略。

回滚追加新的已发布快照，并恢复支持实体的完整内容。待处理候选保持不变且变为旧基础版本。发布审计仅由提案状态转换触发器产生；回滚追加自己的事件。审计失败使整个操作中止。service 在受控回滚上下文以外仍禁止普通版本插入。

前向迁移保留既有未绑定版本与正式历史，依据明确的生成任务归属为已绑定且未发布的提案补建候选，并拒绝来源冲突。DDL 的锁与语句等待均有上限。[本地启动](../../../../deploy/local-test/manage.mjs) 先构建，再停止 API 与 worker，在二者停止期间迁移，随后启动新 profile；迁移失败时保留数据并使消费者保持停止。

[ProposalOperationError](../../../../packages/storage/novel-authoring/src/proposal-error.ts) 仅沿驱动 cause 链分类专用 SQLSTATE P2001–P2004。HTTP 适配器将缺失、禁止、冲突和非法操作映射为 404/403/409/400；未分类的数据库错误仍返回脱敏 500。

[上下文仓库](../../../../packages/storage/novel-authoring/src/context-repository.ts) 先解码原始 PostgreSQL 时间戳字符串，再计算时效。原始 SQL 绕过 Drizzle 列解码器；将其结果视为 `Date` 会在已有实体匹配指令时阻断续写。非有限时间戳会明确失败，不进入上下文排序。

迁移 [0022](../../../../packages/database/database-postgres/migrations/0022_guard_proposal_publication_state.sql) 在允许提案状态转换前验证已认证审核者、目标的已发布投影，以及版本实体的精确已发布候选。一个长文本目标只接受一个已发布的创建提案。校验沿用已有 service 权限。

## 考虑过的替代方案

**每个实体只保留一个未发布版本。** 被拒绝或过时的候选会占据下一个位置，阻止其他提案或回滚。独立候选允许保留选择，而不预占正式历史。

**由 service 插入正式版本。** 这会绕过发布精确草稿的既有要求，并扩大 service 写权限。候选同步仍在原调用者权限下执行。

**按任务和内容匹配批准。** 同一任务的相同输出可以属于不同提案。即使所有内容字节相同，授权身份仍是提案 UUID。

**把所有权限或序列化错误转换为冲突。** 这些错误码也可能表示授权损坏、RLS 配置或基础设施故障。专用业务码保留服务故障的可观测性，又不暴露数据库文本。

## 影响

多个候选可并存而不占用正式历史。只有一个基于当前版本的候选能发布成功；其他已批准候选需要基于新版本重新生成。拒绝或过期后，候选记录仍持久保留。迁移替换八个唯一约束，并增加同步及读取策略；它需要离线应用升级和可恢复备份。长文本更新／回滚及整次生成原子物化不属于本决策。

## 测试

[受限 PostgreSQL 回归](../../../../packages/storage/novel-authoring/tests-postgres/publication.spec.ts) 覆盖候选身份、发布、回滚、审计、权限和并发操作。[升级回归](../../../../packages/storage/novel-authoring/tests-postgres/publication-upgrade.spec.ts) 验证 0019 历史保持不变、精确补建候选及保留键冲突拒绝。[Service 错误测试](../../../../packages/storage/novel-authoring/tests/publication-errors.spec.ts) 与 [HTTP 错误测试](../../../../packages/api/novel-authoring-http/tests/publication-errors.spec.ts) 验证安全分类、意外故障及规范化路由。[HTTPS 验收](../../../../deploy/local-test/acceptance.ts) 要求十四类目标成功发布，并要求竞争和过时候选在回滚前后精确返回 409。
