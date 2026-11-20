# Agent Note: 物化过程中的章节存储字段

Status: implemented

[English](2026-11-11-chapter-storage-materialization.md) | 中文

## 问题

生成的章节版本先经过物化，再由真实草稿 writer 校验存储。缺省字段会归一为 null，但 writer 要求未使用的正文或对象键字段不存在。因此两种合法存储方式都会在持久化之前失败。

## 决策

章节版本物化仅将缺省的 `contentText` 和 `contentObjectKey` 转为 undefined，让现有可选字段过滤器省略它们。可空摘要和规范提案 JSON 保留 null 语义。[长篇存储规则](../architecture/2026-09-23-postgres-novel-drafts-and-review.zh.md) 仍是权威；这项修复不改变存储阈值或校验规则。

## 考虑过的替代方案

**全局移除可选字段中的 null。** 其他可空草稿字段和规范提案 JSON 有意使用 null。仅对这两个互斥存储输入归一化，可以保留其他字段的含义。

## 后果

合法的内联正文和对象存储章节可以进入持久化，同时 writer 继续拒绝冲突存储字段。回归使用真实 `LongformAuthoringService` 校验器和捕获写入的数据库驱动，验证两种存储方式以及提案 null，并确保冲突字段在任何数据库或提案写入前被拒绝。
