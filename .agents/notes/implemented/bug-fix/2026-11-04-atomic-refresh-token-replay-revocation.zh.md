# Agent Note: Refresh Token 重放时原子撤销 Token Family

Status: implemented

[English](2026-11-04-atomic-refresh-token-replay-revocation.md) | 中文

## 问题

Refresh Token 轮换原先由 `RefreshTokenService` 读取 Token 状态，再由 `PostgresAuthStore` 执行条件更新。两个请求可能同时观察到 `used_at IS NULL`。第一个请求轮换成功，第二个请求更新不到记录并抛出异常；该异常不会进入 Service 中撤销 Token Family 的分支，因此获胜请求生成的 replacement 仍可使用，重放请求还可能表现为 HTTP 500。

只锁定传入 Token 仍允许跨代竞态：T1 插入 T2 并等待消费 T1 时，重放已使用的 T0 会启动 Family 更新，其快照不包含尚未提交的 T2。等待 T1 不会让该更新发现 T2，因此撤销后仍可能留下有效后代。

## 决策

`RefreshTokenStore.rotate(tokenHash, replacement, now)` 以一个原子持久化操作负责校验、轮换、重放处理和结果分类。`PostgresAuthStore` 自行拥有显式 `READ COMMITTED` 隔离级别的顶层事务。按 hash 预查询只取得 Family 标识，不用于授权轮换。Store 获取 `pg_advisory_xact_lock(hashtextextended('auth.refresh_token_family:' || familyId::uuid::text, 0))` 后，再用独立的 `SELECT ... FOR UPDATE` 重新读取 Token。UUID 类型转换让大小写输入使用相同锁键。等待后的每条语句都能看到已提交的后代。

`revokeFamily()` 使用同一把事务锁。所有参与写入的操作都先取得 Family 锁，再取得 Token 行锁并写入，避免不同代际的轮换与撤销相互死锁。提交和回滚都会释放咨询锁。哈希碰撞可能让无关 Family 串行执行，但不会削弱撤销保证。`create()` 在新 Family 中签发首个 Token；仅 `rotate()` 创建后代。

`resetPassword()` 按排序后的 UUID 顺序查询用户的 Token Family 并逐个取得 Family 锁，然后更新密码、Session 和 Refresh Token。所有锁取得后，最终的 Token 更新在独立的 `READ COMMITTED` 语句中执行，因此也会包含重置等待轮换期间提交的后代。

Token 不存在、已过期或已撤销时返回 `invalid`，不插入 replacement，也不写审计。有效且未使用的 Token 会先插入 replacement，再把旧 Token 标记为已使用并写入 `replaced_by`；这个顺序满足现有即时检查的自引用外键。Token 已使用时，同一事务会为该 Family 中所有尚未撤销的 Token 写入 `revoked_at`，随后向 `security.audit_events` 追加 `auth.refresh_token_reuse_detected`。审计 metadata 只包含用户、Session 和 Token 标识，不包含原始 Token、Token Hash、邮箱、Access Token 或请求头。

`RefreshTokenService` 在调用 Store 前生成 replacement 材料。只有 `rotated` 会返回新的原始 Token；`invalid` 和 `reused` 都映射为 `null`。因此 `AuthHttpController` 保持既有的 `401 {"error":"invalid_refresh_token"}` 协议，不暴露 Token 状态。非预期数据库故障仍作为服务故障向上传播。

无需数据库结构迁移。本次变更只撤销被重放 Token 所属的 Family，不影响用户的其他 Session，也不改变 Access Token 生命周期。

## 备选方案

### 保留 Service 层先读后写

Service 无法跨两个独立 Store 调用持有数据库行锁。因此写入前检查的 `used_at` 在并发下仍可能过时，不能可靠保证 Family 撤销。

### 仅捕获条件更新异常

把更新零行表达为异常并在后续捕获，仍然把重放检测和 Family 撤销拆成两个操作。两者之间发生进程故障或第二次失败时仍可能留下有效 replacement，而且正常重放仍会被误表达为基础设施故障。

### 只增加条件更新补丁

条件更新可以选出一个获胜请求，但失败请求若不在同一事务中完成判别和撤销，就无法稳定取得 Family 身份。在事务外补一次查询会重新引入原来的竞态边界。

### 仅锁定各个 Token 行

不同代际的 Token 锁定不同的行。Family 更新可能漏掉尚未提交的后代，而分别持有不同行锁的重放事务在更新 Family 时也可能死锁。Family 咨询锁无需改动数据库结构即可协调这些行。锁后的独立语句与显式 `READ COMMITTED` 隔离级别，避免沿用等待锁之前的快照。

### 使用一条复杂 CTE 编码全部流程

数据修改 CTE 可以合并部分操作，但行锁顺序、审计分支、即时外键顺序和结果分类会更难审查与测试。显式事务提供同样的原子性，同时让各项不变量保持可见。

## 后果

- 同一 Refresh Token 被并发使用时，一个调用返回 `rotated`，另一个返回 `reused`；两个调用完成后，该 Family 的所有 Token 都已撤销。
- 正常重放返回 401 而不是 500，并写入一条只追加的安全事件。
- 所有 `RefreshTokenStore` 实现和测试替身都必须实现新的原子结果契约；公开的 `findByHash()` 接口已删除。
- 安全审计事件属于撤销事务，因此审计插入失败会回滚 Family 撤销，并作为数据库故障向上传播。
- 调用方提供根数据库客户端，不能传入嵌套事务。部署时先排空旧版刷新请求和实例，再启用此实现；所有轮换和 Family 撤销实现必须参与 Family 锁协议，因此混合版本不提供此保证。
- 安全审计保持只追加，测试清理也不例外。一次性测试数据库保留这些事件直到整个数据库被销毁；可变 fixture 与临时触发器独立清理。

## 测试

单元测试和 Store 契约测试覆盖正常轮换、无写入的无效 Token、重放时撤销 Family、精确且不含秘密的审计 metadata、审计失败回滚、Service 将 `reused` 映射为 `null`，以及 HTTP 映射为 401。PostgreSQL 18 测试使用独立受限运行时连接池，以及位于独立双整数咨询锁命名空间的 fixture 级触发器屏障；测试观察实际阻塞关系，不依赖固定休眠。跨代回归测试在仅有行锁的实现上因 T2 仍有效而失败，加入 Family 串行化后通过。测试还检查同 Token 竞争、两种跨代执行顺序、密码重置与轮换的顺序、不同代际重放无死锁、主动撤销、无关 Family 继续执行、审计回滚与锁释放，以及 HTTP 200/401 行为。PR CI 会启动 PostgreSQL 18，通过受限迁移登录应用迁移，并把该测试纳入必需的汇总门禁。生产流量与滚动发布不在该测试覆盖范围内。
