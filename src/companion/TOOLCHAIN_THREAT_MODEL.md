# Pyde Toolchain Threat Model

**Scope:** the `otigen` developer toolchain in `pyde-net/otigen` —
the binary contract authors run on their dev machines to scaffold,
build, sign, and submit Pyde transactions.

This document is paired with [`THREAT_MODEL.md`](./THREAT_MODEL.md)
(which covers the chain side). It exists separately because the
toolchain runs in a fundamentally different trust environment: on
the *author's* machine, against *author-supplied* inputs, with the
author's *own* keystore. The chain-side threat model assumes a
hostile network of validators; the toolchain-side threat model
assumes a developer environment with whatever security posture the
author chose.

If a threat applies to both, the chain-side model is authoritative
and this doc just cross-links.

---

## 1. Scope & Assets

### In scope (toolchain responsibility)

- Parsing `otigen.toml` without crashing or panicking on adversarial input.
- Validating a compiled `.wasm` against the chain's Host Function ABI without crashing on malformed binaries.
- Embedding the `pyde.abi` custom section without altering the executable code section.
- Storing FALCON-512 secret keys at rest under Argon2id + AES-256-GCM (only the keystore subcommands, post-MC-2 milestone).
- Signing transactions only with the explicitly-named keystore entry; refusing to sign with anything else.
- Submitting deploy / upgrade / lifecycle transactions over an attested RPC channel (TLS + chain identity verification).

### Out of scope (author / operational responsibility)

- The security posture of the developer machine itself (OS-level compromise, file-permission misconfiguration, malicious browser extension).
- The integrity of the author's compiled `.wasm` — if the source code itself is malicious, `otigen` only validates *shape*, not *intent*. The chain side enforces runtime behavior.
- The chain's view-call-graph + runtime enforcement of attribute guarantees (those are in [`HOST_FN_ABI_SPEC.md`](./HOST_FN_ABI_SPEC.md) §3.7 layer 3, not here).
- Network-level attacks against the chain (eclipse, sybil, gossip flood) — covered in [`THREAT_MODEL.md`](./THREAT_MODEL.md).
- Endpoint compromise of a node operator running `pyde` (covered in the chain-side model).

### Asset value classification

| Asset | Where it lives | Compromise impact |
|---|---|---|
| FALCON-512 secret key | Author's machine, `~/.pyde/keystore.json`, encrypted at rest | **Critical** — full account takeover; attacker can deploy, upgrade, kill contracts at will |
| `otigen.toml` source | Author's project tree | **Low** — public after deploy; corruption causes build failure not theft |
| Compiled `.wasm` artifact | Author's project tree | **Medium** — corruption causes deploy failure; substitution attack is the real threat (see T-04) |
| Compiled `otigen` binary | User's `~/.cargo/bin/` or installed location | **High** — substituted binary can phish passwords, sign on author's behalf without consent |
| `pyde-net/otigen` source code | This repo | **High** — supply-chain attack vector; mitigations in §3 |

---

## 2. Adversary Model

### Adversary types

- **Hostile project (T-α)** — the contract author opens a malicious `otigen.toml` / `.wasm` (e.g., from a cloned malicious repo). Goal: panic, RCE, or escape the validator.
- **Network attacker (T-β)** — sits between the author's machine and the chain RPC endpoint. Goal: intercept, modify, or replay transactions.
- **Local attacker (T-γ)** — has read access to the author's filesystem but not the password. Goal: extract keystore secret.
- **Supply-chain attacker (T-δ)** — compromises one of `otigen`'s transitive dependencies. Goal: backdoor every build that uses the affected dep.
- **Phishing attacker (T-ε)** — distributes a tampered `otigen` binary or impersonates the chain's RPC endpoint. Goal: steal passwords, sign without consent.

### Adversary capabilities

