import { createPublicKey, KeyObject, verify } from 'crypto'

/**
 * Verifies the detached signature of the distribution file (`distribution.json` + `distribution.json.sig`).
 *
 * The signature is Ed25519 over the **exact bytes** of the file, base64 encoded in the `.sig` file. Several public keys
 * may be trusted at once (current + backup) so the signing key can be rotated without breaking installed clients.
 */
export interface DistributionVerifier {
    verify(data: Buffer, signature: Buffer): boolean
}

export class Ed25519Verifier implements DistributionVerifier {

    private readonly keys: KeyObject[]

    /** @param publicKeysPem Ed25519 public keys in PEM (SPKI) format. At least one is required. */
    constructor(publicKeysPem: string[]) {
        if(publicKeysPem.length === 0) {
            throw new Error('At least one public key is required to verify the distribution.')
        }
        this.keys = publicKeysPem.map(pem => createPublicKey(pem))
    }

    public verify(data: Buffer, signature: Buffer): boolean {
        return this.keys.some(key => {
            try {
                return verify(null, data, key, signature)
            } catch {
                return false
            }
        })
    }

}
