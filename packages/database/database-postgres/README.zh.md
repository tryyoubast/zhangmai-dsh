---
description: "面向多用户认证、工作区和 AI 小说创作的 PostgreSQL 与 Drizzle 基础设施。"
kind: "package-reference"
---

# @deepseek-ai/dsh-database-postgres

[English](README.md) | 中文

## 概述

本宿主侧包负责多用户小说创作平台的 PostgreSQL 连接池、Drizzle Schema 和经过审查的 SQL 基线迁移。生产环境以 PostgreSQL 为业务真源；现有 SQLite 存储包仍独立承担 KV 或会话基础设施。

## 配置

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

## 数据库布局

迁移日志包含十一个不可变条目。`0001_auth_workspace_novel_ai.sql` 创建认证、工作区、小说、AI 任务、提案和审计表；`0002_workspace_drafts_and_hardening.sql` 增加工作区一致性引用、Worker 仅草稿策略、生命周期保护和最小授权；`0003_remove_redundant_prefix_indexes.sql` 删除冗余前缀索引；`0004_novel_longform_context.sql` 增加大纲、章节、章节版本、摘要、事实、时间线和生成上下文选择；`0005_longform_publication_hardening.sql` 增加长篇记录生命周期字段和发布保护；`0006_publication_and_rollback.sql` 增加数据库侧发布与回滚事务；`0007_secure_rollback.sql` 将回滚限制为受控上下文中的调用者权限服务操作，并通过追加新版本保持版本号单调递增；`0008_generation_results.sql` 按幂等键持久化结构化生成结果，并限制为 Worker 草稿写入；`0009_generation_queue_payload.sql` 保存排队生成请求的指令和上下文限制，供 Worker 恢复执行；`0010_generation_queue_claim.sql` 允许绑定的 Worker 原子领取浏览器创建的排队任务；`0011_generation_claim_rls_hardening.sql` 将领取例外与已绑定 Worker 的写入条件分离，覆盖已经执行旧迁移的数据库。

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

先构建包，再运行发布包所带的迁移入口。`db:migrate` 通过受控 runner 应用打包的 SQL 日志和校验和；生产部署不得使用 `drizzle-kit migrate`、`push` 或用 `DATABASE_URL` 执行 DDL。Drizzle 静态日志检查 `db:check` 读取 `DATABASE_MIGRATION_URL`。

运行时角色不具备 Schema `CREATE`、`CREATEDB`、`CREATEROLE`、`SUPERUSER` 或 `BYPASSRLS` 能力。可信后端在事务内完成认证后，使用事务级局部设置写入 `app.user_id`、`app.workspace_id`、`app.actor_type` 和 `app.agent_principal_id`。这个可信服务端事务上下文使用 PostgreSQL GUC；它不能防御运行时数据库凭据泄露或任意 SQL 执行。不得把凭据或 SQL 访问暴露给模型生成的 SQL。

Worker 只能在绑定工作区中写草稿实体和草稿版本。审核者先分别保存提案与版本草稿，再执行审核。发布服务在一个事务内更新同一草稿版本行、更新实体当前版本并将提案标记为已发布。数据库触发器核对提案与版本内容，并为审核和生成任务状态变化追加审计事件，不复制提示词或原始错误文本。工作区所有者只能通过 `app.transfer_workspace_owner(workspace_id, new_owner_user_id)` 转移。

`ai.publish_generation_proposal(workspace_id, proposal_id)` 只有 `dsh_service_runtime` 和可信用户事务上下文可以执行。它会锁定提案和目标，检查审核状态、目标状态和乐观并发版本，发布目标并追加审计事件。`ai.rollback_entity_version(workspace_id, target_type, target_id, version_no)` 恢复支持的历史实体版本并追加回滚审计事件；两个函数都撤销了 `PUBLIC` 的执行权限。

框架无关的认证路由位于 [`@deepseek-ai/dsh-user-auth`](../../identity/user-auth/README.zh.md)。本包提供这些路由使用的 PostgreSQL Store 和表，但不负责 HTTP 路由、Cookie、JWT 签发、Redis 限流或邮件发送。

## 模型体验

本包没有模型可见内容。它只向应用服务提供宿主侧存储，提示词、工具和 Agent Loop 行为保持不变。

## 当前限制

- 本包负责数据库基础设施和数据库级强制规则，不实现注册、密码哈希、HTTP 认证、Redis 限流、邮件、Web 审核或小说创作编排服务。调用方负责校验带版本的 AI JSON Schema，并设置认证后的事务上下文。如果旧生成任务无法唯一对应到一本小说，或存在目标为空的非草稿创建提案，迁移 `0002` 会中止并报告；修复这些记录后再重试。长篇记录和发布加固由迁移 `0004`、`0005` 提供，发布由 `0006` 提供，安全且保持版本递增的回滚由 `0007` 提供，生成结果的持久化幂等由 `0008` 提供，排队请求恢复由 `0009` 提供，原子领取由 `0010` 提供，既有数据库的 RLS 修复由 `0011` 提供；确认有可恢复备份后使用受控迁移入口执行全部条目。
