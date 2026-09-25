import { Version } from 'hellmc-distribution-types'

/**
 * Modified by HellMC (TnTVlogs), 2026-09-25: renamed from `getMainServer`.
 * Fase 0: `Version` carries no "main" flag any more (moved to the `Server`
 * catalog, fase 1) — the first version in the array (the distribution's own
 * `sortOrder`) is used as the default.
 */
export function getMainVersion(versions: Version[]): Version {
    return versions[0]
}
