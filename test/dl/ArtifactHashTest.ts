import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { expect } from 'chai'
import { mkdtemp, outputFile, remove } from 'fs-extra'
import { HeliosDistribution } from '../../lib/common/distribution/DistributionFactory'
import { DistributionIndexProcessor } from '../../lib/dl/distribution/DistributionIndexProcessor'
import { resolveArtifactHash, MODULE_HASH_INVALID, MODULE_HASH_MISSING, ArtifactHashError } from '../../lib/dl/distribution/ArtifactHash'
import { HashAlgo } from '../../lib/dl/Asset'
import { validateLocalFile } from '../../lib/common/util/FileUtils'

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
const art = (extra: Record<string, unknown>): never => ({ size: 1, url: 'https://example.com/x', ...extra }) as never

describe('resolveArtifactHash', () => {

    it('returns the sha256 (lowercased) for a valid hash', () => {
        const h = sha('x')
        expect(resolveArtifactHash('m', art({ sha256: h }))).to.deep.equal({ algo: HashAlgo.SHA256, hash: h })
        expect(resolveArtifactHash('m', art({ sha256: h.toUpperCase() }))?.hash).to.equal(h)
    })

    it('returns null only for an explicitly untracked artifact', () => {
        expect(resolveArtifactHash('m', art({ untracked: true }))).to.equal(null)
    })

    it('refuses a tracked module without hash, with a stable code', () => {
        let err: unknown
        try { resolveArtifactHash('mod-1', art({})) } catch(e) { err = e }
        expect(err).to.be.instanceOf(ArtifactHashError)
        expect((err as ArtifactHashError).code).to.equal(MODULE_HASH_MISSING)
        expect((err as Error).message).to.match(/^MODULE_HASH_MISSING: .*mod-1/)
    })

    it('ignores a legacy MD5 and still refuses the module', () => {
        expect(() => resolveArtifactHash('m', art({ MD5: 'd41d8cd98f00b204e9800998ecf8427e' }))).to.throw(MODULE_HASH_MISSING)
    })

    it('refuses a malformed sha256 (never falls back to untracked)', () => {
        for(const bad of ['abc', 'z'.repeat(64), sha('x') + '0', '']) {
            expect(() => resolveArtifactHash('m', art({ sha256: bad, untracked: true }))).to.throw(MODULE_HASH_INVALID)
        }
    })

})

describe('validateLocalFile with SHA-256', () => {
    let dir = ''
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'hellmc-hash-')) })
    afterEach(async () => { await remove(dir) })

    it('accepts the right hash, rejects a wrong one, and a missing file', async () => {
        const p = join(dir, 'a.txt')
        await outputFile(p, 'hello')
        expect(await validateLocalFile(p, HashAlgo.SHA256, sha('hello'))).to.equal(true)
        expect(await validateLocalFile(p, HashAlgo.SHA256, sha('hello').toUpperCase())).to.equal(true)
        expect(await validateLocalFile(p, HashAlgo.SHA256, sha('other'))).to.equal(false)
        expect(await validateLocalFile(join(dir, 'nope'), HashAlgo.SHA256, sha('hello'))).to.equal(false)
    })
})

describe('DistributionIndexProcessor.validate (SHA-256)', () => {
    let root = ''
    beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'hellmc-dip-')) })
    afterEach(async () => { await remove(root) })

    function processor(artifact: Record<string, unknown>): DistributionIndexProcessor {
        const distro = new HeliosDistribution({
            version: '1.0.0',
            servers: [],
            versions: [{
                id: 'v1', name: 'v1', minecraftVersion: '1.20.1',
                modules: [{ id: 'net.hellmc:thing:1.0.0', name: 'thing', type: 'File', artifact: { size: 5, url: 'https://example.com/thing', path: 'thing.txt', ...artifact } }]
            }]
        } as never, join(root, 'common'), join(root, 'instances'))
        return new DistributionIndexProcessor(join(root, 'common'), distro, 'v1')
    }
    const filePath = (): string => join(root, 'instances', 'v1', 'thing.txt')

    it('reports a missing file for download, carrying algo and hash', async () => {
        const res = await processor({ sha256: sha('hello') }).validate(async () => undefined)
        expect(res.distribution).to.have.length(1)
        expect(res.distribution[0].algo).to.equal(HashAlgo.SHA256)
        expect(res.distribution[0].hash).to.equal(sha('hello'))
    })

    it('accepts a file with the correct hash', async () => {
        await outputFile(filePath(), 'hello')
        const res = await processor({ sha256: sha('hello') }).validate(async () => undefined)
        expect(res.distribution).to.have.length(0)
    })

    it('flags a file with an incorrect hash for repair', async () => {
        await outputFile(filePath(), 'tampered')
        const res = await processor({ sha256: sha('hello') }).validate(async () => undefined)
        expect(res.distribution).to.have.length(1)
    })

    it('rejects a tracked module without hash (does not treat the existing file as valid)', async () => {
        await outputFile(filePath(), 'hello')
        let message = ''
        try { await processor({}).validate(async () => undefined) } catch(e) { message = (e as Error).message }
        expect(message).to.match(/^MODULE_HASH_MISSING:/)
    })

    it('keeps an existing untracked file untouched and downloads a missing one', async () => {
        expect((await processor({ untracked: true }).validate(async () => undefined)).distribution).to.have.length(1)
        await outputFile(filePath(), 'user edited')
        expect((await processor({ untracked: true }).validate(async () => undefined)).distribution).to.have.length(0)
    })
})
