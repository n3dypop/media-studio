# Native probe dependency notices

The original probe source is covered by this repository's [MIT license](LICENSE).
Dependency source code and compiled executables are not bundled in this source
repository. Cargo obtains the versions pinned by `Cargo.lock`; the build script
keeps the executable and these notices in the private runtime.

The Windows x64 build uses the dependencies below under their MIT option. The
listed original license texts are retained verbatim from those crate releases.
Keep these notices and the accompanying `licenses/` directory with a separately
distributed compiled helper. The Rust standard library/toolchain has its own
[upstream licenses](https://github.com/rust-lang/rust/blob/master/COPYRIGHT).
The packaging script also retains the active toolchain's original standard
library copyright report and license texts under `licenses/rust/` in the ZIP.

| Crate | Version | Upstream | Published license | Retained text |
| --- | --- | --- | --- | --- |
| windows-sys | 0.59.0 | [windows-rs](https://github.com/microsoft/windows-rs) | MIT OR Apache-2.0 | [Microsoft MIT](licenses/windows-MIT.txt) |
| windows-targets | 0.52.6 | [windows-rs](https://github.com/microsoft/windows-rs) | MIT OR Apache-2.0 | [Microsoft MIT](licenses/windows-MIT.txt) |
| windows_x86_64_msvc | 0.52.6 | [windows-rs](https://github.com/microsoft/windows-rs) | MIT OR Apache-2.0 | [Microsoft MIT](licenses/windows-MIT.txt) |
| serde_json | 1.0.154 | [serde-rs/json](https://github.com/serde-rs/json) | MIT OR Apache-2.0 | [MIT](licenses/serde-MIT.txt) |
| serde_core | 1.0.229 | [serde-rs/serde](https://github.com/serde-rs/serde) | MIT OR Apache-2.0 | [MIT](licenses/serde-MIT.txt) |
| itoa | 1.0.18 | [dtolnay/itoa](https://github.com/dtolnay/itoa) | MIT OR Apache-2.0 | [MIT](licenses/serde-MIT.txt) |
| zmij | 1.0.23 | [dtolnay/zmij](https://github.com/dtolnay/zmij) | MIT | [MIT](licenses/serde-MIT.txt) |
| memchr | 2.8.3 | [BurntSushi/memchr](https://github.com/BurntSushi/memchr) | Unlicense OR MIT | [MIT](licenses/memchr-MIT.txt) |

Cargo's lockfile can also retain optional/build-time crates that are not linked
into this target. Recheck the dependency graph and notices when upgrading the
lockfile or changing enabled features or target architecture.
