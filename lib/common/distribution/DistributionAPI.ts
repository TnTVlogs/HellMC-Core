import { resolve } from 'path'
import { Distribution } from 'hellmc-distribution-types'
import got, { HTTPError, RequestError } from 'got'
import { LoggerUtil } from '../../util/LoggerUtil'
import { RestResponse, handleGotError, RestResponseStatus } from '../rest/RestResponse'
import { move, pathExists, readFile, remove, writeJson } from 'fs-extra'
import { HeliosDistribution } from './DistributionFactory'
import { DistributionVerifier } from './DistributionSignature'
import { writeFile } from 'fs/promises'

// TODO Option to check endpoint for hash of distro for local compare
// Useful if distro is large (MBs)

export class DistributionAPI {

    private static readonly log = LoggerUtil.getLogger('DistributionAPI')

    private readonly DISTRO_FILE = 'distribution.json'
    private readonly DISTRO_FILE_DEV = 'distribution_dev.json'

    private distroPath: string
    private distroDevPath: string

    private distribution!: HeliosDistribution
    private rawDistribution!: Distribution

    constructor(
        private launcherDirectory: string,
        private commonDir: string,
        private instanceDir: string,
        private remoteUrl: string,
        private devMode: boolean,
        // S1: when set, the distribution must carry a valid detached signature (`<url>.sig`) or it is ignored.
        private verifier: DistributionVerifier | null = null
    ) {
        this.distroPath = resolve(launcherDirectory, this.DISTRO_FILE)
        this.distroDevPath = resolve(launcherDirectory, this.DISTRO_FILE_DEV)
    }

    // Memoized so concurrent first callers share ONE fetch (and one write of distribution.json).
    private initialLoad: Promise<HeliosDistribution> | null = null

    public async getDistribution(): Promise<HeliosDistribution> {
        if(this.distribution == null) {
            this.initialLoad = this.initialLoad ?? (async (): Promise<HeliosDistribution> => {
                try {
                    const raw = await this.loadDistribution()
                    const built = new HeliosDistribution(raw, this.commonDir, this.instanceDir)
                    this.rawDistribution = raw
                    this.distribution = built
                    return built
                } finally {
                    this.initialLoad = null
                }
            })()
            return await this.initialLoad
        }
        return this.distribution
    }

    public async getDistributionLocalLoadOnly(): Promise<HeliosDistribution> {
        if(this.rawDistribution == null) {
            const x = await this.pullLocal()
            if(x == null) {
                throw new Error('FATAL: Unable to load distribution from local disk.')
            }
            this.rawDistribution = x
            this.distribution = new HeliosDistribution(this.rawDistribution, this.commonDir, this.instanceDir)
        }
        return this.distribution
    }

    public async refreshDistributionOrFallback(): Promise<HeliosDistribution> {

        const distro = await this._loadDistributionNullable()

        if(distro == null) {
            DistributionAPI.log.warn('Failed to refresh distribution, falling back to current load (if exists).')
            return this.distribution
        } else {
            // Build first, assign after: a distribution that cannot be built must not replace the working one.
            const built = new HeliosDistribution(distro, this.commonDir, this.instanceDir)
            this.rawDistribution = distro
            this.distribution = built

            return this.distribution
        }
    }

    public toggleDevMode(dev: boolean): void {
        this.devMode = dev
    }

    public isDevMode(): boolean {
        return this.devMode
    }

    protected async loadDistribution(): Promise<Distribution> {

        const distro = await this._loadDistributionNullable()

        if(distro == null) {
            if(this.signatureProblem) {
                // Not a network problem: the distribution (or its .sig) is missing/invalid and nothing verified is cached.
                throw new Error('DISTRIBUTION_SIGNATURE_INVALID: no distribution with a valid signature is available.')
            }
            throw new Error('FATAL: Unable to load distribution from remote server or local disk.')
        }

        return distro
    }

    protected async _loadDistributionNullable(): Promise<Distribution | null> {

        this.signatureProblem = false

        let distro

        if(!this.devMode) {

            distro = (await this.pullRemote()).data
            if(distro != null && !this.isUsable(distro)) {
                // A 200 whose body is not a usable distribution (error page as JSON, half-published file...) must NEVER
                // overwrite the good local copy.
                DistributionAPI.log.error('Remote distribution is not usable, ignoring it and using the local copy.')
                distro = null
            }
            if(distro == null) {
                distro = await this.pullLocal()
            } else {
                await this.writeDistributionToDisk(distro)
            }

        } else {
            distro = await this.pullLocal()
        }

        return distro
    }

    /** Raw bytes + signature of the last verified remote download, written to disk verbatim so they can be re-verified. */
    private lastVerified: { raw: Buffer, signature: Buffer } | null = null

    /** Set when the last attempt failed because of the signature (missing .sig, invalid, or unsigned cache), not the network. */
    private signatureProblem = false

