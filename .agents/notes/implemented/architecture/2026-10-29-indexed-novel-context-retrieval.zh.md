# Agent Note: Indexed novel context retrieval

Status: implemented

[English](2026-10-29-indexed-novel-context-retrieval.md) | 中文

## Problem

小说上下文检索会先对所有支持的来源类型逐行计算相关度，再丢弃不匹配指令的记录，因此每次请求都会在整部小说上执行全文排序。

## Decision

`PostgresNovelContextRepository.findCandidates` 在计算 `ts_rank` 前，先应用各来源 GIN 索引使用的相同 `simple` `to_tsvector` 表达式。现有生命周期过滤、排序规则和 500 条上限保持不变，因此只有全文命中项进入排序，不会用未命中项补足上限。`hydrateContext` 只读取请求中的来源类型和 ID，快照重放不再执行检索。迁移 `0014_novel_context_fulltext_indexes.sql`、Drizzle schema 和迁移日志共同声明十四种来源索引。

## Alternatives considered

**对所有来源记录排序后在应用层过滤**无法使用数据库索引，并保留每次请求的原有计算量。

**只为常用来源建立索引**会造成检索成本和来源覆盖不一致，因此十四种持久化来源全部使用相同的有界表达式。

## Consequences

没有全文命中时返回空候选集，命中少于上限时只返回命中项。Hydration 不执行全文排序，并在连接请求 ID 前去除重复来源请求。
