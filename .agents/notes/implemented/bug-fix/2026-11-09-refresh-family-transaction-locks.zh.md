# Agent Note: Refresh token family 的事务锁

Status: implemented

[English](2026-11-09-refresh-family-transaction-locks.md) | 中文

## Problem

在轮换事务之前读取未使用的 refresh token，会让两个请求同时消费同一个凭证。条件更新失败的请求报告持久化错误，却没有撤销胜出请求的 replacement。只锁定该 token 行，也无法阻止旧祖先的 family 撤销与后代插入相互竞争。

## Decision

[认证存储](../../../../packages/identity/user-auth/src/postgres.ts)在同一个 READ COMMITTED 事务中负责轮换、重放分类、family 撤销和仅追加审计写入。它先以 KEY SHARE 模式锁定用户行，再取得以 family ID 命名的事务级 advisory lock，然后用新的 SQL 语句重新读取 token 并执行 FOR UPDATE。所有后代插入和显式 family 撤销都遵循该协议。replacement 插入先于旧 token 自引用 replaced_by 的更新。

密码重置先对用户行执行 FOR UPDATE，再枚举 family 并按排序顺序加锁。该锁与普通刷新操作的 KEY SHARE 锁冲突，使枚举结果稳定，并保持用户、family、token 的单一加锁顺序。同一用户的不同 family 在其他情况下仍可并发轮换。

存储返回 rotated、invalid 或 reused。service 隐藏 invalid/reused 的区别，HTTP 对正常凭证拒绝统一返回 401。审计失败会回滚撤销，并作为可用性故障处理。HTTP 通过私有校验错误类型识别邮箱和密码输入错误；即使数据库和哈希故障的消息包含凭据相关词语，也仍返回 500。审计仅标识 family、用户、session 和被提交 token 的记录，不包含凭证或 hash。

## Alternatives considered

**捕获条件更新异常**无法让独立的撤销判断与后代创建保持原子性，还会将凭证拒绝与事务错误耦合。

**按消息子串分类 HTTP 错误**会将数据库密码认证故障误判为用户输入错误，还依赖校验消息的大小写。由校验代码定义的错误类型保留输入拒绝，同时明确区分基础设施故障。

**仅使用 token 行锁**可以串行化同一行的重复使用，却不能串行化 family 中不同祖先和后代行上的操作。

**Serializable 事务**需要重试处理，而且仍然需要一致的 family 写入归属。**单条 CTE**会掩盖加锁后的新语句读取和即时外键要求的写入顺序。

## Consequences

同一 family 的刷新写入跨进程串行执行。密码重置等待正在执行的刷新事务，刷新事务也等待正在执行的重置。事务提交或回滚时释放 advisory lock，无需 session 级锁或持久化结构变更。所有 refresh family 写入者都必须保持该加锁顺序。

[PostgreSQL 测试](../../../../packages/identity/user-auth/tests-postgres)使用独立的受限连接和可观察的数据库锁等待，验证两种竞争顺序。其必需 CI 检查拒绝缺失的测试配置。Access Token 生命周期及其他 session 保持既有语义。
