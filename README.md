# HellMC-Core

**HellMC-Core** is a modified fork of [helios-core](https://github.com/dscalzi/helios-core) by
Daniel D. Scalzi ([LGPL-3.0-only](LICENSE)), core mechanisms for the HellMC client.

See `CHANGES.md` for the list of changes made relative to upstream `helios-core`.

### Requirements

* Node.js 22 (minimum)

### Auth

#### Supported Auth Providers

* Mojang
* Microsoft

#### Provider Information

##### Mojang

Mojang authentication makes use of the Yggdrasil scheme. See https://wiki.vg/Authentication

##### Microsoft

Microsoft authentication uses OAuth 2.0 with Azure. See https://wiki.vg/Microsoft_Authentication_Scheme

### License

**LGPL-3.0-only** — unchanged from upstream (a condition of the license). See `LICENSE` and
`NOTICE`. This library ships as a separate module (never bundled/obfuscated into a single
renderer bundle) so it can be replaced with a modified build, per LGPL §4.
