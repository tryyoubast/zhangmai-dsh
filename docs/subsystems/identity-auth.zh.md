# 用户认证

[English](identity-auth.md) | 中文

本参考页负责 [user-auth](../../packages/identity/user-auth/README.zh.md) 声明的 Refresh Token 持久化类型，该包属于 [identity 包组](../../packages/identity/README.zh.md)。包参考页负责 HTTP 集成和部署要求；[数据库参考页](database.zh.md)负责连接与迁移职责。

源码：[user-auth/src/index.ts](../../packages/identity/user-auth/src/index.ts)

## 存储记录与替换材料

`RefreshTokenRecord` 包含持久化身份和 Token 状态。`RefreshTokenReplacement` 只包含调用方生成的材料；Store 从已锁定的数据库记录继承替换 Token 的用户、Session 和 Family。

```ts type-equiv
/** Persisted refresh-token metadata; raw token material is never part of this record. */
interface RefreshTokenRecord {
  readonly id: string
  readonly userId: string
  readonly sessionId: string
  readonly familyId: string
  readonly tokenHash: string
  readonly expiresAt: Date
  readonly usedAt: Date | null
  readonly revokedAt: Date | null
}
```

```ts type-equiv
/** Replacement material generated before the store transaction; identity comes from the persisted token. */
interface RefreshTokenReplacement {
  readonly id: string
  readonly tokenHash: string
  readonly expiresAt: Date
}
```

## 原子轮换结果

`rotated` 标识已提交的替换 Token 及其持久化归属。`invalid` 包括不存在、过期和已撤销的凭证。`reused` 表示 Store 已同时提交 Family 撤销和安全审计。Service 将两种拒绝结果均映射为 `null`，HTTP 适配器返回 `401 invalid_refresh_token`；基础设施故障以异常拒绝，不返回凭证结果。

```ts type-equiv
/** Committed rotation outcome; normal credential rejection does not throw. */
type RefreshTokenRotationResult =
  | {
      readonly status: 'rotated'
      readonly id: string
      readonly userId: string
      readonly sessionId: string
      readonly familyId: string
    }
  | { readonly status: 'invalid' }
  | { readonly status: 'reused' }
```

## 持久化职责

Store 负责状态分类、后代创建、Family 撤销和重放审计。调用方无法通过该接口将状态查询与轮换拆分。审计失败会回滚重放撤销。审计元数据只包含 `userId`、`sessionId` 和 `tokenId`，Family 是事件目标；不记录原始凭证和 Hash。

```ts type-equiv
/** Persistence owns family serialization, locked state reads, and atomic replay revocation and audit. */
interface RefreshTokenStore {
  /**
   * Persist an initial token using the same user/family locks as rotation and revocation.
   * @param record - Initial hashed token metadata for a newly generated family.
   */
  create(record: RefreshTokenRecord): Promise<void>
  /**
   * Rotate or revoke a replayed token family in one transaction, including the replay audit.
   * @param tokenHash - Digest identifying the presented refresh credential.
   * @param replacement - New token ID, digest, and expiry; persisted identity is inherited by the store.
   * @param now - Time for expiry checks, consumption, revocation, and audit.
   * @returns The committed outcome; infrastructure failures reject and roll back all writes.
   */
  rotate(tokenHash: string, replacement: RefreshTokenReplacement, now: Date): Promise<RefreshTokenRotationResult>
  /**
   * Revoke active family records under the same locks used by rotation.
   * @param familyId - Family to revoke; a missing family is unchanged.
   */
  revokeFamily(familyId: string): Promise<void>
}
```

[PostgreSQL Store](../../packages/identity/user-auth/src/postgres.ts) 使用 READ COMMITTED 事务，按用户行、Family advisory lock、Token 行的顺序加锁。普通操作对用户行执行 `FOR KEY SHARE`；密码重置先执行 `FOR UPDATE`，再枚举 Family 并按排序顺序加锁。轮换在取得 Family 锁后使用新的 SQL 语句重新读取 Token，并执行 `FOR UPDATE`。它先插入替换 Token，再设置旧 Token 自引用的 `replaced_by`。不同 Family 在其他情况下仍可并发轮换。

[事务锁决策](../../.agents/notes/implemented/bug-fix/2026-11-09-refresh-family-transaction-locks.zh.md)说明并发保证及替代方案。[包参考页](../../packages/identity/user-auth/README.zh.md#understand-the-implementation)说明隔离 PostgreSQL 回归测试的配置。
