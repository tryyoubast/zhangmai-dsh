# Agent Note: AI 幂等草稿写入原子化

Status: implemented

[English](2026-10-29-atomic-ai-idempotent-draft-writes.md) | 中文

## 问题

AI 生成写入先查询已有记录，再插入新记录。并发 Worker 可能同时查不到记录，其中一个插入成功，另一个收到唯一约束异常，重试无法按幂等语义完成。

## 决策

所有 AI 幂等写入都使用现有数据库约束作为冲突目标执行 `INSERT ... ON CONFLICT DO NOTHING RETURNING id`。数据库返回 ID 时直接完成写入，无需回读。PostgreSQL 报告冲突时，服务按同一个唯一键读取记录，并校验工作区、小说、生成任务以及各方法的关键内容字段；内容一致则返回已有 ID，复用幂等键但内容不同则抛出带实体名称的幂等冲突错误。JSON 字段使用深度比较，可选值按数据库 `NULL` 归一化比较。

生成任务和提案使用 `(workspaceId, idempotencyKey)`，普通草稿表使用 `(workspaceId, sourceIdempotencyKey)`；部分来源幂等索引附带 `sourceIdempotencyKey IS NOT NULL` 谓词。上下文条目使用现有的 `(generationRunId, sourceType, sourceId)` 唯一约束，并校验持久化快照字段。已有记录不会更新，其他业务唯一约束继续作为数据库错误透传。带 advisory lock 的上下文选择和生成结果仓库保持不变。无需迁移。

## 后果

- 并发重试会收敛到同一条持久化记录，不再暴露唯一键异常。
- 幂等键被复用到不同小说、生成任务或内容时不会静默绑定错误记录。
- 只有原子插入没有返回行时才执行冲突回读；正常路径只有一次插入往返。
- 现有 schema 约束、RLS、事务边界和非幂等唯一性行为仍是权威规则。

## 测试

`packages/storage/novel-authoring/tests/idempotency.spec.ts` 覆盖首次插入直接返回 ID、并发冲突回读、内容不一致拒绝和部分索引冲突谓词。包测试与 TypeScript 检查覆盖其余表写入和上下文条目路径。
