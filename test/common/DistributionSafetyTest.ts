import { expect } from 'chai'
import { join } from 'path'
import { HeliosDistribution, safeJoin } from '../../lib/common/distribution/DistributionFactory'

const commonDir = join(__dirname, 'files-common')
const instanceDir = join(__dirname, 'files-instances')

function version(id: string, artifactPath?: string): unknown {
    return {
        id,
        name: id,
        minecraftVersion: '1.20.1',
        modules: [{
            id: 'net.hellmc:thing:1.0.0',
            name: 'thing',
            type: 'File',
            artifact: { size: 1, MD5: 'abc', url: 'https://example.com/thing', ...(artifactPath != null ? { path: artifactPath } : {}) }
        }]
    }
}

describe('Distribution path safety (S6)', () => {

    it('safeJoin keeps paths inside the base', () => {
        expect(safeJoin(commonDir, 'a', 'b')).to.equal(join(commonDir, 'a', 'b'))
        expect(() => safeJoin(commonDir, '..', 'x')).to.throw('Unsafe path')
        expect(() => safeJoin(commonDir, 'a', '..', '..', 'x')).to.throw('Unsafe path')
    })

    it('skips a version whose module path escapes the instance folder, keeping the others', () => {
        const distro = new HeliosDistribution({
            version: '1.0.0',
            versions: [version('good', 'config/ok.txt'), version('evil', '../../../../Startup/x.bat')],
            servers: []
        } as never, commonDir, instanceDir)
        expect(distro.versions.map(v => v.rawVersion.id)).to.deep.equal(['good'])
    })

    it('rejects a version id that is a path traversal', () => {
        const distro = new HeliosDistribution({
            version: '1.0.0',
            versions: [version('..', 'config/ok.txt')],
            servers: []
        } as never, commonDir, instanceDir)
        expect(distro.versions).to.have.length(0)
    })

})
