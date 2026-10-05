import { createHash } from 'crypto'
import { dirname, isAbsolute, join, relative, resolve } from 'path'
import { pathExists, createReadStream, remove, unlink } from 'fs-extra'
import { LoggerUtil } from '../..//util/LoggerUtil'
import { StreamZipAsync } from 'node-stream-zip'
import StreamZip from 'node-stream-zip'
import { createGunzip } from 'zlib'
import tar from 'tar-fs'

const log = LoggerUtil.getLogger('FileUtils')

export function calculateHashByBuffer(buf: Buffer, algo: string): string {
    return createHash(algo).update(buf).digest('hex')
}

export function calculateHash(path: string, algo: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash(algo)
        const input = createReadStream(path)

        input.on('error', reject)
        input.on('data', chunk => hash.update(chunk))
        input.on('close', () => resolve(hash.digest('hex')))
    })
}

export async function validateLocalFile(path: string, algo: string, hash?: string): Promise<boolean> {
    if(await pathExists(path)) {
        if(hash == null) {
            return true
        }
        
        try {
            return (await calculateHash(path, algo)) === hash
        } catch(err) {
            log.error('Failed to calculate hash.', err)
        }
    }
    return false
}

function getVersionExtPath(commonDir: string, version: string, ext: string): string {
    return join(commonDir, 'versions', version, `${version}.${ext}`)
}

export function getVersionJsonPath(commonDir: string, version: string): string {
    return getVersionExtPath(commonDir, version, 'json')
}

export function getVersionJarPath(commonDir: string, version: string): string {
    return getVersionExtPath(commonDir, version, 'jar')
}

export function getLibraryDir(commonDir: string): string {
    return join(commonDir, 'libraries')
}

export async function extractZip(zipPath: string, peek?: (zip: StreamZipAsync) => Promise<void>): Promise<void> {
    const zip = new StreamZip.async({
        file: zipPath,
        storeEntries: true
    })

    if(peek) {
        await peek(zip)
    }

    try {
        const outDir = dirname(zipPath)

        // Zip-slip guard: every entry must stay inside the extraction folder.
        const entries = await zip.entries()
        for(const name of Object.keys(entries)) {
            const rel = relative(outDir, resolve(outDir, name))
            if(rel.startsWith('..') || isAbsolute(rel)) {
                throw new Error(`Unsafe path inside archive: ${name}`)
            }
        }

        log.info(`Extracting ${zipPath}`)
        await zip.extract(null, outDir)
        log.info(`Removing ${zipPath}`)
        await remove(zipPath)
        log.info('Zip extraction complete.')

    } catch(err) {
        log.error('Zip extraction failed', err)
        // Do not report success: a half-extracted JDK would otherwise be registered as "installed".
        throw err
    } finally {
        await zip.close()
    }
}

export async function extractTarGz(tarGzPath: string, peek?: (header: tar.Headers) => void): Promise<void> {
    return new Promise((resolve, reject) => {
        createReadStream(tarGzPath)
            .on('error', err => log.error(err))
            .pipe(createGunzip())
            .on('error', err => log.error(err))
            .pipe(tar.extract(dirname(tarGzPath), {
                map: (header) => {
                    if(peek) {
                        peek(header)
                    }
                    return header
                }
            }))
            .on('error', err => {
                log.error(err)
                reject(err)
            })
            .on('finish', () => {
                unlink(tarGzPath, err => {
                    if(err){
                        log.error(err)
                        reject()
                    } else {
                        resolve()
                    }
                })
            })
    })
    
}