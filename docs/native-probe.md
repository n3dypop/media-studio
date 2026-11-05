# Optional Windows system probe

The Controller uses Node.js for HTTP, SQLite, jobs, GPU leases, cancellation and
recovery. A small Rust executable can replace selected short-lived PowerShell
queries: managed process/listener identity, per-process memory, and system RAM
and commit. It exits after each query and does not run another background server.
This reduces observation overhead; it does not reduce model weights or GPU
memory, accelerate diffusion, or establish image quality.

## Download an Actions build

The `Build native probe` workflow runs on pushes, pull requests and manual
`workflow_dispatch`. It pins Rust 1.99.1, checks formatting, runs Clippy and tests
with the committed lockfile, and builds the Windows x64 MSVC target. The separate
`Check` workflow keeps the JavaScript checks and does not build Rust a second time.

After a successful run, download
`media-studio-probe-x86_64-pc-windows-msvc-<full-commit>` from that run's Artifacts
section. Artifacts are retained for 30 days, subject to repository limits. The
download contains a package ZIP, its SHA-256 checksum and a JSON build receipt.
The package ZIP contains only the executable, original/dependency notices and
licenses, `SHA256SUMS`, and `build-receipt.json`. The receipt records the checked-out
source commit, dirty-worktree flag, target, Rust/Cargo versions, source-input
hashes, executable hash and retained Rust standard library notice hashes. Original
notices from the active toolchain are included under `licenses/rust/`.
Pull-request artifacts may identify GitHub's tested
merge commit; review the run and commit before trusting an artifact.

Verify the ZIP checksum before extraction and the executable checksum against
both `SHA256SUMS` and the receipt afterwards. Review the source commit and require
`sourceDirty:false` for a published CI build. Keep the executable and its notices
together under the private runtime's `apps/media-studio-probe/` directory. Then
follow the explicit configuration and idle-checked activation below. A workflow
artifact does not install or enable the helper, and is not a signed release.
No GitHub run or publication is implied by the presence of these workflow files.
See GitHub's [artifact guide](https://docs.github.com/en/actions/tutorials/store-and-share-data)
for downloading and validating workflow artifacts.

## Build and enable

Use Windows x64 with a Rust MSVC toolchain and Visual Studio C++ build tools.
The native source and locked dependencies live in `apps/controller/native/system-probe/`.
The optional feature requires an OS supporting `PROCESS_MEMORY_COUNTERS_EX2`
(Windows 10/11 22H2 with the September 2023 update or newer, according to
[Microsoft](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters_ex2)).
It was verified on Windows build 26300. Older systems are untested and unsupported
by this optional helper. A failed EX2 call falls back to the older memory
structure with private working set marked unknown; the fallback is not an OS
compatibility test, and unavailable observations must not be treated as zero.

```powershell
& ./scripts/Build-NativeProbe.ps1 -RuntimeRoot '<absolute-private-runtime>'
```

The build uses the local Cargo cache by default. On a new development machine,
add `-AllowNetwork` explicitly to obtain the locked dependencies. Build files
stay under the private runtime cache; the executable is installed under
`apps/media-studio-probe/`. Binaries and build caches do not belong in this Git
checkout. Read the probe's third-party notices before distributing a build.

To create the same portable package locally, use a fresh absolute output directory
outside the source checkout:

```powershell
& ./scripts/Package-NativeProbe.ps1 -RuntimeRoot '<absolute-private-runtime>' -OutputDirectory '<absolute-private-output>'
```

This invokes the locked builder and packages only the named binary and notices;
it does not include settings, conversations, models, logs or caches. It requires
`rust-docs` for the active compiler's original standard library attribution.
Use `-AllowNetwork` only when Cargo needs to obtain dependencies. Existing output
is refused, and an existing different installed helper still requires the
builder's explicit `-ReplaceExisting` upgrade procedure. A locally modified
checkout is recorded as `sourceDirty:true` instead of presented as a clean commit.

The build prints the installed path and SHA-256. While production is idle,
preserve a copy of private `config/controller.json`, then add its actual values:

```json
{
  "nativeProbe": {
    "enabled": true,
    "executable": "<absolute-private-runtime>/apps/media-studio-probe/controller-native-probe.exe",
    "sha256": "<64-hex-digit-sha256-from-the-reviewed-build>"
  }
}
```

This is an additional field, not a complete Controller configuration. Restart
only Controller through the managed service operation after checking active DSH
work, generation queues and inference. Existing conversations, inputs, runs,
models and outputs stay in their current private locations. Rebuilding an enabled
probe requires the same idle procedure and a matching configuration hash. The
builder retains an identical installed binary and refuses to replace a different
one by default. After stopping Controller and retaining the previous binary,
pass `-ReplaceExisting` explicitly for an upgrade; it does not check service
idleness or stop services for you.

Missing configuration or `{"nativeProbe":{"enabled":false}}` uses the existing
PowerShell observers. To roll back, restore the previous configuration or set
`enabled` to `false`, then perform one idle-checked Controller restart. Retain the
old reviewed source revision and executable until activation has been verified.

## Trust and compatibility

An enabled probe must be an ordinary local executable under the private
runtime's `apps/media-studio-probe/` directory, with an explicit SHA-256 receipt.
The adapter verifies the file before each call, uses fixed arguments without a
shell, bounds time/output, and validates the JSON schema and requested identities.
A configured probe's failure propagates; it does not silently substitute stale
or legacy evidence. A missing observation never grants a GPU lease.

The existing Controller still validates managed receipts before and after each
identity query. Independent CIM evidence for Strata children, retired-process
recovery, GPU queries and DXGI remain in their existing implementations. API
routes, job IDs, ownership, leases and cancellation contracts are unchanged.
GPU/WMI queries can still launch PowerShell, particularly on the first resource
update. Administrator privileges are not normally required for owned processes;
restricted environments may deny the necessary Windows queries.

## Verification

```powershell
cargo fmt --manifest-path apps/controller/native/system-probe/Cargo.toml --check
cargo clippy --locked --manifest-path apps/controller/native/system-probe/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path apps/controller/native/system-probe/Cargo.toml
npm run check
npm test
```

Set `CARGO_TARGET_DIR` to an absolute directory outside this checkout before
running Cargo directly. Native tests inspect their own process and create an
owned temporary loopback listener; they do not inspect application data or run
models. Package checks and fixtures are separate from real Controller activation,
GPU generation, DSH rendering and user acceptance.
