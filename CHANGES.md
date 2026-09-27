# Changes from upstream `helios-core`

Fase 0 — fork & rename (see `docs/client-redesign/` in `HellMC-Client`).

- **Absorbed patches** previously applied via `patch-package` on the client
  (`patches/helios-core+2.3.0.patch`): explicit `got` timeouts on
  `DistributionAPI.pullRemote` and `DownloadEngine.downloadFile`, plus
  treating `TimeoutError` as retryable in `DownloadEngine`.
- **`Server` → `Version` rename** (`01-terminologia-i-dades.md`): `HeliosServer` →
  `HeliosVersion`, `getServerById` → `getVersionById`, `getMainServer` (flag +
  index resolution) removed in favor of `getMainVersion()` (fase 0: first
  published version, no `Server` catalog to mark a "main" entry yet — see
  P16/fase 1). `getMainServer(Server[])` in `DistroUtils` → `getMainVersion(Version[])`.
  Wire types now come from `hellmc-distribution-types` (`Distribution`, `Version`,
  `Server`, `Module`, ...) instead of `helios-distribution-types`.
- **`address`/`autoconnect`/`mainServer`/`discord` removed from the version**
  (moved to the new `Server` catalog entity, fase 1): `HeliosVersion` no longer
  exposes `hostname`/`port`/`parseAddress()`. Any auto-connect logic built on
  these needs to move to the `Server` side in fase 1.
- **`DistributionFactory`'s module path resolution** now derives the base
  directory from `hellmc-distribution-types`' `TypeMetadata` instead of a
  hardcoded switch, so adding a module `Type` no longer requires touching
  this file.
- IPC message field `serverId` → `versionId` (`FullRepairReceiver`,
  `AssetGaurdTransmitter`).
- Package renamed `helios-core` → `hellmc-core`, version `3.0.0-hellmc.1`.

Fase 1 — server catalog (see `docs/client-redesign/` in `HellMC-Client`).

- **`HeliosDistribution` now exposes the `Server` catalog**: `servers` (plain
  `Server[]`, no wrapper class needed — a server has no modules/files to
  resolve, unlike a version), `getServerById(id)`, `getMainServer()` (the
  server with `mainServer: true`, if any), `getVersionsOf(serverId)` and
  `getServersOf(versionId)` (01 §6). `getMainVersion()` is unchanged (still the
  fase-0 "no server applies" fallback, first published version); callers
  implementing D18 (preselect main server + its recommended version) should
  check `getMainServer()` first and fall back to `getMainVersion()`.

## Consumption note

`hellmc-distribution-types` is currently a `file:` dependency
(`../HellMC-Distribution-Types`) for local development. Before tagging a
release, pin it to `github:TnTVlogs/HellMC-Distribution-Types#v1.0.0` (never a
branch) per `09-fases-i-proves.md` → "Decisions de consum".
