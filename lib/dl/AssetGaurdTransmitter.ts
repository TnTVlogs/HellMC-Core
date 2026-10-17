import { join } from 'path'
import { DownloadTransmission, FullRepairReply, ValidateTransmission } from './receivers/FullRepairReceiver'
import { LoggerUtil } from '../util/LoggerUtil'
import { NodeForkSpawner, ReceiverHandle, ReceiverSpawner } from './ReceiverChannel'

const log = LoggerUtil.getLogger('Transmitter')

/** Codi estable de l'error quan el procés receptor mor sense haver respost (crash, antivirus, `kill`). */
export const RECEIVER_EXITED = 'RECEIVER_EXITED'
/** Missatge amb què es rebutgen les operacions pendents quan s'ha cancel·lat el receptor (`destroyReceiver`). */
export const LAUNCH_CANCELLED = 'LAUNCH_CANCELLED'

export class ReceiverExitedError extends Error {
    public readonly code = RECEIVER_EXITED
    constructor(exitCode: number | null, started: boolean) {
        super(`${RECEIVER_EXITED}: The download process stopped unexpectedly (code ${exitCode ?? 'none'}${started ? '' : ', it never started'}). Antivirus software may have blocked it.`)
        this.name = 'ReceiverExitedError'
    }
}

abstract class BaseTransmitter {

    private static defaultSpawner: ReceiverSpawner = new NodeForkSpawner()

    /** Canvia l'estratègia de llançament per a tots els transmissors nous (el client hi posa la de `utilityProcess`). */
    public static setDefaultSpawner(spawner: ReceiverSpawner): void {
        BaseTransmitter.defaultSpawner = spawner
    }

    protected receiver: ReceiverHandle | null = null
    private started = false
    private destroyed = false
    private failed = false
    private readonly pendingRejects = new Set<(err: Error) => void>()

    constructor(private spawner?: ReceiverSpawner) {}

    public spawnReceiver(additionalEnvVars?: NodeJS.ProcessEnv): void {

        if (this.receiver != null) {
            throw new Error('Receiver already spawned!')
        }

        const handle = (this.spawner ?? BaseTransmitter.defaultSpawner)
            .spawn(join(__dirname, 'receivers', 'ReceiverExecutor.js'), this.receiverName(), additionalEnvVars)
        this.receiver = handle
        this.started = false
        this.destroyed = false
        this.failed = false

        handle.onLog((stream, line) => {
            console.log(`${stream === 'out' ? '\x1b[32m' : '\x1b[31m'}[_]\x1b[0m ${line}`)
        })
        handle.onMessage(msg => {
            if((msg as { response?: string } | null)?.response === 'ready') {
                this.started = true
            }
        })
        handle.onExit(code => {
            if(handle !== this.receiver) {
                return
            }
            log.warn(`Receiver exited (code ${code}).`)
            if(!this.destroyed && !this.failed) {
                this.rejectPending(new ReceiverExitedError(code, this.started))
            }
        })

        // El nom del receptor viatja per missatge: no depenem de l'índex d'`argv` (varia entre `fork` i `utilityProcess`).
        handle.postMessage({ action: 'init', receiver: this.receiverName() })
    }

    abstract receiverName(): string

    /** Aturada del receptor (cancel·lació o final normal). Idempotent: mai llança. Rebutja les operacions pendents. */
    public destroyReceiver(): void {
        const receiver = this.receiver
        this.receiver = null
        this.destroyed = true
        if(receiver != null) {
            try {
                receiver.kill()
            } catch (err) {
                log.debug('Receiver already stopped.', err)
            }
        }
        this.rejectPending(new Error(LAUNCH_CANCELLED))
    }

    /** Atura el receptor després d'una resposta d'error i construeix un `Error` real (amb el text amable) per rebutjar. */
    protected failWith(message: { displayable?: string }): Error {
        this.failed = true
        try {
            this.receiver?.kill()
        } catch (err) {
            log.debug('Receiver already stopped.', err)
        }
        return new Error(message.displayable ?? 'Receiver error')
    }

    /**
     * Envia un missatge i espera la resposta final. `handle` rep cada resposta i crida `resolve`/`reject` quan l'operació acaba. Si el fill mor o es cancel·la, la promesa es rebutja.
     */
    protected request<T>(
        message: unknown,
        handle: (reply: FullRepairReply, resolve: (value: T) => void, reject: (err: Error) => void) => void
    ): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const receiver = this.receiver
            if(receiver == null) {
                reject(new Error(this.destroyed ? LAUNCH_CANCELLED : 'Receiver not spawned!'))
                return
            }
            let settled = false
            const rejectOnce = (err: Error): void => {
                if(settled) {
                    return
                }
                settled = true
                this.pendingRejects.delete(rejectOnce)
                reject(err)
            }
            this.pendingRejects.add(rejectOnce)
            receiver.onMessage(msg => {
                if(settled) {
                    return
                }
                handle(msg as FullRepairReply, value => {
                    if(!settled) {
                        settled = true
                        this.pendingRejects.delete(rejectOnce)
                        resolve(value)
                    }
                }, rejectOnce)
            })
            receiver.postMessage(message)
        })
    }

    private rejectPending(err: Error): void {
        for(const reject of [ ...this.pendingRejects ]) {
            reject(err)
        }
        this.pendingRejects.clear()
    }

    get handle(): ReceiverHandle | null {
        return this.receiver
    }

}

export class FullRepair extends BaseTransmitter {

    constructor(
        private commonDirectory: string,
        private instanceDirectory: string,
        private launcherDirectory: string,
        private versionId: string,
        private devMode: boolean,
        // PEM Ed25519 public keys: when non-empty, the receiver only accepts a signed distribution.
        private signingKeys: string[] = [],
        spawner?: ReceiverSpawner
    ) {
        super(spawner)
    }

    /** Estratègia de llançament per defecte per a tots els `FullRepair` (injectada pel client d'Electron). */
    public static setDefaultSpawner(spawner: ReceiverSpawner): void {
        BaseTransmitter.setDefaultSpawner(spawner)
    }

    receiverName(): string {
        return 'FullRepairReceiver'
    }

    public verifyFiles(onProgress: (percent: number) => void): Promise<number> {

        return this.request<number>({
            action: 'validate',
            commonDirectory: this.commonDirectory,
            instanceDirectory: this.instanceDirectory,
            launcherDirectory: this.launcherDirectory,
            versionId: this.versionId,
            devMode: this.devMode,
            signingKeys: this.signingKeys
        } as ValidateTransmission, (message, resolve, reject) => {
            switch(message.response) {
                case 'validateProgress':
                    log.debug('Received validate progress ' + message.percent)
                    onProgress(message.percent)
                    break
                case 'validateComplete':
                    log.info('Received validation complete.')
                    resolve(message.invalidCount)
                    break
                case 'error':
                    log.error('Received error.')
                    reject(this.failWith(message))
                    break
            }
        })

    }

    public download(onProgress: (percent: number) => void): Promise<void> {

        return this.request<void>({
            action: 'download'
        } as DownloadTransmission, (message, resolve, reject) => {
            switch(message.response) {
                case 'downloadProgress':
                    log.debug('Received download progress ' + message.percent)
                    onProgress(message.percent)
                    break
                case 'downloadComplete':
                    log.info('Received download complete.')
                    resolve()
                    break
                case 'error':
                    log.error('Received error.')
                    reject(this.failWith(message))
                    break
            }
        })
    }

}
