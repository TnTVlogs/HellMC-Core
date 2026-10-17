export interface Asset {
    id: string
    /** Omitted only for untracked files (see `hellmc-distribution-types`' `Artifact.untracked`): validation is skipped. */
    hash?: string
    algo: string
    size: number
    url: string
    path: string
}

export enum HashAlgo {
    SHA1 = 'sha1',
    SHA256 = 'sha256',
    /** Not used for distribution modules (SHA-256 only). Kept solely for the Corretto JDK checksum (S12), see JavaGuard. */
    MD5 = 'md5'
}