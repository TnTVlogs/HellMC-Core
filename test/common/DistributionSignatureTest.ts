import { createServer, Server } from 'http'
import { AddressInfo } from 'net'
import { generateKeyPairSync, sign } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { expect } from 'chai'
import { mkdtemp, pathExists, remove, readFile, writeFile } from 'fs-extra'
import { DistributionAPI } from '../../lib/common/distribution/DistributionAPI'
import { Ed25519Verifier } from '../../lib/common/distribution/DistributionSignature'

describe('Distribution signature (S1)', () => {

    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const other = generateKeyPairSync('ed25519')
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()

    const distribution = Buffer.from(JSON.stringify({ version: '1.0.0', rss: '', versions: [], servers: [] }))
    let server: Server
    let base = ''
    let dir = ''
    let signature = ''

    before(async () => {
        server = createServer((req, res) => {
            if(req.url === '/distribution.json') {
                res.setHeader('content-type', 'application/json')
                res.end(distribution)
            } else if(req.url === '/distribution.json.sig') {
                res.end(signature)
            } else {
                res.statusCode = 404
                res.end()
            }
        })
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    })

    after(async () => {
        await new Promise(resolve => server.close(resolve))
    })

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'hellmc-sig-'))
    })

    afterEach(async () => {
        await remove(dir)
    })

    it('accepts a correctly signed distribution and stores the bytes + signature verbatim', async () => {
        signature = sign(null, distribution, privateKey).toString('base64')
        const api = new DistributionAPI(dir, join(dir, 'common'), join(dir, 'instances'), `${base}/distribution.json`, false, new Ed25519Verifier([pem]))
        const loaded = await api.getDistribution()
        expect(loaded.versions).to.have.length(0)
        expect((await readFile(join(dir, 'distribution.json'))).equals(distribution)).to.equal(true)
        expect(await pathExists(join(dir, 'distribution.json.sig'))).to.equal(true)
    })

    it('rejects a distribution signed with another key (and does not write it)', async () => {
        signature = sign(null, distribution, other.privateKey).toString('base64')
        const api = new DistributionAPI(dir, join(dir, 'common'), join(dir, 'instances'), `${base}/distribution.json`, false, new Ed25519Verifier([pem]))
        let message = ''
        try {
            await api.getDistribution()
        } catch(err) {
            message = (err as Error).message
        }
        expect(message).to.contain('DISTRIBUTION_SIGNATURE_INVALID')
        expect(await pathExists(join(dir, 'distribution.json'))).to.equal(false)
    })

    it('rejects a missing signature file', async () => {
        signature = ''
        const api = new DistributionAPI(dir, join(dir, 'common'), join(dir, 'instances'), `${base}/distribution.json`, false, new Ed25519Verifier([pem]))
        let failed = false
        try {
            await api.getDistribution()
        } catch {
            failed = true
        }
        expect(failed).to.equal(true)
    })

    it('does not trust a tampered local copy when the remote is unreachable', async () => {
        signature = sign(null, distribution, privateKey).toString('base64')
        const first = new DistributionAPI(dir, join(dir, 'common'), join(dir, 'instances'), `${base}/distribution.json`, false, new Ed25519Verifier([pem]))
        await first.getDistribution()

        await writeFile(join(dir, 'distribution.json'), JSON.stringify({ version: '1.0.0', versions: [], servers: [], evil: true }))
        const offline = new DistributionAPI(dir, join(dir, 'common'), join(dir, 'instances'), 'http://127.0.0.1:1/distribution.json', false, new Ed25519Verifier([pem]))
        let failed = false
        try {
            await offline.getDistribution()
        } catch {
            failed = true
        }
        expect(failed).to.equal(true)
    }).timeout(30000)

    it('works without a verifier (signatures not enforced yet)', async () => {
        const api = new DistributionAPI(dir, join(dir, 'common'), join(dir, 'instances'), `${base}/distribution.json`, false)
        expect((await api.getDistribution()).versions).to.have.length(0)
    })

})
