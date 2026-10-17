import { LoggerUtil } from '../../util/LoggerUtil'
import { ErrorReply, ReadyReply, Receiver } from './Receiver'

const log = LoggerUtil.getLogger('ReceiverExecutor')

/** Canal del costat del fill: `process.send`/`process.on('message')` (Node) o `process.parentPort` (Electron `utilityProcess`). */
export interface ExecutorChannel {
    send(message: unknown): void
    onMessage(cb: (message: unknown) => void): void
    /** Opcional: es crida si el pare tanca el canal. A `parentPort` pot no existir; el pare sempre fa `kill()`. */
    onClose?(cb: () => void): void
}

export interface ExecutorOptions {
    /** Nom del receptor passat per `argv` (compatibilitat); el missatge `init` el substitueix i és el camí robust. */
    argvReceiver?: string
    exit: (code: number) => void
    /** Espera abans de sortir després d'un error, perquè el missatge d'error arribi al pare. */
    errorExitDelayMs?: number
}

/** Adapta `process` al canal: `parentPort` si som dins d'un `utilityProcess` d'Electron, `process.send` altrament. */
export function createProcessChannel(proc: NodeJS.Process = process): ExecutorChannel {
    const parentPort = (proc as unknown as {
        parentPort?: {
            on(event: string, cb: (e: { data: unknown }) => void): void
            postMessage(m: unknown): void
        }
    }).parentPort

    if(parentPort != null) {
        return {
            send: m => parentPort.postMessage(m),
            onMessage: cb => parentPort.on('message', e => cb(e.data)),
            onClose: cb => { try { parentPort.on('close', () => cb()) } catch { /* no disponible */ } }
        }
    }
    return {
        send: m => { proc.send!(m) },
        onMessage: cb => { proc.on('message', cb) },
        onClose: cb => { proc.on('disconnect', cb) }
    }
}

export function runReceiverExecutor(
    channel: ExecutorChannel,
    manifest: Record<string, () => Receiver>,
    options: ExecutorOptions
): void {

    const errorExitDelayMs = options.errorExitDelayMs ?? 200
    let receiver: Receiver | null = null
    let failed = false

    const has = (name: unknown): name is string =>
        typeof name === 'string' && Object.prototype.hasOwnProperty.call(manifest, name)

    const fail = (displayable: string | undefined): void => {
        failed = true
        channel.send({ response: 'error', displayable } as ErrorReply)
        // Current executor behavior is to terminate on first error. The parent normally kills us first.
        setTimeout(() => options.exit(1), errorExitDelayMs)
    }

    if(has(options.argvReceiver)) {
        receiver = manifest[options.argvReceiver]()
    }

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    channel.onMessage(async message => {
        if(failed) {
            return
        }
        const action = (message as { action?: string } | null)?.action

        if(action === 'init') {
            const name = (message as { receiver?: unknown }).receiver
            if(has(name)) {
                receiver = manifest[name]()
            } else if(receiver == null) {
                log.error(`Unknown receiver '${String(name)}', shutting down..`)
                fail(`Unknown receiver '${String(name)}'`)
                return
            }
            channel.send({ response: 'ready' } as ReadyReply)
            return
        }

        if(receiver == null) {
            fail('Receiver not initialised')
            return
        }

        try {
            await receiver.execute(message, m => channel.send(m))
        } catch(err) {
            log.error('Error During Receiver Operation')
            log.error(err)
            let displayable = undefined
            try {
                log.error('Asking the reciever for more details (if available):')
                displayable = (await receiver.parseError(err)) ?? (err instanceof Error ? err.message : undefined)
                if (displayable) {
                    log.error(`Receiver replied with ${displayable}`)
                } else {
                    log.error('The receiver could not parse the error.')
                }
            } catch(fixme) {
                log.error('The reciever\'s error parser threw also, this is a bug and should be reported.', fixme)
            }
            fail(displayable)
        }
    })

    channel.onClose?.(() => {
        log.info('Channel closed, shutting down.')
        options.exit(0)
    })
}
