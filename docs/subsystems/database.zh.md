# PostgreSQL 应用数据库

[English](database.md) | 中文

应用数据库保存认证、工作区、小说、固定实体草稿、生成上下文、提案和审计事件。[PostgreSQL 库](../../packages/database/database-postgres/README.zh.md)负责连接、Drizzle 声明及版本化 SQL。通用 [KV 存储](storage.zh.md)负责独立的 Harness／Session 持久化，不能替代这些应用表。

## 连接与所有权

`createDatabase()` 返回 `DatabaseClient<DshDatabase>`，包含带类型的 Drizzle 数据库、连接池和 `close()`。宿主与服务共享该客户端，并在停止进行中的工作后关闭它。通过 `pool.connect()` 借用原始连接的调用方必须在 `finally` 中释放；Drizzle 包装不会转移连接所有权。

`resolveDatabaseConfig()` 在创建连接池前校验 PostgreSQL URL、连接池上限、超时、应用名称及选定角色。每个新建连接都会检查登录权限与成员关系，切换到选定角色，并拒绝超级用户、BYPASSRLS 或非预期的继承角色。部署变量与关闭用法由[库参考文档](../../packages/database/database-postgres/README.zh.md#use-this-package)负责。

## 可信请求事务

`RequestDatabaseContext` 携带服务端解析的 `userId`、`workspaceId`、`actorType` 和可选 Agent 身份。`withRequestContext()` 启动事务，通过事务级 `set_config` 设置 `app.user_id`、`app.workspace_id`、`app.actor_type` 和 `app.agent_principal_id`，再把事务传给回调。成功提交回调的操作，失败则回滚。回调必须使用传入的事务，不能使用外层数据库客户端。

构造上下文前必须完成认证与工作区授权。RLS 和约束在可信服务进程内限制工作区及身份权限。这些 SQL 可写的身份设置不能认证被盗数据库凭据，也不能阻止任意 SQL 执行。模型不会获得数据库凭据或可执行 SQL 的访问能力。

## 角色与迁移

运行时连接池选择 `dsh_auth_runtime`、`dsh_app_runtime`、`dsh_worker_runtime`、`dsh_service_runtime` 或 `dsh_readonly` 之一，登录只能继承选定角色。认证 Store 使用认证角色；应用、Worker、发布服务和只读权限彼此分离。Worker 在绑定工作区创建草稿；审核者授权的发布与回滚通过独立服务操作完成。

管理员应用基线 `0001` 及其所有权引导脚本。日常迁移使用仅继承 `dsh_migrator` 的独立登录和 `DATABASE_MIGRATION_URL`。受控迁移器通过 advisory lock 串行化部署，检查日志哈希，并在一个事务中应用每个待执行条目及其日志更新。打包迁移成功加载后，连接与迁移执行阶段在完成或失败时都会释放连接并关闭连接池。[库参考文档](../../packages/database/database-postgres/README.zh.md#understand-the-implementation)负责迁移 SQL 和部署流程。

AI 在固定表中创建人物、地点及其他记录。增加稳定实体类型需要经过审查的迁移；生成过程不会创建表或给自己授予 DDL 权限。[创作服务](../../packages/storage/novel-authoring/README.zh.md)负责草稿校验与生成编排，[认证服务](../../packages/identity/user-auth/README.zh.md)负责登录和注册。

## 源码归属

| 职责 | 所有者 |
|---|---|
| 连接池、请求事务、迁移 | [database.ts](../../packages/database/database-postgres/src/database.ts) |
| 环境与运行时角色校验 | [config.ts](../../packages/database/database-postgres/src/config.ts) |
| 客户端与可信身份类型 | [types.ts](../../packages/database/database-postgres/src/types.ts) |
| 应用表与约束 | [schema.ts](../../packages/database/database-postgres/src/schema.ts)和[迁移](../../packages/database/database-postgres/migrations) |
