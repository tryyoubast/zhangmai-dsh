# Agent Note: AI 幂等草稿写入原子化

Status: implemented

[English](2026-10-29-atomic-ai-idempotent-draft-writes.md) | 中文

## 问题

AI 生成写入先查询已有记录，再插入新记录。并发 Worker 可能同时查不到记录，其中一个插入成功，另一个收到唯一约束异常，重试无法按幂等语义完成。

领取人类生成请求会把 Worker 归属从 `user-request` 改为实际执行的智能体。将这个可变归属当成不可变请求内容，会在领取或完成后拒绝原本完全相同的人类重试。

## 决策

所有 AI 幂等写入都使用现有数据库约束作为冲突目标执行 `INSERT ... ON CONFLICT DO NOTHING RETURNING id`。数据库返回 ID 时直接完成写入，无需回读。PostgreSQL 报告冲突时，服务按同一个唯一键读取记录，并校验工作区、小说、生成任务以及各方法的关键内容字段；内容一致则返回已有 ID，复用幂等键但内容不同则抛出带实体名称的幂等冲突错误。JSON 字段使用深度比较，可选值按数据库 `NULL` 归一化比较。

生成任务和提案使用 `(workspaceId, idempotencyKey)`，普通草稿表使用 `(workspaceId, sourceIdempotencyKey)`；部分来源幂等索引附带 `sourceIdempotencyKey IS NOT NULL` 谓词。上下文条目使用现有的 `(generationRunId, sourceType, sourceId)` 唯一约束，并校验持久化快照字段。已有记录不会更新，其他业务唯一约束继续作为数据库错误透传。带 advisory lock 的上下文选择和生成结果仓库保持不变。无需迁移。

生成任务重试在工作区幂等键内比较小说、发起用户、来源会话、模型、提示词版本、归一化指令和上下文数量。人类重试不比较绑定的 Worker，因此排队、运行中或终态任务都保留同一 ID。智能体重试还会比较 `agentPrincipalId` 是否为自身身份。人类重试忽略 Worker 归属并不会绕过用户、会话、不可变输入或 RLS 检查，也不会重置任务状态。

## 考虑过的替代方案

**先读后插入。** 上述竞态仍然存在，因为不存在的行无法为另一个 Worker 保留其唯一键。

**更新冲突记录。** `ON CONFLICT DO UPDATE` 会在重试时修改已有草稿，违背 writer 不改变重试记录、明确拒绝内容不一致的行为。

**为所有调用者比较 Worker 归属。** 领取会改变该字段，但不改变人类请求。为智能体调用者保留归属比较，可以约束其绑定身份，同时允许发起用户以相同请求重试。

## 后果

- 并发重试会收敛到同一条持久化记录，不再暴露唯一键异常。
- 幂等键被复用到不同小说、生成任务或内容时不会静默绑定错误记录。
- 人类在 Worker 领取后重试仍保持幂等，智能体重试仍受绑定身份约束。
- 只有原子插入没有返回行时才执行冲突回读；正常路径只有一次插入往返。
- 现有 schema 约束、RLS、事务边界和非幂等唯一性行为仍是权威规则。

## 测试

[幂等写入测试](../../../../packages/storage/novel-authoring/tests/idempotency.spec.ts) 覆盖首次插入直接返回 ID、并发冲突回读、内容不一致拒绝和部分索引冲突谓词。[生成重试测试](../../../../packages/storage/novel-authoring/tests/generation-run-retry.spec.ts) 覆盖 Worker 领取及各生命周期状态下的人类重试、不可变输入和发起用户冲突，以及智能体身份不匹配。[受限 App PostgreSQL 测试](../../../../packages/storage/novel-authoring/tests-postgres/workspace-identity.spec.ts) 重试已持久化且分配给 Worker 的任务，验证其 ID、状态和 Worker 均保留。包测试与 TypeScript 检查覆盖其余表写入和上下文条目路径。
