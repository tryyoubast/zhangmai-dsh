# Agent Note: 草稿发布保护判断函数的执行权限

Status: implemented

[English](2026-11-11-draft-guard-context-privileges.md) | 中文

## 问题

草稿和版本发布触发器使用调用者权限。共享保护表达式要求 App 和 Worker 写入时可以执行 `novel.rollback_context_active()`，App 和 service 写入时可以执行 `app.agent_run_allowed(uuid,uuid,uuid)`。缺少辅助函数授权会使合法操作被 PostgreSQL 错误 `42501` 拦截，即使角色条件已使判断结果为 false。生成结果可能已经持久化，但首条草稿创建失败。

## 决策

迁移 [0018](../../../../packages/database/database-postgres/migrations/0018_draft_guard_context_privileges.sql) 仅向 `dsh_app_runtime` 和 `dsh_worker_runtime` 授予回滚上下文辅助函数执行权限。辅助函数仍以调用者权限运行，不写入数据。只有实际角色为 `dsh_service_runtime`、actor 是具有非空身份的用户，且事务回滚上下文有效时，它才返回 true。App 或 Worker 角色伪造上下文设置不能激活回滚。

迁移 [0019](../../../../packages/database/database-postgres/migrations/0019_agent_run_predicate_privileges.sql) 仅向 `dsh_app_runtime` 和 `dsh_service_runtime` 授予 agent-run 辅助函数执行权限。这个只读 SECURITY DEFINER 判断函数保留固定搜索路径和实际 Worker 角色要求。`app.current_database_role()` 使用 `session_user` 成员关系校验 PostgreSQL 角色设置；`SET ROLE` 和 `set_config('role',...)` 不能切换到未授权的 Worker 角色。运行时连接池还要求每个登录仅继承自身配置的运行时角色。因此 App 或 service 伪造 agent、用户、工作区和任务上下文仍然得到 false。

`ai.rollback_entity_version` 仍仅允许 service 角色执行。PUBLIC、认证和只读角色不获得辅助函数执行权限；表权限和 RLS 策略保持不变。[经审核的发布规则](../architecture/2026-09-23-postgres-novel-drafts-and-review.zh.md) 继续约束归属、租户访问和发布。

宿主就绪检查通过系统目录 OID 定位两个辅助函数，并检查所需的执行授权。这可以检测遗漏的权限迁移，无需读取小说表或私有迁移日志，也不增加认证角色权限。

## 考虑过的替代方案

**在触发器内部为其他调用者跳过辅助函数。** 这需要替换发布保护函数，并重复判断函数的角色检查。允许执行现有布尔判断函数可以保留已经审核的触发器定义。

## 后果

追加迁移修复既有数据库，不改写已应用迁移的校验和。各调用者可以执行所需的只读判断函数，发布、Worker 写入和回滚权限继续由既有角色检查及授权约束。

## 测试

受限 PostgreSQL 回归覆盖 App 和 Worker 的真实角色草稿写入，要求伪造回滚或 agent 上下文仍返回 false，拒绝 App 和 service 冒充 Worker 角色，并检查精确辅助函数 ACL 以及回滚执行仍仅限 service。App 和 service 测试使用独立受限登录，迁移登录不是运行时角色成员。打包回归通过发布产物的迁移目录读取两个追加 SQL 文件和校验和。
