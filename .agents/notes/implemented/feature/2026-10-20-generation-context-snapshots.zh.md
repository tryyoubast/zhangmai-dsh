# Agent Note：可重放的生成上下文快照

[English](2026-10-20-generation-context-snapshots.md) | 中文

Status: implemented

## 问题

长篇生成的持久化选择只记录来源实体标识，因此 Worker 重启或来源被编辑后，重试可能取到不同或不完整的模型上下文。

## 决策

`ai.generation_context_items` 与现有排序、哈希、Token 数、来源标识和选择原因一起保存每个选中片段及其来源生命周期状态。`LongformAuthoringService.selectAndRecordContext` 在生成任务事务锁下写入完整快照；`LongformGenerationService` 将写入者保存的结果交给适配器，或从有序快照行恢复重试与续写。归档和删除的候选会被排除；已发布候选优先排序，草稿状态则会保留。为兼容升级，快照列允许为空，但遇到没有快照的旧行时会明确拒绝重放。AI 创建的领域记录仍为草稿，发布仍由独立审核流程控制。

## 考虑过的替代方案

**只保存来源标识和哈希。** 未采用，因为重试前来源行可能已被编辑或删除，哈希无法提供模型实际收到的文本。

**在重试时重新读取来源记录。** 未采用，因为重放会依赖可变的来源内容及其可用性。

## 后果

迁移 `0012_generation_context_snapshots.sql` 增加可空的 `excerpt` 和 `source_status` 列，并设置状态值与成对空值约束；工作区隔离、RLS、Worker 授权和幂等规则保持不变。现存上下文行可读，但没有快照时不能重放；新生成选择会保存完整快照。片段沿用生成任务的数据保留策略，不设置独立清理机制。
