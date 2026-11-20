---
description: "面向多用户认证、工作区和 AI 小说创作的 PostgreSQL 与 Drizzle 基础设施。"
kind: "package-library"
---

# @deepseek-ai/dsh-database-postgres

[English](README.md) | 中文

## 概述

本宿主侧包负责多用户小说创作平台的 PostgreSQL 连接池、Drizzle Schema 和经过审查的 SQL 基线迁移。生产环境以 PostgreSQL 为业务真源；现有 SQLite 存储包仍独立承担 KV 或会话基础设施。

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

将本库作为服务依赖导入；调用方拥有连接池及其关闭责任。

### 配置

应用启动必须提供 `DATABASE_URL`，并使用非超级用户登录，且该登录只能继承一个选定的 `dsh_*_runtime` 角色。本包不会静默回退到 SQLite、内存数据库或本地文件。

```powershell
$env:DATABASE_URL = "postgresql://user:password@host:5432/dsh"
```

可选连接池配置为 `DATABASE_POOL_MAX`、`DATABASE_IDLE_TIMEOUT_MS`、`DATABASE_CONNECTION_TIMEOUT_MS`、`DATABASE_APPLICATION_NAME` 和 `DATABASE_RUNTIME_ROLE`。创建连接池前会校验这些值。不要提交连接串或凭据。

```ts
import { createDatabase } from '@deepseek-ai/dsh-database-postgres'

const database = createDatabase()
try {
  // Pass database.db to application services.
} finally {
  await database.close()
}
```

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现细节 — 点击展开</summary>

迁移日志记录不可变条目。`0001_auth_workspace_novel_ai.sql` 创建认证、工作区、小说、AI 任务、提案和审计表；`0002_workspace_drafts_and_hardening.sql` 增加工作区一致性引用、Worker 仅草稿策略、生命周期保护和最小授权；`0003_remove_redundant_prefix_indexes.sql` 删除冗余前缀索引；`0004_novel_longform_context.sql` 增加大纲、章节、章节版本、摘要、事实、时间线和生成上下文选择；`0005_longform_publication_hardening.sql` 增加长篇记录生命周期字段和发布保护；`0006_publication_and_rollback.sql` 增加数据库侧发布与回滚事务；`0007_secure_rollback.sql` 将回滚限制为受控上下文中的调用者权限服务操作，并通过追加新版本保持版本号单调递增；`0008_generation_results.sql` 按幂等键持久化结构化生成结果，并限制为 Worker 草稿写入；`0009_generation_queue_payload.sql` 保存排队生成请求的指令和上下文限制，供 Worker 恢复执行；`0010_generation_queue_claim.sql` 允许绑定的 Worker 原子领取浏览器创建的排队任务；`0011_generation_claim_rls_hardening.sql` 将领取例外与已绑定 Worker 的写入条件分离，覆盖已经执行旧迁移的数据库；`0012_generation_context_snapshots.sql` 保存生成实际使用的上下文片段及来源状态，以便重放；`0013_legacy_context_rerun_marker.sql` 为不完整的旧快照标记重新生成；`0014_novel_context_fulltext_indexes.sql` 增加有界全文上下文检索使用的 GIN 表达式索引。

`0015_current_user_workspace_memberships.sql` 提供无参数、仅 app 角色可执行的函数，读取当前用户 GUC 并返回成员历史与工作区状态。`0016_generation_claim_policy_repair.sql` 增加受限的 Worker 领取 SELECT 策略，修复其排队状态 UPDATE 后置条件，不扩大领取谓词。这两个追加迁移保留已有数据行、表和索引。