| Capability | T-α | T-β | T-γ | T-δ | T-ε |
|---|:-:|:-:|:-:|:-:|:-:|
| Provide arbitrary `otigen.toml` / `.wasm` | ✅ | ❌ | ❌ | ❌ | ❌ |
| Intercept / modify network traffic | ❌ | ✅ | ❌ | ❌ | ✅ |
| Read author's filesystem | ❌ | ❌ | ✅ | ❌ | ❌ |
| Write author's filesystem | ❌ | ❌ | ⚠️ partial | ❌ | ❌ |
| Run code on author's machine | ❌ | ❌ | ❌ | ✅ via dep | ✅ via tampered binary |
| Knows author's keystore password | ❌ | ❌ | ❌ | ❌ | ⚠️ if phished |

---

## 3. Threat Catalog

Each threat ID prefixed `T-` (toolchain). Numbered for cross-reference. Severity scaled L/M/H/C (Critical).

### T-01 — Malicious `otigen.toml` causes panic or DoS in the parser

**Severity:** M (denial-of-service of `otigen build`; not chain-affecting)

**Description:** A crafted `otigen.toml` with extreme nesting, huge string fields, or shapes outside the schema causes `otigen_toml::parse_str` or `ProjectConfig::validate` to panic, infinite-loop, or consume unbounded memory.

**Mitigations:**
- `serde` + `toml-rs` are the parser substrate; both are battle-tested under fuzzing.
- `otigen-toml` adds its own cross-cutting validation pass that explicitly rejects malformed shapes (see [`OTIGEN_BINARY_SPEC.md`](./OTIGEN_BINARY_SPEC.md) §4 and the adversarial corpus at `crates/otigen-toml/tests/corpus/fail/`).
- Continuous fuzzing target `fuzz_toml_parser` runs against arbitrary UTF-8 bytes; ≥24h cumulative run required before α release per [`roadmap.md`](../roadmap.md) `α.qual.fuzz` gate. 4.3 M iterations clean as of the initial smoke run.

**Residual risk:** A surviving fuzz crash that wasn't reduced into the corpus. Mitigated by the gate above.

---

### T-02 — Malicious `.wasm` input bypasses the validator

**Severity:** M (deploy validator on the chain re-checks everything; toolchain catches obvious cases earlier for ergonomics)

**Description:** A hand-crafted `.wasm` (not the output of any real compiler) attempts to:
- Use forbidden imports (`wasi`, `env`, parachain-only fns in a contract module)
- Use forbidden WASM features (threads, SIMD, multi-memory, GC)
- Export functions that `otigen.toml` doesn't declare (to smuggle entry points past the chain's selector table)
- Embed a malformed `pyde.abi` custom section that doesn't decode

**Mitigations:**
- `otigen-abi::validate_all` runs all 8 spec §3.2 checks (well-formedness, imports allowlist, parachain-only fn detection, exports cross-reference, deterministic feature subset). Bail-on-first-violation with a collected error list.
- Continuous fuzzing target `fuzz_wasm_validator` runs against arbitrary bytes; ≥24h cumulative run required before α release.
- **The chain re-runs every check at deploy time** ([`HOST_FN_ABI_SPEC.md`](./HOST_FN_ABI_SPEC.md) §3.7 layers 1–3). Even a toolchain bypass cannot escape on-chain rejection.

**Residual risk:** A novel WASM attack pattern that bypasses both wasmparser and our own validators. Defense-in-depth (chain side re-check) keeps this from being chain-affecting.

---

### T-03 — `pyde.abi` injection corrupts the WASM code section

