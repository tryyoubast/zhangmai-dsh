# Refresh Token 重放撤销设计

**状态：** 已批准的实施与验收规范

[English](2026-11-06-refresh-token-replay-design.md) | 中文

## 问题

P0 修复前的 Service 在持久化写入开始前读取 Refresh Token 记录。两个请求可以同时看到未使用的 Token。胜出者消费它并插入替换 Token；失败者随后收到条件更新错误。该错误绕过重用处理，可能变成 HTTP 500，并让胜出者的替换 Token 继续可用。

## 目标与范围

- 将刷新轮换、重放检测、Family 撤销和重放审计作为一个原子 Store 操作。
- 确保两个并发请求都结束后，被重放 Token 的 Family 中没有可用的替换 Token。
- 对未知、过期、撤销和重用凭证返回相同的 401 invalid_refresh_token 响应。
- 只撤销受影响的 Refresh Token Family。Access Token 生命周期及其他 Session 保持不变。
- 不新增或修改数据库表、索引、迁移。
- 重放审计不持久化或记录原始 Refresh Token、Token Hash、Access Token、邮箱和 Authorization Header。

## 持久化协议

RefreshTokenStore.rotate(tokenHash, replacement, now) 负责完整操作。Service 在调用 Store 前创建替换 Token 材料，但不读取持久化 Token 状态，也不单独决定撤销。

PostgreSQL 在 READ COMMITTED 事务中执行操作：

1. 通过唯一 Hash 查找 Token 的用户和 Family 标识。不存在时返回 invalid；该查询不证明凭证有效。
2. 对用户行执行 FOR KEY SHARE，再取得由 Family 标识派生的事务级 Advisory Lock。Family 键使用 hashtextextended、dsh:auth:refresh-family: 命名空间和种子 0。
3. 用新的 SQL 语句重新读取 Token，并执行 FOR UPDATE 锁定行。新的 READ COMMITTED 语句可以看到等待 Family 锁期间提交的变更。
4. 对过期或已撤销的 Token 返回 invalid，不执行写入。
5. 对已使用的 Token 撤销 Family 中所有仍有效的行，追加恰好一条重用审计事件，并返回 reused。撤销和审计一起提交。
6. 对未使用的 Token，先插入替换 Token，再设置旧行的 used_at 和 replaced_by。返回 rotated 及持久化身份字段。

首次签发和显式 Family 撤销使用相同的用户 KEY SHARE 锁与 Family Advisory Lock。密码重置先对用户执行 FOR UPDATE，再枚举已有 Family 并按排序顺序加锁。用户独占锁阻止并发签发或轮换在枚举期间改变 Family 集合。所有路径保持用户、Family、Token 的锁顺序；不同 Family 在其他情况下仍可并发轮换。

结果是 rotated、invalid 和 reused 的判别联合类型。数据库故障以异常拒绝，并回滚事务；正常凭证拒绝不使用异常。

## HTTP 与审计行为

Refresh Service 将 invalid 和 reused 都映射为 null，调用方不能据此区分 Token 状态。HTTP 控制器返回 401 {"error":"invalid_refresh_token"}。基础设施或审计写入故障仍是服务故障，由既有通用可用性响应处理。

重用审计固定设置 workspaceId 为 null、actorType 为 system、actorId 为 auth.refresh_token_service、action 为 auth.refresh_token_reuse_detected、targetType 为 refresh_token_family、targetId 为 Family ID。Metadata 仅包含 userId、sessionId 和 tokenId。createdAt 使用传给 rotate 的时间；事件与 Family 撤销写在同一事务。

## 仓库 CI 与 PR 策略

P0 验收要求独立的 PostgreSQL 18 Actions Job。临时超级用户只应用基线 0001 和 Ownership Bootstrap；仅继承 dsh_migrator 的独立非超级用户应用 0002–0014。测试使用另一个仅继承 dsh_auth_runtime 的非超级用户。该 Job 加入 all checks passed，不允许条件跳过或 continue-on-error。

三个提交分别承担可移植 CI 前置修复、独立 PR 元数据策略和 P0 修复。CI 默认使用托管 Linux 与 Windows Runner，通过显式配置选择企业或故障切换 Runner。包约束和数据库精确发布文件范围在不升级依赖、不修改迁移的前提下修复。[CI 决策](../../../.agents/notes/implemented/process/2026-11-09-portable-ci-prerequisites.zh.md)负责 Runner 和包的详细说明。

必需的 Issue policy 检查使用只读 Token 校验当前仓库 PR 标签和评审状态。它不解析 PR 正文，不查询 Issue 或 Project，也不要求 Issue 引用。Issue/Project 自动化和 Cloudflare 部署均需显式启用；禁用部署时 Cloudflare 仍执行构建。[PR 策略决策](../../../.agents/notes/implemented/process/2026-11-09-portable-pr-metadata-and-optional-project.zh.md)负责权限与启用条件。

## 替代方案

- 只锁定被提交的 Token 行，无法将旧 Token 重放与另一个后代行的轮换或插入串行化。必须使用覆盖该聚合的 Family 级锁。
- 捕获条件更新异常不能可靠识别事务状态，也不能让 Family 撤销与胜出请求的替换 Token 保持原子性。
- 复杂的单语句 CTE 掩盖加锁后重新读取和插入先于自引用更新的要求。简短的显式事务使两项不变式易于审查。
- Serializable 隔离级别会引入重试行为，却不能替代一致的 Family 写入协议。

## 验证

- 单元测试覆盖 Service 结果映射和 HTTP 401 行为。
- 真实 PostgreSQL 集成测试要求显式运行账号与迁移账号 URL，指向同一个名称包含 test 的隔离数据库。缺失或不匹配直接失败；不加载生产 .env。
- 两个独立运行连接、控制事务、测试专用触发器及可观察的数据库锁等待安排两种竞争顺序，不使用固定延时。
- 测试断言正常重放没有 Promise Rejection、没有第二个有效替换 Token、所有 Family 行已撤销、只有一条仅追加审计，并验证审计插入失败时撤销回滚。
- 测试覆盖旧祖先重放、显式 Family 撤销和密码重置与轮换的两种竞争顺序。重放撤销不影响其他 Family 和用户。
- 红测针对修复前实现执行；祖先／后代反证测试临时移除 Family 锁后必须失败。所有临时改动在验收检查前恢复。
- Fixture 清理在 finally 中释放控制事务、移除测试触发器／函数并关闭连接。仅追加审计保留至隔离数据库销毁。
- 必需检查包括 user-auth 单元测试、真实 PostgreSQL 测试、独立 PostgreSQL 18 Actions Job、Typecheck、Lint 和文档检查。

只有真实并发测试与全部必需 CI 检查通过，才将 P0 标记为解决。[已实施决策](../../../.agents/notes/implemented/bug-fix/2026-11-09-refresh-family-transaction-locks.zh.md)记录持久化选择理由；[认证子系统](../../subsystems/identity-auth.zh.md)负责与源码等价的类型。验证结果属于交付报告，不属于本规范。
