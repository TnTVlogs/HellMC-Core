import { join } from 'path'
import { expect } from 'chai'
import { FullRepair, LAUNCH_CANCELLED, RECEIVER_EXITED, ReceiverExitedError } from '../../lib/dl/AssetGaurdTransmitter'
import { NodeForkSpawner, ReceiverHandle, ReceiverSpawner } from '../../lib/dl/ReceiverChannel'
import { ExecutorChannel, runReceiverExecutor } from '../../lib/dl/receivers/ReceiverRuntime'
import { Receiver, ReplyFn } from '../../lib/dl/receivers/Receiver'

/** Spawner de proves: executa el receptor fals en un fill Node real, en lloc del `ReceiverExecutor.js`. */
class FakeExecutorSpawner implements ReceiverSpawner {
    public lastHandle: ReceiverHandle | null = null
    public lastEnv: NodeJS.ProcessEnv | undefined
    spawn(_modulePath: string, receiverName: string, extraEnv?: NodeJS.ProcessEnv): ReceiverHandle {
        this.lastEnv = extraEnv
        this.lastHandle = new NodeForkSpawner().spawn(join(__dirname, 'files', 'fakeExecutor.js'), receiverName, extraEnv)
        return this.lastHandle
    }
}

const repairFor = (versionId: string, spawner: ReceiverSpawner): FullRepair =>
    new FullRepair('c', 'i', 'l', versionId, false, [], spawner)

const waitDead = async (h: ReceiverHandle): Promise<void> => {
    for(let i = 0; i < 100 && h.alive; i++) {
        await new Promise(r => setTimeout(r, 20))
    }
}

describe('FullRepair transmitter (fill real en Node)', function() {
    this.timeout(10000)

    it('verifies and reports progress, then kills the child on destroy', async () => {
        const spawner = new FakeExecutorSpawner()
        const repair = repairFor('ok', spawner)
        repair.spawnReceiver({ HELLMC_TEST: '1' })
        const progress: number[] = []
        const invalid = await repair.verifyFiles(p => progress.push(p))
        expect(invalid).to.equal(3)
        expect(progress).to.deep.equal([ 50 ])
        expect(spawner.lastEnv).to.deep.equal({ HELLMC_TEST: '1' })
        repair.destroyReceiver()
        await waitDead(spawner.lastHandle!)
        expect(spawner.lastHandle!.alive).to.equal(false)
    })

    it('maps an error reply to Error(displayable) and stops the child', async () => {
        const spawner = new FakeExecutorSpawner()
        const repair = repairFor('err', spawner)
        repair.spawnReceiver()
        let err: unknown
        try { await repair.verifyFiles(() => undefined) } catch(e) { err = e }
        expect(err).to.be.instanceOf(Error)
        expect((err as Error).message).to.equal('Request received no response (ENOTFOUND).')
        await waitDead(spawner.lastHandle!)
        expect(spawner.lastHandle!.alive).to.equal(false)
        expect(() => { repair.destroyReceiver(); repair.destroyReceiver() }).to.not.throw()
    })

    it('rejects with RECEIVER_EXITED if the child dies without answering', async () => {
        const repair = repairFor('die', new FakeExecutorSpawner())
        repair.spawnReceiver()
        let err: unknown
        try { await repair.verifyFiles(() => undefined) } catch(e) { err = e }
        expect(err).to.be.instanceOf(ReceiverExitedError)
        expect((err as ReceiverExitedError).code).to.equal(RECEIVER_EXITED)
        expect((err as Error).message).to.match(/^RECEIVER_EXITED: .*code 3/)
        repair.destroyReceiver()
    })

    it('rejects a pending download with LAUNCH_CANCELLED when destroyed mid-download, and kills the child', async () => {
        const spawner = new FakeExecutorSpawner()
        const repair = repairFor('ok', spawner)
        repair.spawnReceiver()
        await repair.verifyFiles(() => undefined)
        const percents: number[] = []
        const pending = repair.download(p => percents.push(p))
        // Espera el primer progrés (el fill és viu i «descarregant»).
        for(let i = 0; i < 100 && percents.length === 0; i++) {
            await new Promise(r => setTimeout(r, 20))
        }
        expect(percents).to.deep.equal([ 10 ])
        repair.destroyReceiver()
        let err: unknown
        try { await pending } catch(e) { err = e }
        expect((err as Error).message).to.equal(LAUNCH_CANCELLED)
        await waitDead(spawner.lastHandle!)
        expect(spawner.lastHandle!.alive).to.equal(false)
        repair.destroyReceiver()
    })

    it('rejects operations started after destroyReceiver', async () => {
        const repair = repairFor('ok', new FakeExecutorSpawner())
        repair.spawnReceiver()
        repair.destroyReceiver()
        let err: unknown
        try { await repair.verifyFiles(() => undefined) } catch(e) { err = e }
        expect((err as Error).message).to.equal(LAUNCH_CANCELLED)
    })

    it('refuses to spawn twice', () => {
        const repair = repairFor('ok', new FakeExecutorSpawner())
        repair.spawnReceiver()
        expect(() => repair.spawnReceiver()).to.throw('already spawned')
        repair.destroyReceiver()
    })
})

