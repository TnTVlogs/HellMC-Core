import { Artifact } from 'hellmc-distribution-types'
import { AssetGuardError } from '../AssetGuardError'
import { HashAlgo } from '../Asset'

/** Stable error codes (the message of the thrown error starts with `<CODE>:`, so the client can map it to a translated text). */
export const MODULE_HASH_MISSING = 'MODULE_HASH_MISSING'
export const MODULE_HASH_INVALID = 'MODULE_HASH_INVALID'

const SHA256_HEX = /^[0-9a-f]{64}$/i

export class ArtifactHashError extends AssetGuardError {

    constructor(public readonly code: typeof MODULE_HASH_MISSING | typeof MODULE_HASH_INVALID, moduleId: string) {
        super(code === MODULE_HASH_MISSING
            ? `${code}: module ${moduleId} has no sha256 and is not marked untracked; refusing to use it.`
            : `${code}: module ${moduleId} has a malformed sha256; refusing to use it.`)
    }

}

export interface ArtifactHash {
    algo: HashAlgo.SHA256
    /** 64 lowercase hex characters. */
    hash: string
}

/**
 * Hash the launcher must verify a module against.
 *
 * - `sha256` valid: returned (lowercased).
 * - `sha256` present but malformed: error (never degrades to "no check").
 * - no `sha256` and `untracked: true`: `null` (the file is only downloaded when missing).
 * - no `sha256` and not untracked: error. Any other hash field (e.g. a legacy `MD5`) is ignored.
 */
export function resolveArtifactHash(moduleId: string, artifact: Artifact): ArtifactHash | null {
    const sha256 = artifact.sha256
    if(sha256 != null) {
        if(typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
            throw new ArtifactHashError(MODULE_HASH_INVALID, moduleId)
        }
        return { algo: HashAlgo.SHA256, hash: sha256.toLowerCase() }
    }
    if(artifact.untracked === true) {
        return null
    }
    throw new ArtifactHashError(MODULE_HASH_MISSING, moduleId)
}
