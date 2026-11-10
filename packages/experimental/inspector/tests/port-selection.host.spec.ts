/** Endpoint port-selection rules and Host Worker endpoint publication. */

import { Server } from 'node:http'
import { once } from 'node:events'
import { MessageChannel } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi, type TestContext } from 'vitest'
import { resolveInspectorOptions, startInspector, type InspectorHandle } from '../src/host/bridge/controller.ts'
import { startInspectorWorker, type InspectorWorkerRuntime } from '../src/worker/server.ts'

const startingPort = 9_230

function listenError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`test listen failed: ${code}`), { code })
}

function injectListenErrors(context: TestContext, errors: readonly NodeJS.ErrnoException[]): number[] {
  const attemptedPorts: number[] = []
  const listener = vi.spyOn(Server.prototype, 'listen').mockImplementation(function (this: Server, port: unknown, host?: unknown) {
    if (typeof port !== 'number' || host !== '127.0.0.1') throw new Error('unexpected test listener arguments')
    attemptedPorts.push(port)
    const error = errors[attemptedPorts.length - 1]
    if (error !== undefined) {
      queueMicrotask(() => { this.emit('error', error) })
      return this
    }
    // Keep the requested sequence observable while the kernel owns the live port.
    // Releasing a probed successor lets another process claim it before Worker startup.
    listener.mockRestore()
    return this.listen(0, host)
  })
  context.onTestFinished(() => { listener.mockRestore() })
  return attemptedPorts
}

async function startEndpoint(context: TestContext): Promise<InspectorWorkerRuntime> {
  const channel = new MessageChannel()
  const closed = Promise.all([once(channel.port1, 'close'), once(channel.port2, 'close')])
  context.onTestFinished(async () => {
    channel.port1.close()
    channel.port2.close()
    await closed
  })
  const runtime = await startInspectorWorker({
    config: {
      ...resolveInspectorOptions({ port: startingPort, captureFetch: false }),
      startPort: startingPort,
      targetId: 'port-selection-target',
      clientToken: 'port-selection-client',
    },
    hostSourcePort: channel.port2,
  })
  context.onTestFinished(async () => { await runtime.close() })
  return runtime
}

describe('Inspector endpoint port selection', () => {
  let inspector: InspectorHandle | undefined

  afterEach(async () => {
    vi.restoreAllMocks()
    await inspector?.close()
    inspector = undefined
  })

  it('advances from an occupied starting port and publishes the bound address', async (context) => {
    const attemptedPorts = injectListenErrors(context, [listenError('EADDRINUSE')])
    const runtime = await startEndpoint(context).finally(() => { vi.restoreAllMocks() })

    expect(attemptedPorts).toEqual([startingPort, startingPort + 1])
    expect(runtime.endpoint.port).toBeGreaterThan(0)
    const response = await fetch(`http://127.0.0.1:${String(runtime.endpoint.port)}/json`)
    expect(response.status).toBe(200)
    const targets = await response.json() as { webSocketDebuggerUrl: string }[]
    expect(targets).toHaveLength(1)
    expect(new URL(targets[0]!.webSocketDebuggerUrl).port).toBe(String(runtime.endpoint.port))
  })

  it('reports a forbidden successor without treating EACCES as an occupied port', async (context) => {
    const forbidden = listenError('EACCES')
    const attemptedPorts = injectListenErrors(context, [listenError('EADDRINUSE'), forbidden])

    await expect(startEndpoint(context).finally(() => { vi.restoreAllMocks() })).rejects.toBe(forbidden)
    expect(attemptedPorts).toEqual([startingPort, startingPort + 1])
  })

  it('publishes the kernel-assigned Worker port in every endpoint', async () => {
    inspector = await startInspector({ port: 0, captureFetch: false })
    const selectedPort = Number(new URL(inspector.endpoint.httpUrl).port)

    expect(selectedPort).toBeGreaterThan(0)
    expect(new URL(inspector.endpoint.webSocketDebuggerUrl).port).toBe(String(selectedPort))
    expect(new URL(inspector.endpoint.client.endpoint).port).toBe(String(selectedPort))
    await expect(fetch(new URL('json', inspector.endpoint.httpUrl)).then(response => response.status)).resolves.toBe(200)
  })
})
