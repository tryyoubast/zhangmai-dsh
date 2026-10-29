# Agent Note: 邮箱验证令牌消费与用户激活保持原子性

Status: implemented

[English](2026-10-29-atomic-email-verification-consumption-activation.md) | 中文

## 问题

邮箱验证在一次 Store 调用中消费有效的一次性令牌，再通过另一次调用激活对应用户。如果令牌消费后激活失败，令牌便无法重试，账户仍会停留在待激活状态。

## 决策

`AuthLifecycleStore` 必须实现 `consumeAndActivateEmailVerification(tokenHash, now): Promise<boolean>`；`UserAuthService.verifyEmail()` 将操作委托给这个单一方法。`PostgresAuthStore` 通过同一个 `db.transaction()` 事务对象执行令牌消费和用户激活的两条 `UPDATE … RETURNING` 语句。令牌不存在、已过期或已消费时返回 `false`。令牌消费后，如果激活更新没有恰好返回一行用户记录，就抛出错误，使事务回滚令牌更新。现有激活字段和按用户 ID 匹配的条件保持不变；必需接口不提供旧方法回退。

两个更新共用同一个时间戳。PostgreSQL 适配器保留此前的结果语义，同时让调用方看到的令牌消费与用户激活不可分割。无需数据库结构迁移。

## 备选方案

### 保留分开的令牌消费与用户激活 Store 调用

这正是导致故障的行为：Service 无法让两个独立的持久化操作保持原子性，因此激活出错后可能留下待激活账户和已消费令牌。

### 保留旧方法的兼容回退

回退会让不提供原子保证的 Store 继续通过能力检查，并重新引入相同的部分提交状态。因此生命周期接口要求实现合并后的操作。

## 后果

- 有效令牌和账户激活会一同提交；令牌无效时返回 `false`，激活失败时令牌消费会回滚。
- 每个 `AuthLifecycleStore` 实现都必须提供合并后的操作，包括测试替身和下游适配器。
- 令牌过期与已消费的处理、激活字段以及现有用户 ID 匹配条件均保持不变。部署无需数据库迁移。

## 测试

user-auth 生命周期测试覆盖成功验证、一次性消费、过期与未知令牌以及激活失败。PostgreSQL Store 测试验证两次更新都使用事务对象，并验证用户更新未命中时事务回调会拒绝执行，避免令牌消费提交。