describe('runReceiverExecutor (protocol del fill, canal en memòria)', () => {

    const makeChannel = (): { channel: ExecutorChannel, sent: unknown[], push: (m: unknown) => Promise<void>, close: () => void } => {
        const sent: unknown[] = []
        let handler: (m: unknown) => unknown = () => undefined
        let closeCb: () => void = () => undefined
        return {
            channel: { send: m => { sent.push(m) }, onMessage: cb => { handler = cb }, onClose: cb => { closeCb = cb } },
            sent,
            push: async m => { await handler(m) },
            close: () => closeCb()
        }
    }

    const okReceiver = (): Receiver => ({
        execute: (m: unknown, reply: ReplyFn) => { reply({ response: 'echo', m }); return Promise.resolve() },
        parseError: () => Promise.resolve(undefined)
    })

    it('answers ready on init and passes a working reply() to the receiver', async () => {
        const c = makeChannel()
        runReceiverExecutor(c.channel, { R: okReceiver }, { exit: () => undefined })
        await c.push({ action: 'init', receiver: 'R' })
        await c.push({ action: 'ping' })
        expect(c.sent).to.deep.equal([ { response: 'ready' }, { response: 'echo', m: { action: 'ping' } } ])
    })

    it('uses argv receiver as fallback when no init name is valid', async () => {
        const c = makeChannel()
        runReceiverExecutor(c.channel, { R: okReceiver }, { argvReceiver: 'R', exit: () => undefined })
        await c.push({ action: 'ping' })
        expect(c.sent).to.deep.equal([ { response: 'echo', m: { action: 'ping' } } ])
    })

    it('rejects an unknown receiver with an error reply and exits 1', async () => {
        const c = makeChannel()
        const codes: number[] = []
        runReceiverExecutor(c.channel, { R: okReceiver }, { exit: code => codes.push(code), errorExitDelayMs: 1 })
        await c.push({ action: 'init', receiver: 'nope' })
        await new Promise(r => setTimeout(r, 20))
        expect(c.sent[0]).to.deep.include({ response: 'error' })
        expect(codes).to.deep.equal([ 1 ])
    })

    it('turns a thrown error into an error reply with displayable, then exits 1 and ignores further messages', async () => {
        const c = makeChannel()
        const codes: number[] = []
        const bad: Receiver = {
            execute: () => Promise.reject(new Error('boom')),
            parseError: () => Promise.resolve('Friendly boom')
        }
        runReceiverExecutor(c.channel, { B: () => bad }, { exit: code => codes.push(code), errorExitDelayMs: 1 })
        await c.push({ action: 'init', receiver: 'B' })
        await c.push({ action: 'x' })
        await c.push({ action: 'y' })
        await new Promise(r => setTimeout(r, 20))
        expect(c.sent).to.deep.equal([ { response: 'ready' }, { response: 'error', displayable: 'Friendly boom' } ])
        expect(codes).to.deep.equal([ 1 ])
    })

    it('falls back to the Error message when the receiver cannot parse it', async () => {
        const c = makeChannel()
        const bad: Receiver = { execute: () => Promise.reject(new Error('plain')), parseError: () => Promise.resolve(undefined) }
        runReceiverExecutor(c.channel, { B: () => bad }, { exit: () => undefined, errorExitDelayMs: 1 })
        await c.push({ action: 'init', receiver: 'B' })
        await c.push({ action: 'x' })
        expect(c.sent[1]).to.deep.equal({ response: 'error', displayable: 'plain' })
    })

    it('exits 0 when the channel closes', () => {
        const c = makeChannel()
        const codes: number[] = []
        runReceiverExecutor(c.channel, { R: okReceiver }, { exit: code => codes.push(code) })
        c.close()
        expect(codes).to.deep.equal([ 0 ])
    })
})