`0017_generation_worker_identity.sql` 增加 `ai.resolve_generation_run_worker_identity(workspace_id, run_id)`，这是由 `dsh_migrator` 拥有、固定搜索路径且仅 Worker 运行时可执行的稳定 SECURITY DEFINER 函数。函数要求实际 Worker 数据库角色、agent 执行者、非空的已配置智能体身份以及匹配的工作区上下文。它只解析已分配给该智能体的任务，或排队中的 `user-request` 任务，并要求来源会话匹配、有效且未撤销，用户活跃、已验证且未删除，owner/admin/editor 成员关系有效，以及工作区活跃且未删除。它只返回用户／会话／工作区／小说 ID、成员角色和任务状态，不授予认证表读取权限，也不返回凭据字段；队列定位符本身不能建立身份。

迁移 `0018` 和 `0019` 分别向 app/worker、app/service 授予范围受限的布尔守卫函数执行权限；函数仍会拒绝缺少所需 service 或 worker 数据库角色的调用。迁移 `0020` 为每个提案创建独立草稿候选，并补齐 service 对长文本内容的读取策略。迁移 `0021` 允许 Worker 仅在持有任务行锁并重新核对持久化身份后，将 queued 或 running 任务结算为失败；如果身份仍有效，队列投递仍可重试。既有生命周期触发器会在同一事务写入失败审计。迁移 `0022` 要求审核者身份、已发布目标投影和精确的已发布候选（适用版本化存储时）一致，才允许提案转为 published。这些迁移不扩大运行时表访问权限。

AI 只能在这些固定表中创建记录，没有 PostgreSQL DDL 权限。新增稳定实体类型必须通过经过审查的版本化迁移实现，不能由模型生成 SQL。

管理员首次应用 `0001` 后，使用超级用户执行一次 [`scripts/bootstrap-migrator-ownership.sql`](scripts/bootstrap-migrator-ownership.sql)。它会把业务 Schema 和迁移日志表所有权交给 `dsh_migrator`，并移除其创建角色权限。之后创建只继承 `dsh_migrator` 的部署登录；日常部署不得使用 `postgres`。

```sql
CREATE ROLE dsh_migration_login LOGIN PASSWORD 'managed-outside-source-control';
GRANT dsh_migrator TO dsh_migration_login;
```

```powershell
$env:DATABASE_MIGRATION_URL = "postgresql://dsh_migration_login:password@host:5432/dsh"
pnpm --filter @deepseek-ai/dsh-database-postgres db:migrate
```

先构建包，再运行发布包所带的迁移入口。`db:migrate` 通过受控 runner 应用打包的 SQL 日志和校验和；生产部署不得使用 `drizzle-kit migrate`、`push` 或用 `DATABASE_URL` 执行 DDL。发布包在构建产物之外包含 `migrations/*.sql`、`migrations/meta/_journal.json`、`scripts/migrate.js` 与 `scripts/bootstrap-migrator-ownership.sql`；Drizzle 配置、schema 源码和迁移快照仅用作开发输入。Drizzle 静态日志检查 `db:check` 在源码检出中读取 `DATABASE_MIGRATION_URL`。

运行时角色不具备 Schema `CREATE`、`CREATEDB`、`CREATEROLE`、`SUPERUSER` 或 `BYPASSRLS` 能力。可信后端在事务内完成认证后，使用事务级局部设置写入 `app.user_id`、`app.workspace_id`、`app.actor_type` 和 `app.agent_principal_id`。这个可信服务端事务上下文使用 PostgreSQL GUC；它不能防御运行时数据库凭据泄露或任意 SQL 执行。不得把凭据或 SQL 访问暴露给模型生成的 SQL。

连接池等待每个连接完成异步角色校验和 `SET ROLE` 初始化后，才将其借给调用方。初始化失败会拒绝获取连接并关闭该连接。Drizzle 的额外配置回调返回数组条目；版本化 SQL 迁移仍是数据库结构的权威来源。

Worker 只能在绑定工作区中写草稿记录和提案。对于八类版本化实体，调用者权限触发器在同一事务中为每个提案同步一个候选。候选来源和内容必须与精确对应的提案一致；批准后的内容不可修改。草稿候选可共享预期版本号，部分唯一索引则保留每个非草稿历史版本号。审核状态变更追加审计事件，不复制提示词或原始错误文本。工作区所有者只能通过 `app.transfer_workspace_owner(workspace_id, new_owner_user_id)` 转移。

