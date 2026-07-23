# SDK Author Guide

**Audience:** language-community leads who want to bring their language (TypeScript, Go, AssemblyScript, Zig, Move, ...) to Pyde as a first-class contract-writing target.

**Status:** v1.0 (draft). Mirrors the surface of `pyde-host` + `pyde-storage-macros` + `#[pyde::entry]` in [otigen](https://github.com/pyde-net/otigen) (the canonical Rust SDK). When the Rust SDK lands a new convention, this guide is the canonical place we document the cross-language equivalent.

Pyde itself ships **no per-language SDKs** beyond the Rust reference. The chain provides a stable host-function ABI (HOST_FN_ABI_SPEC) and a stable bundle format (OTIGEN_BINARY_SPEC); everything above that is a community surface. This guide is the contract a community SDK must satisfy so the resulting bundles deploy + execute identically to the reference.

## 1. What an SDK provides

A complete language SDK gives an author three things:

1. **Host-fn import wrappers**: typed in the language's idiom (e.g., a Go `package pyde` exposing `Sstore(...)`, an AS `class Pyde { static sload(...) }`, a Zig `pub fn sload(...)`).
2. **An `entry` decorator / macro**: wraps the author's function in the `() -> ()` shim required by [§3.0 of HOST_FN_ABI_SPEC](HOST_FN_ABI_SPEC.md). Decodes calldata into the author's declared params; encodes the return value into a `pyde::return` call.
3. **A `declare_storage` decorator / macro**: generates typed accessors from the `[state]` schema in `otigen.toml`, so authors write `storage::balances().write(&from, amount)` instead of `pyde::sstore_map1(...)` directly.

A *minimal* SDK can ship just (1): authors will hand-write the entry shim and call host fns directly. Most language communities will want (2) at least; (3) is the polish that makes day-to-day development feel native.

## 2. The four invariants every SDK must hold

These are non-negotiable. Bundles that violate them won't deploy.

### 2.1 `() -> ()` WASM signature for every export

Every function the contract exposes to the chain MUST have WASM type `() -> ()`. The chain's deploy validator rejects anything else.

Args come in via `calldata_size` + `calldata_copy` (HOST_FN_ABI_SPEC §7.4). Returns go out via `pyde::return` (§7.7). See [§3.0](HOST_FN_ABI_SPEC.md) for the rationale.

What this means concretely for an SDK:

```
# Generic pseudocode for what `@pyde.entry` must emit
@pyde.entry
function deposit(amount: u128, to: Address) -> Receipt:
    # Author writes the natural signature above.
    # SDK rewrites it to:
    
    function deposit():  # WASM signature: () -> ()
        calldata_len = pyde.calldata_size()
        buf = allocate(calldata_len)
        limit = encode_u32_le(calldata_len)
        pyde.calldata_copy(buf, limit)
        
        amount, to = decode_calldata(buf, [u128, Address])
        result = __original_deposit(amount, to)
        
        return_bytes = encode_return_value(result)
        pyde.return(return_bytes, len(return_bytes))
```

The decoder/encoder choice (next section) is up to the SDK but must be deterministic and consistent across the SDK's own entry + cross_call surfaces.

### 2.2 Borsh-canonical calldata + return encoding

The Rust reference SDK uses **borsh v1** (`borsh::BorshSerialize` / `BorshDeserialize`) for the calldata-tuple and the return-value encoding. SDK authors should follow this convention unless there is a strong reason not to.

Why borsh and not "negotiate per SDK":

- **Cross-SDK interop.** A Go contract calling a Rust contract via `cross_call` needs both sides to encode the calldata identically. The chain doesn't impose this; it's an SDK-layer convention. Sharing borsh means a Go author can call a Rust contract without writing a Rust-specific shim, and vice versa.
- **Tooling.** `otigen call --args <hex>` and the canonical e2e harnesses in `examples/storage-stress/` produce borsh-encoded calldata. A custom encoding would force every author to ship a CLI helper.
- **The chain's own RPC.** `pyde_call`'s data field is borsh-encoded `CallPayload { function: String, calldata: Vec<u8> }`. The `calldata` inner Vec is whatever the SDK author chose, but the chain handles borsh for the outer envelope regardless.

Borsh v1 implementations exist for: Rust (`borsh`), Go (`github.com/near/borsh-go`), TypeScript (`borsh-ts`), C++, Python, Java/Kotlin, Swift, AssemblyScript (community ports). For languages without an existing borsh library, porting the v1 spec (a single-page document, ~200 lines of code) is the standard path.

If your SDK *must* use a different encoding (e.g., a language where borsh isn't viable), document it explicitly: any contract built with your SDK becomes a closed-world ecosystem, cross-callable only by callers that speak your encoding. This is a real cost; weigh it against the cost of porting borsh.

### 2.3 Host-fn import declarations match HOST_FN_ABI_SPEC exactly

The deploy validator (in `otigen-abi/src/host_fns.rs`) checks that every imported host function matches its declared signature. Name-mismatched imports fail at deploy time with `DeployError::ForbiddenImport` (engine/crates/wasm-exec/src/deploy.rs); arity / type mismatches surface as wasmtime instantiate-time link errors rather than a dedicated deploy-validator variant.

The canonical signature table is in [HOST_FN_ABI_SPEC §7 + §10](HOST_FN_ABI_SPEC.md). Mirror it precisely in your SDK's import declarations.

Common pitfalls:

- **`calldata_copy` is 2-arg, not 3.** Signature: `(out_ptr: i32, out_len_ptr: i32) -> i32`. The contract writes the buffer limit (LE u32) at `out_len_ptr`; the host caps at that limit, copies bytes, and writes the actual length back. The Rust SDK shipped a 3-arg version briefly; if you're porting from an old reference, fix this.
- **Multi-byte values are always LE.** WASM linear memory is little-endian; the host expects LE everywhere (HOST_FN_ABI_SPEC §3.2).
- **Pointers are `i32`.** This is WASM32: even though the Rust SDK declares `*mut u8` in extern "C" decls (which lowers to i32), the chain sees i32.

### 2.4 Bundle assembly: `pyde.abi` custom section

The chain reads the contract's ABI from a WASM custom section named **`pyde.abi`** carrying a borsh-encoded `ContractAbi` (HOST_FN_ABI_SPEC §3.7). Without this section, the deploy validator rejects the bundle.

The canonical bundle-assembly pipeline lives in `otigen-abi` (Rust). SDK authors have two options:

1. **Delegate to `otigen build` (recommended).** Author's `otigen.toml` + compiled `.wasm` go through the same toolchain pipeline that every other contract uses. The SDK only needs to emit a `.wasm` with the right exports. `otigen build` handles ABI parsing, custom-section insertion, and bundle wrapping.
2. **Build the bundle yourself.** Possible if your language community wants a single-binary toolchain that doesn't depend on `otigen`. You must:
   - Serialize the borsh-encoded `ContractAbi` exactly as `otigen-abi` would (the layout is stable; see `engine/crates/types/src/abi.rs` for the canonical Rust struct).
   - Insert the custom section using a WASM-encoder library (e.g., `wasm-encoder` in Rust, `binaryen` in C++, `binaryen-loader` for Node).
   - Verify with `otigen verify <bundle>` before shipping.

Option 1 is what AssemblyScript, TinyGo, and the Rust reference all do today. Option 2 is open as a future direction; no language community has taken it yet.

## 3. Reference implementation surface (Rust)

The Rust SDK in [pyde-net/otigen](https://github.com/pyde-net/otigen) is the canonical reference. When this guide is ambiguous, the Rust source is the source of truth.

Key files:

| Concern | File | What it shows |
|---|---|---|
| Entry shim | `crates/pyde-entry-macros/src/lib.rs` | How `#[pyde::entry]` rewrites a `fn deposit(amount: u128)` into a `() -> ()` export with calldata decode + return encode |
| Storage codegen | `crates/pyde-storage-macros/src/lib.rs` | How `declare_storage!()` reads `otigen.toml` at compile time + emits typed accessors |
| Host-fn extern decls | `crates/pyde-host/src/lib.rs` | All 40+ host-fn signatures Rust-side, matching HOST_FN_ABI_SPEC §7 |
| Bundle assembly | `crates/otigen-abi/src/build.rs` | How `ContractAbi` is built from `otigen.toml` |
| Custom section insertion | `crates/otigen-abi/src/section.rs` | How the `pyde.abi` section is appended to the `.wasm` (`inject` / `extract` / `extract_required`) |
| Reference contract | `examples/storage-stress/` | Exercises every storage type, every map arity, complex multi-slot logic, delete ops |

A reasonable porting strategy:

1. **Start with host-fn imports.** Mirror the signature table; verify with a trivial contract that does one `sstore_scalar` and deploys.
2. **Add the entry shim.** Borsh-decode tuple of params, invoke the inner function, borsh-encode the return. Test with a no-arg entry first (`get`-style), then an arg-taking entry (`set(value: u64)`).
3. **Add the storage accessor codegen.** Read `otigen.toml`'s `[state]` schema, emit one accessor per field. Run the equivalent of `examples/storage-stress/tests/stress_e2e.py` against your SDK to verify round-trip.
4. **Add `otigen.toml` integration.** If you're using `otigen build`, you're done after (3). If you're shipping a stand-alone toolchain, add bundle assembly + custom-section insertion last.

## 4. Quality bar

A community SDK should pass the following before being recommended publicly:

- **All 30 storage-stress assertions** round-trip end-to-end against `otigen devnet`. The reference suite is at `examples/storage-stress/tests/stress_e2e.py`. Port the assertions to your language's test harness; the asserted shapes are language-neutral.
- **`otigen verify <bundle>` passes** for every example you ship. This re-validates the WASM features, the import allowlist, the `pyde.abi` custom section, and the bundle manifest.
- **Cross-call interop with the Rust SDK.** Author a two-contract example: contract A (your SDK) calls contract B (Rust SDK) via `cross_call`. If borsh-canonical encoding is correct, both decode each other's calldata cleanly.
- **Forbidden imports are absent.** The deploy validator rejects any import outside the allowlist (`crates/otigen-abi/src/host_fns.rs`). Use `wasm-objdump -j Import` or equivalent to confirm your bundles don't accidentally drag in `wasi_snapshot_preview1`, `env`, or any other non-`pyde` import.
- **Determinism.** No floats in chain logic (HOST_FN_ABI_SPEC §6), no calls to non-deterministic host APIs (random, time, env). Your SDK shouldn't make these accessible; if your language stdlib needs guarding, document it.

## 5. Where to publish

- **Repo:** Your SDK lives under the language community's namespace (e.g., `pyde-go/`, `pyde-ts/`). Pyde Network maintains [pyde-net/otigen](https://github.com/pyde-net/otigen) only.
- **Cross-link:** Once your SDK is ready, open a PR against [pyde-net/pyde-book](https://github.com/pyde-net/pyde-book) adding your SDK to the [Developer Tools](../chapters/17-developer-tools.md) chapter under "Community SDKs". Include the repo URL, supported language version, target audience, and a one-line summary of any deviations from the canonical surface.
- **Versioning:** SDKs follow their own version trains. Pin against a specific `HOST_FN_ABI_SPEC` version (currently v1.0); call out incompatibilities in your release notes when the spec rolls forward.

## 6. Open questions

A handful of surfaces are intentionally underspecified in v1; we'll close them once the first non-Rust SDK lands and exercises the gaps.

- **Schema vocabulary extension.** The current `ScalarType` set (`u8`..`u128`, `i8`..`i128`, `bool`, `address`, `hash32`, `bytes`, `string`, `vec(<fixed>)`) covers the storage-stress matrix. Languages with native richer types (Move-style structs, AS classes) will want a sugar layer over `bytes`. The convention is up to your SDK; document it explicitly.
- **Cross-language struct encoding.** Borsh handles `(u128, [u8; 32])` tuples cleanly across languages, but Rust enums (sum types) don't have a native equivalent in every language. Until a cross-language story exists, treat enums as borsh `u8 tag + payload` and document the layout.
- **Native multisig + session-key support.** Both are v2 surfaces (Programmable Accounts). When they land, this guide will get a new section on how SDKs surface AuthKey shapes to authors.

## 7. References

- [HOST_FN_ABI_SPEC §3.0](HOST_FN_ABI_SPEC.md): `() -> ()` entry-point WASM signature
- [HOST_FN_ABI_SPEC §3.7](HOST_FN_ABI_SPEC.md): `pyde.abi` custom section layout
- [HOST_FN_ABI_SPEC §7](HOST_FN_ABI_SPEC.md): full host-fn catalog with signatures + gas costs
- [HOST_FN_ABI_SPEC §10](HOST_FN_ABI_SPEC.md): gas table
- [OTIGEN_BINARY_SPEC](OTIGEN_BINARY_SPEC.md): bundle format
- [WASM_AUTHOR_GUIDE](WASM_AUTHOR_GUIDE.md): author-facing guide to writing contracts (the audience downstream of your SDK)
- [examples/storage-stress](https://github.com/pyde-net/otigen/tree/main/examples/storage-stress): the canonical SDK-acceptance contract
