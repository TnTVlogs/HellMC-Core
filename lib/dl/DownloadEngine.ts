import { createWriteStream, WriteStream } from 'fs'
import got, { HTTPError, Progress, ReadError, RequestError, TimeoutError } from 'got'
import { pipeline } from 'stream/promises'
import { Asset } from './Asset'
import * as fastq from 'fastq'
import type { queueAsPromised } from 'fastq'
import { ensureDir, move, remove } from 'fs-extra'
import { dirname } from 'path'
import { LoggerUtil } from '../util/LoggerUtil'
import { sleep } from '../util/NodeUtil'
import { validateLocalFile } from '../common/util/FileUtils'

const log = LoggerUtil.getLogger('DownloadEngine')

export function getExpectedDownloadSize(assets: Asset[]): number {
    return assets.map(({ size }) => size).reduce((acc, v) => acc + v, 0)
}

export async function downloadQueue(assets: Asset[], onProgress: (received: number) => void): Promise<{ [id: string]: number }> {

    const receivedTotals: { [id: string]: number } = Object.fromEntries(assets.map(({ id }) => [id, 0]))

    let received = 0

    const onEachProgress = (asset: Asset): (progress: Progress) => void => {
        return ({ transferred }: Progress): void => {
            received += (transferred - receivedTotals[asset.id])
            receivedTotals[asset.id] = transferred
            onProgress(received)
        }
    }

    let firstError: Error | null = null

    const wrap = async (asset: Asset): Promise<void> => {
        if(firstError != null) {
            return
        }
        try {
            await downloadVerified(asset, onEachProgress(asset))
        } catch(err) {
            // Remember the first failure and stop starting new downloads; in-flight ones are awaited below so nothing is left
            // writing behind our back.
            firstError = firstError ?? (err instanceof Error ? err : new Error(String(err)))
        }
    }

    const q: queueAsPromised<Asset, void> = fastq.promise(wrap, 15)

    await Promise.all(assets.map(asset => q.push(asset)))

    const failure = firstError as Error | null
    if(failure != null) {
        throw failure
    }

    return receivedTotals
}

/**
 * Downloads an asset and checks its hash. A mismatch deletes the file and retries once (a truncated/poisoned download must
 * never be left in place or reported as a success); the second mismatch is an error.
 */
async function downloadVerified(asset: Asset, onProgress: (progress: Progress) => void): Promise<void> {
    for(let attempt = 1; attempt <= 2; attempt++) {
        await downloadFile(asset.url, asset.path, onProgress)
        if(asset.hash == null || await validateLocalFile(asset.path, asset.algo, asset.hash)) {
            return
        }
        log.error(`Hash mismatch for ${asset.id} (attempt ${attempt}).`)
        await remove(asset.path)
        onProgress({ transferred: 0, percent: 0, total: 0 })
    }
    throw new Error(`Downloaded file ${asset.id} does not match its expected hash (corrupted or tampered).`)
}

export async function downloadFile(url: string, path: string, onProgress?: (progress: Progress) => void): Promise<void> {

    if(!url.startsWith('https://')) {
        // Plain HTTP offers no integrity; the distribution must use HTTPS.
        if(!/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(url)) {
            throw new Error(`Refusing to download over an insecure URL: ${url}`)
        }
    }

    await ensureDir(dirname(path))

    // Write to a temporary file and move it into place only when complete, so an interrupted download never leaves a
    // truncated file at the final path (untracked files without a hash would otherwise stay corrupt forever).
    const partPath = `${path}.part`

    const MAX_RETRIES = 10
    let fileWriterStream: WriteStream = null!       // The write stream.
    let retryCount = 0                              // The number of retries attempted.
    let error: Error = null!                        // The caught error.
    let retry = false                               // Should we retry.
    let rethrow = false                             // Should we throw an error.

    // Got's streaming retry API is nonexistant and their "example" is egregious.
    // To use their "api" you need to commit yourself to recursive callback hell.
    // No thank you, I prefer this simpler, non error-prone logic.
    do {

        retry = false
        rethrow = false

        if(retryCount > 0) {
            log.debug(`Retry attempt #${retryCount} for ${url}.`)
        }

        try {
            // Modified by HellMC (TnTVlogs), 2026-09-25: bound stalled/unresponsive
            // downloads with an explicit timeout instead of hanging indefinitely.
            const downloadStream = got.stream(url, {
                timeout: {
                    lookup: 10000,
                    connect: 10000,
                    secureConnect: 10000,
                    socket: 30000,
                    send: 10000,
                    response: 10000
                }
            })

            fileWriterStream = createWriteStream(partPath)

            if(onProgress) {
                downloadStream.on('downloadProgress', (progress: Progress) => onProgress(progress))
            }

            await pipeline(downloadStream, fileWriterStream)
            await move(partPath, path, { overwrite: true })

            return

        } catch(err) {
            error = err as Error
            retryCount++
            rethrow = true

            retry = retryCount <= MAX_RETRIES && retryableError(error)

            if(fileWriterStream) {
                fileWriterStream.destroy()
            }
            await remove(partPath).catch(() => { /* nothing to clean */ })

            if(onProgress && retry) {
                // Reset progress on this asset. since we're going to retry.
                onProgress({ transferred: 0, percent: 0, total: 0 })
            }

            if(retry) {
                // Linear backoff, capped at 5s.
                await sleep(Math.min(1000 * retryCount, 5000))
            }
        }

    } while(retry)

    if(rethrow && error) {
        if(retryCount > MAX_RETRIES) {
            log.error(`Maximum retries attempted for ${url}. Rethrowing exception.`)
        } else {
            log.error(`Unknown or unretryable exception thrown during request to ${url}. Rethrowing exception.`)
        }

        throw error
    }

}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

function retryableError(error: Error): boolean {
    if(error instanceof TimeoutError) {
        // Stalled/unresponsive connection (no data within the configured timeout).
        return true
    }
    if(error instanceof HTTPError) {
        // Transient server/CDN errors (e.g. a 503 while the panel is publishing).
        return RETRYABLE_STATUS.has(error.response.statusCode)
    }
    if(error instanceof RequestError) {
        // error.name === 'RequestError' means server did not respond.
        return error.name === 'RequestError' || error instanceof ReadError && error.code === 'ECONNRESET'
    } else {
        return false
    }
}
