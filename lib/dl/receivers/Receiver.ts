/** Envia una resposta al transmissor (pare). Abstreu el canal: `process.send` (Node) o `parentPort` (Electron). */
export type ReplyFn = (message: unknown) => void

export interface Receiver {

    execute(message: unknown, reply: ReplyFn): Promise<void>

    parseError(error: unknown): Promise<string | undefined>

}

export interface ErrorReply {
    response: 'error'
    displayable?: string
}

export interface ReadyReply {
    response: 'ready'
}
