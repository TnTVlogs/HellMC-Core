import { expect } from 'chai'
import nock from 'nock'
import { HashAlgo } from '../../lib/dl/Asset'
import { latestCorretto } from '../../lib/java/JavaGuard'

// Nom del fitxer segons la plataforma on corren les proves (igual que latestCorretto).
const os = process.platform === 'win32' ? 'windows' : (process.platform === 'darwin' ? 'macos' : 'linux')
const ext = process.platform === 'win32' ? 'zip' : 'tar.gz'
const arch = process.arch === 'arm64' ? 'aarch64' : 'x64'
const file = `amazon-corretto-17-${arch}-${os}-jdk.${ext}`
const SHA = 'b852a8bc8890149c71141e784cde160d7ecb09bfa82b71209179b25902a0ebe3'

describe('[JavaGuard] Corretto (S12)', () => {

    afterEach(() => {
        nock.cleanAll()
    })

    it('verifica amb SHA-256 (latest_sha256) i no demana mai l\'MD5', async () => {
        nock('https://corretto.aws').head(`/downloads/latest/${file}`).reply(200, '', { 'content-length': '1234' })
        nock('https://corretto.aws').get(`/downloads/latest_sha256/${file}`).reply(200, `${SHA.toUpperCase()}\n`)
        // Si es cridés latest_checksum (MD5), nock no tindria cap interceptor i la crida fallaria.
        const asset = await latestCorretto(17, 'data')
        expect(asset).to.not.equal(null)
        expect(asset!.algo).to.equal(HashAlgo.SHA256)
        expect(asset!.hash).to.equal(SHA)
        expect(asset!.size).to.equal(1234)
        expect(asset!.id).to.equal(file)
        expect(asset!.url).to.equal(`https://corretto.aws/downloads/latest/${file}`)
    })

    it('retorna null si el checksum no és un SHA-256 vàlid (p. ex. un MD5)', async () => {
        nock('https://corretto.aws').head(`/downloads/latest/${file}`).reply(200, '', { 'content-length': '1234' })
        nock('https://corretto.aws').get(`/downloads/latest_sha256/${file}`).reply(200, 'c3de383a035e2cd02279eca5e533f1c8')
        expect(await latestCorretto(17, 'data')).to.equal(null)
    })

    it('retorna null si l\'endpoint SHA-256 respon 404', async () => {
        nock('https://corretto.aws').head(`/downloads/latest/${file}`).reply(200, '', { 'content-length': '1234' })
        nock('https://corretto.aws').get(`/downloads/latest_sha256/${file}`).reply(404)
        expect(await latestCorretto(17, 'data')).to.equal(null)
    })
})