`ai.publish_generation_proposal(workspace_id, proposal_id)` 要求 `dsh_service_runtime` 和已认证的审核者。它先用 `FOR NO KEY UPDATE` 锁定目标，再锁定提案及其精确候选，发布候选、投影批准内容并推进实体版本，最后一并提交提案审计。六类长文本目标按各自实际列支持首次创建发布。`ai.rollback_entity_version(workspace_id, target_type, target_id, version_no)` 为八类实体追加新的已发布版本并恢复完整内容；待处理候选保留且变为旧基础版本。两个函数均撤销 `PUBLIC` 执行权限。缺失、拒绝、冲突和非法操作使用专用业务 SQLSTATE；意外数据库错误仍作为故障传播。

迁移 `0020` 仅替换八个版本号唯一约束，增加提案候选同步，依据明确的生成任务为已绑定且未发布的提案补建候选，并补齐六个限定工作区的 service 读取策略。既有未绑定版本与正式历史保持不变。候选来源冲突时迁移中止，不猜测归属。迁移锁等待限制为五秒，语句限制为六十秒。[发布决策](../../../.agents/notes/implemented/bug-fix/2026-11-12-proposal-bound-publication.zh.md) 记录并发及兼容性取舍。

草稿发布触发器以调用者角色执行共享判断函数。迁移 `0018` 向 App 和 Worker 授予 `novel.rollback_context_active()` 执行权限；只有 service 角色同时具备可信用户事务和有效回滚上下文时，它才返回 true。迁移 `0019` 向 App 和 service 授予 `app.agent_run_allowed(uuid,uuid,uuid)` 执行权限；其实际 Worker 角色检查仍使这些调用者得到 false，包括伪造 agent 上下文时。这些授权不改变表权限或 RLS 策略。[权限决策](../../../.agents/notes/implemented/bug-fix/2026-11-11-draft-guard-context-privileges.zh.md) 解释了这两项修复。

框架无关的认证路由位于 [`@deepseek-ai/dsh-user-auth`](../../identity/user-auth/README.zh.md)。本包提供这些路由使用的 PostgreSQL Store 和表，但不负责 HTTP 路由、Cookie、JWT 签发、Redis 限流或邮件发送。

本包不发布不变量伴生模块，因为数据库一致性由所属操作中的 schema 约束、迁移校验和及连接角色检查直接保证。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [数据库子系统](../../../docs/subsystems/database.zh.md)：连接池、RLS 与迁移职责。

-----

<a id="model-experience"></a>
## 模型体验

本包不直接构造模型请求；数据库连接与持久化由服务端使用，模型输入由消费方服务负责。

#### KV Cache effect

本包不构造或改写模型输入前缀；实际模型缓存行为由调用方及 Provider 决定。

## 当前限制

<a id="known-limitations-and-deferred-work"></a>

- 本包负责数据库基础设施和数据库级强制规则，不实现注册、密码哈希、HTTP 认证、Redis 限流、邮件、Web 审核或小说创作编排服务。调用方负责校验带版本的 AI JSON Schema，并设置认证后的事务上下文。如果旧生成任务无法唯一对应到一本小说，或存在目标为空的非草稿创建提案，迁移 `0002` 会中止并报告；修复这些记录后再重试。长篇记录和发布加固由迁移 `0004`、`0005` 提供，发布由 `0006` 提供，安全且保持版本递增的回滚由 `0007` 提供，生成结果的持久化幂等由 `0008` 提供，排队请求恢复由 `0009` 提供，原子领取由 `0010` 提供，既有数据库的 RLS 修复由 `0011` 提供，上下文快照重放由 `0012` 提供；确认有可恢复备份后使用受控迁移入口执行全部条目。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