**Severity:** H if successful (chain accepts a contract whose claimed ABI doesn't match its actual exports)

**Description:** A bug in `inject` (or its underlying `wasm-encoder` crate) mangles the code section while appending the custom section, producing a `.wasm` that decodes differently than the original — e.g., a different function gets selected for `ping`.

**Mitigations:**
- The implementation walks the input via `wasmparser` and passes every section through as `RawSection` (the encoder writes the original bytes verbatim, not a re-encoding).
- Property test `inject_is_deterministic` (in `otigen-abi/tests/proptest_roundtrip.rs`) covers byte-deterministic round-tripping.
- Continuous fuzzing target `fuzz_section_injection` exercises arbitrary inputs through `inject + extract` round-trips.
- The chain's deploy validator extracts and re-parses the `pyde.abi` section + re-validates against the actual exports. A code-section corruption surfaces there before deploy completes.

**Residual risk:** Wasm-encoder library bug. Pinned to a known-good version; bump-via-PR with workspace tests as the gate.

---

### T-04 — Substituted `.wasm` after build

**Severity:** H if the author misses it; M with `otigen verify`

**Description:** An attacker with write access to the project's `target/wasm32-unknown-unknown/release/` swaps the compiled `.wasm` with a malicious one before `otigen build` runs. The bundle ends up containing the attacker's bytes, signed off by the author who thought they were building their own source.

**Mitigations:**
- `otigen verify` (post-MC-2) compares the on-chain stored bytes against a local rebuild of the bundle. Reproducibility property tested in `otigen-cli/tests/reproducibility.rs`: same source + same toolchain → byte-identical `contract.wasm`. A swapped `.wasm` would produce a different blake3 hash, surfacing at `verify` time.
- The bundle's `manifest.json` carries `wasm_hash_blake3` so a code reviewer can confirm the deployed hash matches the committed source.

**Residual risk:** The author doesn't run `otigen verify` and doesn't review the manifest hash. This is an operational responsibility (covered by docs, not code).

---

### T-05 — RPC MITM intercepts `otigen deploy`

**Severity:** H (attacker can drop / modify / replay deploy transactions)

**Description:** `otigen deploy` and friends submit signed transactions over JSON-RPC. A network attacker (compromised wifi, hostile proxy) intercepts the call.

**Mitigations:**
- RPC endpoints use TLS (`https://` URLs); plain `http://` is allowed only for `localhost` devnets.
- The transaction itself is FALCON-512 signed before transmission, so an attacker cannot modify the payload without breaking the signature — at worst they cause a deploy failure, not unauthorized deploy.
- Nonce uniqueness prevents replay (chain rejects a tx with a nonce already used by the sender).

**Residual risk:** TLS certificate substitution against an author who ignores certificate warnings. Standard endpoint-pinning operational hygiene applies.

---

### T-06 — Keystore tampering / theft (local attacker)

**Severity:** C if successful (full account takeover)

**Description:** An attacker with read access to `~/.pyde/keystore.json` attempts to extract the FALCON-512 secret key without the author's password.

**Mitigations (shipped in `otigen-wallet`):**
- Each keystore entry's secret key is AES-256-GCM encrypted; the key is derived via Argon2id over the user's password with a per-entry random salt + tunable memory / iterations / parallelism parameters (`OTIGEN_BINARY_SPEC.md` §7.1).
- Argon2id parameters: 64 MiB memory + 3 iterations + parallelism 4 — matches OWASP 2024/2025 guidance. Constants asserted via `kdf::tests::parameters_are_owasp_2024_recommended` so a future PR can't silently weaken them.
- Per-entry fresh 16-byte salt + fresh 12-byte AES-GCM nonce, both generated via `rand::thread_rng()` (ChaCha12 seeded from `getrandom` — OS CSPRNG). 96 bits of nonce randomness leaves an effective 2^48 safety margin before birthday collision risk; AES-GCM nonce reuse only matters within the same key, which here is per-entry.
- Decrypted AES-256-GCM session key wrapped in `zeroize::Zeroizing` — scrubbed when the wrapper drops; lives for one encrypt / decrypt call.
- `FalconSecretKey` (in `pyde-crypto`) derives `Zeroize + ZeroizeOnDrop` — the FALCON-512 secret key bytes are also scrubbed when the in-memory value drops, not just left in freed heap pages where a swap-out or core dump could read them.
- Decrypt failures collapse into one `Error::DecryptionFailed` variant regardless of cause (wrong key vs tampered ciphertext) — closes the timing-oracle that would otherwise distinguish "wrong password" from "tampered keystore" via per-call latency.
- AES-GCM's authentication tag check uses `aes-gcm` crate's constant-time comparison; the cipher rejects any tampered ciphertext before producing plaintext.

**Coverage:** `crates/otigen-wallet/src/` ships 43 tests covering: KDF determinism + parameter pins, encrypt / decrypt round-trip, wrong-key + tampered-ciphertext rejection, freshness of salt + nonce, end-to-end create / load / rotate-password / delete, FALCON signature round-trip through `falcon_verify`, multi-account isolation.

**Residual risk:** Password is weak. The toolchain does not enforce password complexity (out of scope); guidance lives in the user docs.

---

### T-07 — Phished keystore password

**Severity:** C if successful

**Description:** A tampered `otigen` binary, or a fake `otigen wallet new` prompt, captures the author's password.

**Mitigations:**
- Signed binary releases (`α.qual.release` roadmap item) ship with sigstore signatures + sha256sums; the user can verify the binary before running.
- Documentation directs users to install via the canonical curl one-liner against the public release mirror at [`pyde-net/test-releases`](https://github.com/pyde-net/test-releases) — anonymous fetch over the GitHub CDN, sha256 verified before extraction — or via `cargo install --git` from the source repo for contributors.
- No telemetry; no password ever leaves the local process.

**Residual risk:** User installs from an untrusted source. Operational responsibility.

---

### T-08 — Malicious dependency in the cargo graph

**Severity:** H — a malicious dep can do anything `otigen` can do

**Description:** A direct or transitive dependency of `otigen` (e.g., `wasmparser`, `serde`, `toml`, `borsh`) is compromised in a future release. The build now contains a backdoor.

**Mitigations:**
- `cargo-audit` runs on every PR (`α.qual.ci` roadmap item) and refuses to merge when a dep has a known RustSec advisory.
- `cargo-deny` enforces a license policy + version-policy + duplicate-version checks.
- `cargo-machete` flags unused deps so the surface stays minimal.
- `Cargo.lock` is committed; reproducibility test catches an attacker who substitutes a dep mid-build.
- A future cargo-vet integration would add cryptographic attestations of third-party reviews.

**Residual risk:** A zero-day in a transitive dep before RustSec catches it. The chain-side defense-in-depth (T-02) catches any malicious WASM the toolchain emits; the worst the attack can do is corrupt the author's local tools.

---

### T-09 — Dependency confusion / typosquatting

**Severity:** M (similar to T-08 but at install time)

**Description:** A typo in `cargo install otigen-cli` (e.g., `otigan-cli`) lands on a typosquatted crate.

**Mitigations:**
- Official install instructions in `README.md` use the verbatim mirror URL `https://raw.githubusercontent.com/pyde-net/test-releases/main/otigen/install.sh` or the exact crate name.
- The `pyde-net` GitHub org name is unique enough that typo-distance attacks are visible.

**Residual risk:** User copy-pastes from a phishing site. Documentation-only mitigation.

---

### T-10 — `otigen build` executes the contract WASM

**Severity:** M (if it did, malicious WASM could run code on the build machine)

**Description:** A future refactor accidentally introduces a wasmtime instantiation step into `otigen build` (e.g., for "preflight gas estimation"). Now the malicious WASM runs in-process during a build operation the author thinks is metadata-only.

**Mitigations:**
- **`otigen build` does not link or instantiate wasmtime.** `Cargo.toml` of `otigen-cli` (the dispatch crate) and `otigen-abi` (the build-pipeline crate) only depend on `wasmparser` (read-only inspection) and `wasm-encoder` (write-only emission). The wasmtime dependency lives exclusively in `otigen-test` and is invoked only by the `otigen test` subcommand, which the author opts into per invocation.
- **`otigen test` runs WASM in a sandboxed wasmtime `Engine`** with mock host functions (no filesystem access, no network access, no `wasi:*` imports). Even malicious WASM under `otigen test` cannot escape the sandbox to the build machine.
- **Architecture-level invariant** documented in [`OTIGEN_BINARY_SPEC.md`](./OTIGEN_BINARY_SPEC.md) §2: `otigen` is NOT a language compiler. The contract-behaviour test runner (`otigen test`) is the only execution surface and is opt-in per invocation.

**Residual risk:**
- Future PR adds wasmtime to `otigen-cli` or `otigen-abi` (i.e., the build path, not just `otigen-test`). CI should grep the build-path crates' `Cargo.toml` for `wasmtime` and reject the PR. Adding that as a future enhancement.
- A malicious dependency of `otigen-test` (e.g., a compromised wasmtime release) executes during `otigen test`. Mitigated by `cargo-audit` + `cargo-deny` gates (α.qual) and the fact that wasmtime is a Bytecode Alliance project with its own audit pipeline; not a Pyde-specific risk.

---

### T-11 — `otigen build` runs against an attacker-controlled CWD

**Severity:** L (path-traversal in artifact output)

**Description:** An attacker convinces the author to run `otigen build --out /attacker/path` against their project. The bundle writes to a controlled location.

**Mitigations:**
- The `--out` flag is explicit and visible; running with a flag is the author's deliberate choice.
- The output is a directory under `--out`, named after the contract — no symlink-following, no path traversal in the bundle filename.

**Residual risk:** Acceptable. This is a normal `--out` flag, not an attack surface.

---

### T-12 — Replay attack on signed transactions

**Severity:** L (chain rejects, but UX confusion)

**Description:** Attacker captures a signed transaction off the wire and re-broadcasts it later.

**Mitigations:** Chain-side, not toolchain-side. Each tx carries a `nonce`; the chain rejects already-used nonces. See [`THREAT_MODEL.md`](./THREAT_MODEL.md) chain-side mitigations.

---

## 4. Mitigation Coverage Summary

| Threat | Mitigation status |
|---|---|
| T-01 malicious otigen.toml | ✅ adversarial corpus + cargo-fuzz target |
| T-02 malicious .wasm | ✅ 8-check validator + cargo-fuzz target + chain-side re-check |
| T-03 inject corrupts code section | ✅ RawSection pass-through + property test + chain-side re-extract |
| T-04 substituted .wasm | ⏳ `otigen verify` lands post-MC-2 |
| T-05 RPC MITM | ⏳ enforce HTTPS-or-localhost when otigen-rpc lands |
| T-06 keystore tampering | ✅ Argon2id (64 MiB / 3 / 4 — OWASP 2024) + AES-256-GCM with fresh per-entry salt + nonce + zeroize on both AES session key and `FalconSecretKey` + constant-time decrypt + single error variant (no timing oracle). 43 tests in `crates/otigen-wallet/src/`. Per-entry crypto details: §3 above |
| T-07 phished password | ⏳ signed binary releases (α.qual.release) |
| T-08 malicious cargo dep | ⏳ cargo-audit + cargo-deny in CI (α.qual.ci) |
| T-09 dependency confusion | ✅ documentation only |
| T-10 build executes WASM | ✅ architectural invariant: `otigen build` does not link wasmtime; the wasmtime dep lives only in `otigen-test` and runs WASM in a sandboxed Engine with mock host fns (no `wasi:*`, no fs/net imports) |
| T-11 path traversal via `--out` | ✅ standard CLI flag, no surprise |
| T-12 replay attack | ✅ chain-side nonce; no toolchain action needed |

Marked ⏳ are tracked as roadmap items under `α.qual` and `α.feat`. Marked ✅ are landed or architectural.

---

## 5. Maintenance

- This document is updated alongside each new feature that touches the threat surface.
- A new attack class found during fuzzing or external review is added as a new T-NN entry with the mitigation it triggered.
- Cross-references to [`THREAT_MODEL.md`](./THREAT_MODEL.md) (chain-side) are kept current.
- The `α.qual.threat` roadmap item gates this document being signed off before the α-stream ships.
