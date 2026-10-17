import { ChildProcess, fork, ForkOptions } from 'child_process'

/**
 * Canal entre el transmissor (procés principal) i el receptor (procés fill).
 *
 * `hellmc-core` és agnòstic d'Electron: no importa mai `electron`. El procés que el fa servir injecta una
 * estratègia de llançament (`ReceiverSpawner`); per defecte, `NodeForkSpawner` (Node pur: proves i ús fora d'Electron).
 * El client d'Electron injecta una implementació sobre `utilityProcess.fork` (vegeu `HellMC-Client/src-node/receiverSpawner.js`).
 */
export interface ReceiverHandle {
    postMessage(msg: unknown): void
    onMessage(cb: (msg: unknown) => void): void
    /** Sortida del fill o error de llançament. `null` si no hi ha codi (mort per senyal). */
    onExit(cb: (code: number | null) => void): void
    onLog(cb: (stream: 'out' | 'err', line: string) => void): void
    /** Aturada forçada. Idempotent: no llança si el fill ja ha acabat. */
    kill(): void
    readonly alive: boolean
}

export interface ReceiverSpawner {
    /**
     * @param modulePath Ruta absoluta del `ReceiverExecutor.js`.
     * @param receiverName Nom del receptor (també es lliura per missatge `init`).
     * @param extraEnv Variables addicionals per al fill; l'estratègia decideix l'entorn base.
     */
    spawn(modulePath: string, receiverName: string, extraEnv?: NodeJS.ProcessEnv): ReceiverHandle
}

/** Reparteix un bloc de text de stdout/stderr en línies no buides. */
export function splitLogLines(data: string): string[] {
    return `${data}`.split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.length > 0)
}

/** Estratègia per defecte: `child_process.fork` (Node pur). Hereta `process.env` + `extraEnv`. */
export class NodeForkSpawner implements ReceiverSpawner {

    spawn(modulePath: string, receiverName: string, extraEnv?: NodeJS.ProcessEnv): ReceiverHandle {
        const options: ForkOptions = { stdio: 'pipe' }
        if(extraEnv) {
            options.env = { ...process.env, ...extraEnv }
        }
        const child: ChildProcess = fork(modulePath, [ receiverName ], options)

        let exited = false
        const exitCbs: ((code: number | null) => void)[] = []
        const fireExit = (code: number | null): void => {
            if(exited) {
                return
            }
            exited = true
            exitCbs.forEach(cb => cb(code))
        }
        child.on('exit', code => fireExit(code))
        // Error de llançament (mòdul no trobat, etc.): no hi haurà `exit` fiable.
        child.on('error', () => fireExit(null))

        return {
            postMessage: msg => {
                if(!exited && child.connected) {
                    child.send(msg as never)
                }
            },
            onMessage: cb => { child.on('message', cb) },
            onExit: cb => { exitCbs.push(cb) },
            onLog: cb => {
                child.stdout?.setEncoding('utf8')
                child.stdout?.on('data', (d: string) => splitLogLines(d).forEach(l => cb('out', l)))
                child.stderr?.setEncoding('utf8')
                child.stderr?.on('data', (d: string) => splitLogLines(d).forEach(l => cb('err', l)))
            },
            kill: () => {
                try {
                    if(!exited) {
                        child.kill()
                    }
                } catch {
                    // ja mort
                }
            },
            get alive() { return !exited }
        }
    }

}
