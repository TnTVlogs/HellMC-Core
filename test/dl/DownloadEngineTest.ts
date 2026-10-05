import { createServer, Server } from 'http'
import { AddressInfo } from 'net'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { expect } from 'chai'
import { mkdtemp, readFile, readdir, remove } from 'fs-extra'
import { downloadFile, downloadQueue } from '../../lib/dl/DownloadEngine'
import { HashAlgo } from '../../lib/dl/Asset'

// Local HTTP server (127.0.0.1 is the only plain-HTTP host the engine accepts).
describe('DownloadEngine', () => {

    const body = Buffer.from('hello hellmc')
    const goodHash = createHash('md5').update(body).digest('hex')
    let server: Server
    let base = ''
    let dir = ''
    let failuresLeft = 0

    before(async () => {
        server = createServer((req, res) => {
            if(req.url === '/flaky' && failuresLeft > 0) {
                failuresLeft--
                res.statusCode = 503
                res.end('busy')
            } else if(req.url === '/bad') {
                res.end('tampered content')
            } else if(req.url === '/missing') {
                res.statusCode = 404
                res.end()
            } else {
                res.end(body)
            }
        })
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    })

    after(async () => {
        await new Promise(resolve => server.close(resolve))
    })

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'hellmc-dl-'))
        failuresLeft = 0
    })

    afterEach(async () => {
        await remove(dir)
    })

    it('retries transient 503 responses', async () => {
        failuresLeft = 2
        await downloadFile(`${base}/flaky`, join(dir, 'a.bin'))
        expect((await readFile(join(dir, 'a.bin'))).toString()).to.equal('hello hellmc')
    }).timeout(15000)

    it('leaves no .part file behind after a failure', async () => {
        let thrown = false
        try {
            await downloadFile(`${base}/missing`, join(dir, 'b.bin'))
        } catch {
            thrown = true
        }
        expect(thrown).to.equal(true)
        expect(await readdir(dir)).to.deep.equal([])
    })

    it('refuses insecure non-local URLs', async () => {
        let message = ''
        try {
            await downloadFile('http://example.com/x.jar', join(dir, 'c.bin'))
        } catch(err) {
            message = (err as Error).message
        }
        expect(message).to.contain('insecure')
    })

    it('rejects a file whose hash does not match and removes it', async () => {
        const asset = { id: 'bad', url: `${base}/bad`, path: join(dir, 'bad.bin'), size: 16, algo: HashAlgo.MD5, hash: goodHash }
        let message = ''
        try {
            await downloadQueue([asset], () => undefined)
        } catch(err) {
            message = (err as Error).message
        }
        expect(message).to.contain('expected hash')
        expect(await readdir(dir)).to.deep.equal([])
    })

    it('accepts a file whose hash matches', async () => {
        const asset = { id: 'ok', url: `${base}/ok`, path: join(dir, 'ok.bin'), size: body.length, algo: HashAlgo.MD5, hash: goodHash }
        const totals = await downloadQueue([asset], () => undefined)
        expect(totals.ok).to.equal(body.length)
        expect((await readFile(join(dir, 'ok.bin'))).equals(body)).to.equal(true)
    })

})
