# Windows system probe

This optional read-only Rust helper replaces selected PowerShell queries used by
Media Studio. The Controller and its ownership, cancellation and job policies
remain in JavaScript. GPU collection and the independent CIM descendant checks
retain their existing implementations.

Requires Windows x64, Rust with the `x86_64-pc-windows-msvc` target, and the MSVC C++
build tools. Private working set collection requires Windows 10 or Windows 11
22H2 with the September 2023 cumulative update, or a later supported Windows
release. Older systems are untested and unsupported by this helper.

Build and install from the repository root using an explicit private directory:

```powershell
./scripts/Build-NativeProbe.ps1 -RuntimeRoot $privateRuntime
```

`$privateRuntime` must be an absolute local directory outside this repository.
The default Cargo target directory is `cache/native-probe-build` inside that
directory. `-BuildDirectory` may select another directory inside it. Builds use
the committed lockfile and default to offline mode. If dependencies are not
cached, pass `-AllowNetwork` explicitly to let Cargo obtain them. No executable
or Cargo build output belongs in this repository.

The script installs `apps/media-studio-probe/controller-native-probe.exe` and
dependency notices inside the private runtime. It prints the executable path and
SHA-256 for explicit Controller configuration. It does not modify settings,
enable the helper, or start, stop or restart a service.

An identical installed executable is retained. A different existing executable
is refused by default. For an upgrade, stop the Controller and retain a recovery
copy before passing `-ReplaceExisting`; after review, explicitly update the
configured hash to the new build's output and restart the Controller. The build
script does not establish service idleness or perform these activation steps.

To build a portable ZIP with checksums, source/toolchain receipts, dependency
licenses and the active Rust standard library notices, use
`scripts/Package-NativeProbe.ps1` with explicit private `-RuntimeRoot` and fresh
`-OutputDirectory` paths. Packaging requires the active toolchain's `rust-docs`
component. The [workflow and activation guide](../../../../docs/native-probe.md)
explains local packaging and downloading GitHub Actions artifacts. CI pins Rust
1.99.1; this is the verified compiler, not a claim about the minimum compiler.

For development, set `CARGO_TARGET_DIR` to a private directory, then run:

```powershell
cargo fmt --manifest-path apps/controller/native/system-probe/Cargo.toml --check
cargo clippy --locked --offline --manifest-path apps/controller/native/system-probe/Cargo.toml --all-targets -- -D warnings
cargo test --locked --offline --manifest-path apps/controller/native/system-probe/Cargo.toml
```

## Protocol

Success is one UTF-8 JSON line, exit code zero, with `{schemaVersion:1,data:...}`.
Errors use a fixed classification on stderr and a nonzero exit code. Unknown
arguments, duplicate PIDs, zero PIDs, lists over 64 PIDs and ports outside
1–65535 are rejected.

| Command | `data` |
| --- | --- |
| `resources` | `{ramAvailableBytes,ramTotalBytes,commitUsedBytes,commitLimitBytes,commitAvailableBytes}` |
| `processes <PID[,PID...]>` | `[{pid,startTimeUtcTicks,executable,workingSetBytes,privateBytes,residentPrivateBytes}]` |
| `epoch <managedPID> <port>` | `{managed:{pid,startTimeUtcTicks,executable},listener:{pid,startTimeUtcTicks,executable,parentPid}}` |

Sizes are nonnegative bytes. Process creation times are decimal strings of .NET
UTC ticks, preserving 100 ns precision. Process handles stay open during each
sample, with liveness and identity checked before and after observations. Epoch
queries accept exactly one listener on **127.0.0.1**, repeat TCP ownership and
parent checks, and leave the final ownership decision to the Controller.

Memory uses `GlobalMemoryStatusEx`, `GetPerformanceInfo` and
`GetProcessMemoryInfo`. A failed EX2 call retries with EX and returns
`residentPrivateBytes:null`; it never converts that failure to zero. Microsoft
does not document how older unsupported systems treat an EX2-sized buffer, so
this fallback is not a compatibility guarantee for those systems. See the
[EX2 requirements](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters_ex2)
and [function contract](https://learn.microsoft.com/en-us/windows/win32/api/psapi/nf-psapi-getprocessmemoryinfo).

For measurements only, trailing `--metrics` adds
`metrics:{peakWorkingSetBytes,privateBytes,cpuSeconds}` for the helper itself.
These are per-process measurements, not aggregate system usage. The normal
Controller adapter does not request this field.

The helper has no configuration, file-content, network-request, process-kill,
service-control or GPU APIs. It reads Windows process, TCP-listener and memory
metadata. Failure to obtain an identity or API result fails the command closed.

Dependency attribution is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
