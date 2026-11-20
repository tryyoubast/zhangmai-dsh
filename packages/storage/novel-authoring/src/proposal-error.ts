/** Safe application errors for database-owned proposal publication and rollback. */

/** Caller-visible failures; infrastructure and unexpected database errors remain unclassified. */
export type ProposalOperationErrorKind = 'not_found' | 'forbidden' | 'conflict' | 'invalid_request'

const messages: Record<ProposalOperationErrorKind, string> = {
  not_found: 'proposal operation target was not found',
  forbidden: 'proposal operation permission is required',
  conflict: 'proposal operation version conflict',
  invalid_request: 'invalid proposal operation request',
}

/** A safe failure category for publication or rollback; database details are retained only in cause. */
export class ProposalOperationError extends Error {
  /**
   * Create a classified failure without copying private database messages.
   * @param kind - Missing target, denied permission, concurrent conflict, or invalid input.
   * @param options - Optional original cause for internal diagnostics.
   */
  constructor(readonly kind: ProposalOperationErrorKind, options?: ErrorOptions) {
    super(messages[kind], options)
    this.name = 'ProposalOperationError'
  }
}
