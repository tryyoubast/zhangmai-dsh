import {
  validateNovelGenerationAdapterResult,
  type DraftGenerationResult,
  type LongformGenerationService,
  type NovelGenerationAdapterResult,
} from './generation.ts'
import type { ContextCandidate } from './index.ts'
import type { GenerationMaterializationService, MaterializationResult } from './materialization.ts'
import type { GenerationRunInput, GenerationRunStatus, NovelAuthoringService } from './index.ts'

/** Input for one user-requested long-form generation task. */
export interface NovelGenerationWorkflowInput extends Omit<GenerationRunInput, 'generationRunId'> {
  readonly instruction: string
  readonly limit: number
}

/** Optional model-backed extraction pass for chapter summaries, facts, and timeline drafts. */
export interface NovelGenerationEnrichmentAdapter {
  enrich(input: {
    readonly generation: DraftGenerationResult
    readonly context: readonly ContextCandidate[]
  }): Promise<NovelGenerationAdapterResult>
}

/** Injected seams for coordinating run lifecycle, generation, and materialization. */
export interface NovelGenerationWorkflowDependencies {
  readonly authoring: Pick<NovelAuthoringService, 'createGenerationRun' | 'getGenerationRunStatus' | 'updateGenerationRunStatus'> | Pick<NovelAuthoringService, 'createGenerationRun' | 'updateGenerationRunStatus'>
  readonly generation: Pick<LongformGenerationService, 'generate' | 'findPersistedResult'>
  readonly enrichment?: NovelGenerationEnrichmentAdapter
  readonly materialization: Pick<GenerationMaterializationService, 'materialize'>
}

/** Durable result returned after drafts and review proposals are persisted. */
export interface NovelGenerationWorkflowResult {
  readonly runId: string
  readonly generation: DraftGenerationResult
  readonly materialization: MaterializationResult
}

/**
 * Coordinates a complete draft-generation lifecycle. Provider failures are
 * recorded as a stable error code; raw provider text never enters the database.
 */
export class NovelGenerationWorkflowService {
  constructor(private readonly dependencies: NovelGenerationWorkflowDependencies) {}

  /** Create, run, materialize, and complete one idempotent generation request. */
  async generate(input: NovelGenerationWorkflowInput): Promise<NovelGenerationWorkflowResult> {
    const runId = await this.dependencies.authoring.createGenerationRun({
      workspaceId: input.workspaceId,
      novelId: input.novelId,
      model: input.model,
      promptVersion: input.promptVersion,
      sourceSessionId: input.sourceSessionId,
      idempotencyKey: input.idempotencyKey,
      instruction: input.instruction,
      contextLimit: input.limit,
    })
    const existingStatus = 'getGenerationRunStatus' in this.dependencies.authoring
      ? await this.dependencies.authoring.getGenerationRunStatus({ workspaceId: input.workspaceId, generationRunId: runId })
      : undefined
    if (existingStatus === 'failed' || existingStatus === 'cancelled') {
      throw new Error(`generation run is ${existingStatus}`)
    }
    if (existingStatus === 'completed') {
      const persisted = await this.dependencies.generation.findPersistedResult({
        workspaceId: input.workspaceId,
        novelId: input.novelId,
        idempotencyKey: input.idempotencyKey,
      })
      if (persisted === undefined) throw new Error('completed generation result was not found')
      if (persisted.generationRunId !== runId || persisted.workspaceId !== input.workspaceId || persisted.novelId !== input.novelId) {
        throw new Error('generation result scope mismatch')
      }
      const materialization = await this.dependencies.materialization.materialize(persisted)
      return { runId, generation: persisted, materialization }
    }
    await this.dependencies.authoring.updateGenerationRunStatus({
      workspaceId: input.workspaceId,
      generationRunId: runId,
      status: 'running',
    })
    try {
      const generation = await this.dependencies.generation.generate({
        workspaceId: input.workspaceId,
        novelId: input.novelId,
        generationRunId: runId,
        instruction: input.instruction,
        limit: input.limit,
        idempotencyKey: input.idempotencyKey,
      })
      const enriched = this.dependencies.enrichment === undefined
        ? { records: [], proposals: [] }
        : validateNovelGenerationAdapterResult(await this.dependencies.enrichment.enrich({
          generation,
          context: generation.selectedContext,
        }))
      const completeGeneration: DraftGenerationResult = {
        ...generation,
        records: [...generation.records, ...(enriched.records ?? [])],
        proposals: [...generation.proposals, ...(enriched.proposals ?? [])],
      }
      const materialization = await this.dependencies.materialization.materialize(completeGeneration)
      await this.setStatus(input.workspaceId, runId, 'completed')
      return { runId, generation: completeGeneration, materialization }
    } catch (error) {
      await this.setFailure(input.workspaceId, runId)
      throw error
    }
  }

  private async setStatus(workspaceId: string, runId: string, status: Extract<GenerationRunStatus, 'completed'>): Promise<void> {
    await this.dependencies.authoring.updateGenerationRunStatus({ workspaceId, generationRunId: runId, status })
  }

  private async setFailure(workspaceId: string, runId: string): Promise<void> {
    try {
      await this.dependencies.authoring.updateGenerationRunStatus({
        workspaceId,
        generationRunId: runId,
        status: 'failed',
        errorCode: 'GENERATION_FAILED',
        errorSummary: 'The generation provider or draft validation failed.',
      })
    } catch (statusError) {
      // Preserve the provider/materialization error; lifecycle diagnostics are
      // still available to the caller when the database update itself fails.
      void statusError
    }
  }
}
