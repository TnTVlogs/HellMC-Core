# Changes from upstream `helios-core`

Fase 0 — fork & rename (see `docs/newDocs/client-redesign/` in `HellMC-Client`).

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

## Consumption note

`hellmc-distribution-types` is currently a `file:` dependency
(`../HellMC-Distribution-Types`) for local development. Before tagging a
release, pin it to `github:TnTVlogs/HellMC-Distribution-Types#v1.0.0` (never a
branch) per `09-fases-i-proves.md` → "Decisions de consum".