    protected async pullRemote(): Promise<RestResponse<Distribution | null>> {

        if(this.verifier != null) {
            return await this.pullRemoteVerified()
        }

        try {

            // Modified by HellMC (TnTVlogs), 2026-09-25: bound the remote distribution
            // fetch with an explicit timeout instead of relying on got's defaults.
            const res = await got.get<Distribution>(this.remoteUrl, {
                responseType: 'json',
                timeout: {
                    lookup: 10000,
                    connect: 10000,
                    secureConnect: 10000,
                    socket: 15000,
                    send: 10000,
                    response: 15000
                }
            })

            return {
                data: res.body,
                responseStatus: RestResponseStatus.SUCCESS
            }

        } catch(error) {

            return handleGotError('Pull Remote', error as RequestError, DistributionAPI.log, () => null)

        }
        
    }

    /** Structural check + trial build (HeliosDistribution skips individual broken versions but needs the basics). */
    protected isUsable(distro: unknown): distro is Distribution {
        if(distro == null || typeof distro !== 'object') {
            return false
        }
        const d = distro as Partial<Distribution>
        if(!Array.isArray(d.versions) || (d.servers != null && !Array.isArray(d.servers))) {
            return false
        }
        try {
            const built = new HeliosDistribution(d as Distribution, this.commonDir, this.instanceDir)
            // The file declares versions but every one of them is broken: not usable.
            return d.versions.length === 0 || built.versions.length > 0
        } catch(err) {
            DistributionAPI.log.error('Distribution could not be built.', err)
            return false
        }
    }

    protected async pullRemoteVerified(): Promise<RestResponse<Distribution | null>> {
        const timeout = { lookup: 10000, connect: 10000, secureConnect: 10000, socket: 15000, send: 10000, response: 15000 }
        try {
            const [file, sig] = await Promise.all([
                got.get(this.remoteUrl, { responseType: 'buffer', timeout }),
                got.get(`${this.remoteUrl}.sig`, { responseType: 'buffer', timeout })
            ])
            const signature = Buffer.from(sig.body.toString('utf8').trim(), 'base64')
            if(!this.verifier!.verify(file.body, signature)) {
                DistributionAPI.log.error('SECURITY: the remote distribution signature is INVALID. Ignoring it.')
                this.signatureProblem = true
                return { data: null, responseStatus: RestResponseStatus.ERROR } as RestResponse<Distribution | null>
            }
            this.lastVerified = { raw: file.body, signature }
            this.signatureProblem = false
            return { data: JSON.parse(file.body.toString('utf8')) as Distribution, responseStatus: RestResponseStatus.SUCCESS }
        } catch(error) {
            // A 404/403 on the .sig itself means the server is not signing (yet): a signature problem, not a connectivity one.
            if(error instanceof HTTPError && error.request?.requestUrl?.toString().endsWith('.sig')) {
                this.signatureProblem = true
            }
            return handleGotError('Pull Remote (verified)', error as RequestError, DistributionAPI.log, () => null)
        }
    }

    protected async writeDistributionToDisk(distribution: Distribution): Promise<void> {
        // Atomic: a crash mid-write must not leave a truncated distribution.json.
        const tmp = `${this.distroPath}.tmp`
        try {
            if(this.lastVerified != null) {
                // Verbatim bytes + signature, so the local copy can be verified again when read.
                await writeFile(`${this.distroPath}.sig`, this.lastVerified.signature.toString('base64'))
                await writeFile(tmp, this.lastVerified.raw)
            } else {
                await writeJson(tmp, distribution)
            }
            await move(tmp, this.distroPath, { overwrite: true })
        } catch(err) {
            await remove(tmp).catch(() => { /* nothing to clean */ })
            throw err
        }
    }

    protected async pullLocal(): Promise<Distribution | null> {
        return await this.readDistributionFromFile(!this.devMode ? this.distroPath : this.distroDevPath)
    }

    protected async readDistributionFromFile(path: string): Promise<Distribution | null> {

        if(await pathExists(path)) {
            const rawBytes = await readFile(path)
            if(this.verifier != null && !this.devMode) {
                const sigPath = `${path}.sig`
                const valid = await pathExists(sigPath)
                    && this.verifier.verify(rawBytes, Buffer.from((await readFile(sigPath, 'utf-8')).trim(), 'base64'))
                if(!valid) {
                    DistributionAPI.log.error(`SECURITY: local distribution at ${path} has no valid signature. Ignoring it.`)
                    this.signatureProblem = true
                    return null
                }
            }
            const raw = rawBytes.toString('utf-8')
            try {
                return JSON.parse(raw) as Distribution
            } catch(error) {
                DistributionAPI.log.error(`Malformed distribution file at ${path}`)
                return null
            }
        } else {
            DistributionAPI.log.error(`No distribution file found at ${path}!`)
            return null
        }

    }

}