# User authentication

English | [中文](identity-auth.zh.md)

This reference owns refresh-token persistence types declared by [user-auth](../../packages/identity/user-auth/README.md) in the [identity package group](../../packages/identity/README.md). The package reference owns HTTP integration and deployment requirements; the [database reference](database.md) owns connection and migration responsibilities.

Source: [user-auth/src/index.ts](../../packages/identity/user-auth/src/index.ts)

## Stored and replacement material

`RefreshTokenRecord` contains persisted identity and token state. `RefreshTokenReplacement` contains caller-generated material only; the store inherits the replacement's user, session, and family from the locked database record.

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

## Atomic rotation results

`rotated` identifies the committed replacement and its persisted owner. `invalid` includes missing, expired, and revoked credentials. `reused` means the store committed family revocation and the security audit together. The service maps both rejection results to `null`, and the HTTP adapter returns `401 invalid_refresh_token`; infrastructure failures reject instead of reporting a credential outcome.

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

## Persistence responsibility

The store owns state classification, descendant creation, family revocation, and replay auditing. Callers cannot split a state lookup from rotation through this interface. An audit failure rolls back replay revocation. The audit metadata contains only `userId`, `sessionId`, and `tokenId`, with the family as the event target; raw credentials and hashes are excluded.

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

The [PostgreSQL store](../../packages/identity/user-auth/src/postgres.ts) uses READ COMMITTED transactions and orders locks as user row, family advisory lock, then token row. Ordinary operations take the user row `FOR KEY SHARE`; password reset takes it `FOR UPDATE` before enumerating families and locking them in sorted order. Rotation uses a new SQL statement after taking the family lock to re-read the token `FOR UPDATE`. It inserts the replacement before setting the old token's self-referencing `replaced_by`. Different families can otherwise rotate concurrently.

The [transaction-lock decision](../../.agents/notes/implemented/bug-fix/2026-11-09-refresh-family-transaction-locks.md) explains the concurrency guarantees and alternatives. The [package reference](../../packages/identity/user-auth/README.md#understand-the-implementation) describes the isolated PostgreSQL regression configuration.
