import { LoggerUtil } from '../../util/LoggerUtil'
import { FullRepairReceiver } from './FullRepairReceiver'
import { Receiver } from './Receiver'
import { createProcessChannel, runReceiverExecutor } from './ReceiverRuntime'

const log = LoggerUtil.getLogger('ReceiverExecutor')
log.info('Receiver process started.')

const manifest: Record<string, () => Receiver> = {
    FullRepairReceiver: () => new FullRepairReceiver()
}

// Dump issues to the console.
process.on('unhandledRejection', r => console.log(r))

// El nom del receptor arriba pel missatge `init`; `argv[2]` només és un respatller (a `utilityProcess` l'índex pot variar).
runReceiverExecutor(createProcessChannel(), manifest, {
    argvReceiver: process.argv[2],
    exit: code => process.exit(code)
})
