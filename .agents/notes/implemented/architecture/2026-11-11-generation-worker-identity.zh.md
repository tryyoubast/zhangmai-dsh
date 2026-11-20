# Agent Note: 持久化生成任务的 Worker 身份

Status: implemented

[English](2026-11-11-generation-worker-identity.md) | 中文

## 问题

队列投递能定位工作区和任务，但不能认证发起用户或来源会话。受限 Worker 角色不能读取认证表。如果从消息提供用户或会话 ID，队列数据就能建立权限，并绕过当前撤销状态检查。

## 决策

迁移 [0017](../../../../packages/database/database-postgres/migrations/0017_generation_worker_identity.sql) 提供仅 Worker 可调用的查询，由迁移角色拥有，固定搜索路径，并撤销 PUBLIC 执行权限。PostgreSQL 先检查实际 Worker 角色与已配置智能体上下文，再关联任务及其匹配的有效会话、活跃已验证用户、当前写入成员关系和活跃工作区。函数返回六个身份与状态字段，不返回认证秘密，也不授予表权限。

[PostgresGenerationWorkerIdentity](../../../../packages/storage/novel-authoring/src/worker-identity.ts) 在事务开始时将用户设为未知，并使用宿主配置的智能体。它返回数据库确认的身份、小说和状态，或 null。固定的 official-client 类型描述 Worker 执行方式，不声明原始会话的传输类型。宿主解析负责验证 UUID 定位符和非空智能体配置。每次投递都在已有原子领取操作前重新解析权限。

迁移 [0021](../../../../packages/database/database-postgres/migrations/0021_settle_unavailable_generation_runs.sql) 锁住相符的待处理任务，重新查询权限，再决定是否标记失败。失败使用固定错误，并在同一事务中写入已有生命周期审计。权限可用时保留投递；不存在、归属不符或已终态的任务均可确认，无须暴露区别。

## 考虑过的替代方案

**允许 Worker 读取认证表。** 表级读取会暴露执行一个持久化任务所需的六个字段以外的认证数据。

**信任队列消息中的用户和会话字段。** 队列定位符只能定位记录，不能证明当前会话有效性、成员关系或任务分配。

## 影响

解析读取当前数据库快照，不领取任务、不延长会话，也不为后续操作保留权限。原子领取仍决定哪次重复投递可以执行。运行时登录凭据被盗和任意 SQL 执行仍处于受信事务上下文模型之外。受限 PostgreSQL 测试验证函数所有者与授权、成功解析、任务状态不变、认证表读取拒绝，以及会话、账户、成员、工作区或执行者权限不可用后的拒绝。测试数据保留审计历史，并使用分离的 Worker 与迁移登录。
