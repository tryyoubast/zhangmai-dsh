/** Own fixed-provider selection and worker cleanup for local acceptance failures. */
type Compose = (args: string[], environment?: NodeJS.ProcessEnv) => Promise<string>

/**
 * Default every Compose operation to the internal model; real acceptance passes an explicit override.
 * @param inherited - parent process environment.
 * @param overrides - settings deliberately supplied by this acceptance operation.
 * @returns the environment for a Compose subprocess.
 */
export function stagingProviderEnvironment(inherited: NodeJS.ProcessEnv, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...inherited, DSH_NOVEL_PROVIDER_URL: 'http://model:8081/v1', ...overrides }
}

/**
 * Recreate the worker with the internal fixed model, overriding inherited provider settings.
 * @param compose - executor for the isolated Compose project.
 * @returns completion after the worker recreation succeeds.
 */
export async function restoreFixedModelWorker(compose: Compose): Promise<void> {
  await compose(['up', '--detach', '--no-deps', '--force-recreate', 'worker'], {
    DSH_NOVEL_PROVIDER_URL: 'http://model:8081/v1',
  })
}

/**
 * Interrupt held model work and restore the worker even when the observation fails.
 * @param compose - executor for the isolated Compose project.
 * @param observeRunning - submission and assertion that the generated work is running.
 * @returns the observed value after interruption and restart; command or assertion failures reject.
 */
export async function interruptWorkerAfter<T>(compose: Compose, observeRunning: () => Promise<T>): Promise<T> {
  try {
    return await observeRunning()
  } finally {
    try {
      await compose(['kill', '--signal', 'SIGKILL', 'worker'])
    } finally {
      await compose(['up', '--detach', '--no-deps', 'worker'])
    }
  }
}
