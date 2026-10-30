# Agent Note: 上下文批量写入

Status: implemented

[English](2026-10-29-batched-generation-context-writes.md) | 中文

## Problem

`recordContextItems()` 对每个选中的上下文来源分别查询和插入。上下文批次越大，数据库往返次数越多；并发 Worker 仍可能在这两个操作之间暴露唯一键错误。

## Decision

`recordContextItems()` 在打开事务前校验完整输入，在内存中按 `(generationRunId, sourceType, sourceId)` 去重；同一键携带不同持久化内容时拒绝整个批次。其余记录使用现有来源唯一约束执行一次多行 `INSERT ... ON CONFLICT DO NOTHING RETURNING`。

当 PostgreSQL 对某个请求键没有返回插入行时，服务使用一个查询读取所有缺失键，并逐项校验工作区、小说、生成任务、来源标识、排序、片段哈希、片段、来源状态、token 数和选择原因。记录缺失或内容不一致会拒绝事务，因此批次前面已经插入的记录也会回滚。空批次不打开事务，外键、检查约束和业务唯一约束错误仍作为数据库错误透传。`selectAndRecordContext()` 的 advisory lock 保持不变。本决定扩展了[AI 幂等草稿写入原子化](2026-10-29-atomic-ai-idempotent-draft-writes.zh.md)中的原子重试语义。

## Alternatives considered

**逐条执行 `INSERT ... ON CONFLICT` 并逐条回读**虽然修复了唯一键异常，但仍为每个上下文条目保留两次往返，不能解决批量性能问题。

**插入后始终读取整批记录**可以简化查询路径，但每次成功写入都会增加一次读取。只读取 `RETURNING` 中缺失的键，使正常路径只需要一次数据库往返。

## Consequences

- N 个唯一条目的批次执行一次插入；只有发生并发冲突时才执行一次回读查询。
- 相同键且内容一致时安全去重；相同键但内容不一致时在写入前失败。
- 冲突校验失败会回滚整个事务，不会留下部分上下文记录。
- 不修改 schema 和迁移历史，现有 PostgreSQL 唯一约束仍是权威规则。

## Testing

`packages/storage/novel-authoring/tests/idempotency.spec.ts` 覆盖批量插入、内存去重、单次冲突回读、精确冲突目标、写入前冲突拒绝、并发记录不一致时的事务回滚、空批次以及非幂等数据库错误透传。
