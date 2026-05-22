# Pyde Parachain Design

**Version 0.1**

This is the canonical design specification for Pyde's parachain framework. [Chapter 13](../chapters/13-cross-chain.md) is the narrative overview; this document is the deeper mechanics, the design rationale, and the surface that future PPIPs (Pyde Parachain Improvement Proposals) extend.

## 1. Scope and framing

A Pyde **parachain** is an on-chain WASM module with an extended host-function allowlist, a private state subtree, and its own validator committee selected from the main Pyde committee. It is *not* a slot-auction model (Polkadot-style), *not* a separate operator network running off-chain, and *not* a cross-chain bridge to a foreign L1.

The word "parachain" is overloaded in the L1 ecosystem. In Pyde:

| Term | Meaning |
|---|---|
| Smart contract | A WASM module deployed via `otigen` that shares Pyde's general state space and runs on the main executor. |
| Parachain | A WASM module deployed via `otigen` with `type = "parachain"`, granted: (a) its own state subtree partitioned under PIP-2 clustering by `parachain_id[..16]`, (b) extended host-function access (cross-parachain messaging, threshold-crypto access, governance hooks), (c) its own validator committee (a subset of Pyde's main committee that opts in at deploy time), and (d) its own upgrade governance. |
| Cross-chain bridge | Infrastructure that ferries proofs between Pyde and a foreign L1 (Ethereum, Bitcoin). Out of scope here — see Chapter 13 §13.2-§13.3, §13.6. |

The parachain framework **ships at v1**: registration, deployment, lifecycle, upgrade governance, state partitioning, cross-parachain messaging, version history retention, and the host-function ABI surface are all part of mainnet.

## 2. Why this model

Three design choices distinguish Pyde's parachains from the alternatives:

1. **No slot auctions.** Slot auctions concentrate parachain rights in deep-pocketed operators, creating political and centralization risk. Pyde parachains are deployed by name registration (ENS-style, see §4) with predictable costs.
2. **Equal-power validator voting.** Each registered parachain validator gets one vote on upgrades, NOT stake-weighted (see §7). This is consistent with Pyde's "uniform random + min stake, no stake weighting" committee philosophy and prevents large-stake validators from dominating parachain decisions.
3. **No maintained per-language SDK.** Pyde provides the Host Function ABI specification, a bundling CLI (`otigen`), and canonical example projects. Authors compile their own WASM in any wasm32-target language and declare host imports manually. See §11.

## 3. Architecture overview

A parachain at v1 consists of:

```text
┌─────────────────────────────────────────────────────────────────┐
│ Parachain account (on-chain)                                     │
│                                                                  │
│   parachain_id: [u8; 32]    (derived from name; see §4)          │
│   name:         String      ("chainlink", "uniswap", etc.)       │
│   owner:        Address                                          │
│   current_version: u32                                           │
│   versions:     Vec<ParachainVersionRecord>  (full history)       │
│   state_root:   [u8; 32]    (subtree root)                        │
│   config:       ParachainConfig                                  │
│   status:       Active | Paused | Killed                         │
└─────────────────────────────────────────────────────────────────┘
        │
        │ partitions
        ▼
┌─────────────────────────────────────────────────────────────────┐
│ Parachain state subtree (PIP-2 clustered under jmt_cf)           │
│                                                                  │
│   slot_hash format:                                              │
│     parachain_id[..16] || Hash(slot_namespace || ...)[..16]      │
│                                                                  │
│   → entire parachain's state lives in a contiguous JMT subtree   │
│   → snapshot, range scan, cross-parachain proof all efficient    │
└─────────────────────────────────────────────────────────────────┘
        │
        │ managed by
        ▼
┌─────────────────────────────────────────────────────────────────┐
│ Parachain validator committee                                     │
│                                                                  │
│   - Subset of Pyde's main 128-validator committee                 │
│   - Opted in at deploy time (or at upgrade)                       │
│   - Configurable size: min 7, default 21                          │
│   - Equal-power voting (1 validator = 1 vote)                     │
│   - Per-parachain consensus preset (simple_bft / threshold / opt) │
└─────────────────────────────────────────────────────────────────┘
        │
        │ executes
        ▼
┌─────────────────────────────────────────────────────────────────┐
│ Parachain WASM (wasmtime, Cranelift AOT)                          │
│                                                                  │
│   - Imports: only functions from the parachain ABI allowlist      │
│     (validated at deploy time)                                    │
│   - Linear memory: 64 MB cap                                      │
│   - Fuel: derived from tx.gas_limit                                │
│   - Deterministic feature subset (no threads, no SIMD floats, …)  │
└─────────────────────────────────────────────────────────────────┘
```

## 4. Parachain ID derivation

```text
parachain_id = Poseidon2("pyde-parachain:" || name_bytes)
```

Names are globally unique, ENS-style. 1-32 chars, single-letter allowed. First-come-first-served at registration with yearly renewal + grace period (see [Chapter 11](../chapters/11-account-model.md) for the full naming model).

**Why prefix the hash with `"pyde-parachain:"`** — to keep the parachain namespace disjoint from the contract namespace and the account namespace. A contract named `chainlink` and a parachain named `chainlink` would otherwise collide on Poseidon2(name). The prefix forces them into different `parachain_id` and `contract_address` values even when their human-readable names are identical.

**Why 32 bytes for the full ID** — see [memory: address-naming-collision]. Pyde uses full 32-byte addresses everywhere (no truncation). The first 16 bytes are used by PIP-2 clustering (§5); the full 32 bytes are the canonical identifier in receipts, events, and cross-parachain messages.

**Collision risk**: with `2^128` possible 16-byte clustering prefixes, the birthday bound is ~`2^64` names before a clustering collision becomes likely. Pyde additionally enforces uniqueness at registration time — the on-chain name registry rejects any name whose Poseidon2 hash matches an existing parachain's. PIP-2 collision risk is effectively zero.

## 5. State partitioning (PIP-2)

All of a parachain's state lives in a contiguous JMT subtree. The slot_hash format:

```text
slot_hash[0..16]   = parachain_id[..16]      (clustering prefix)
slot_hash[16..32]  = Hash(slot_namespace || key)[..16]
```

Where `slot_namespace` is the parachain's internal namespace (e.g., `"balances"`, `"orders"`, `"config"`) and `key` is the slot-specific key bytes.

Benefits inherited from PIP-2:

- **Snapshot efficiency.** Snapshotting a single parachain is a contiguous JMT subtree walk. No filtering, no global scan.
- **Range scan efficiency.** RocksDB's clustered key layout means the parachain's data lives in adjacent SST blocks. Hot parachains stay hot in the block cache.
- **Per-parachain state-root.** The subtree's root hash is naturally available; light clients can verify proofs against per-parachain roots without verifying the global root.
- **Cross-parachain proofs.** Parachain A can include a JMT inclusion proof from parachain B's state in its own state transitions — the verifier only needs B's subtree root, not B's full state.

The clustering applies recursively: within a parachain's namespace, the `slot_namespace` prefix further clusters related keys (all balances together, all orders together).

## 6. Lifecycle

```text
                  REGISTERING
                       │
       owner submits   │  RegisterParachainTx
       deploy fee +    │  with name + WASM + config
       owner deposit   │
                       ▼
                    ACTIVE
                    /  \
                   /    \  governance vote
        owner     /      \ to upgrade
        pause   ▼         ▼
              PAUSED   →  UPGRADING
                 │           │
                 │  owner    │  new version activates
                 │  unpause  │  at wave N + grace_period
                 │           │
                 ▼           ▼
              ACTIVE       ACTIVE (new version)

      kill (owner-only, irreversible)
                       │
                       ▼
                    KILLED
```

### 6.1 Registration

```text
RegisterParachainTx {
  name:              String                  // 1-32 chars
  initial_wasm:      WasmBytes               // ≤ 4 MB
  config:            ParachainConfig
  owner:             Address
  validator_set:     Vec<ValidatorPubkey>    // opt-in committee members
  deploy_fee_paid:   u128
  owner_deposit:     u128
}
```

Validations at registration:
1. Name is well-formed (1-32 chars, alphanumeric + hyphens).
2. Name is not already registered (uniqueness check via registry).
3. WASM module is well-formed and instantiable under Pyde's deterministic wasmtime config.
4. WASM imports only functions in the parachain ABI allowlist (§11).
5. `validator_set` ⊆ current main committee; size ≥ `config.min_validators`.
6. Owner has paid the deploy fee + has the owner deposit available.
7. Config is internally consistent (e.g., quorum_threshold ≤ validator_set.len()).

On success: `parachain_id` is derived (§4), the parachain account is initialized with version 0 (the initial WASM), state subtree root is set to empty (Poseidon2 of empty tree), status is `Active`.

### 6.2 Upgrade

```text
UpgradeParachainTx {
  parachain_id:      [u8; 32]
  new_wasm:          WasmBytes
  new_config:        ParachainConfig
  proposal_id:       ProposalId
  vote_certs:        Vec<FalconSig>          // ≥ quorum from §7
  threshold_sig:     ThresholdSig            // parachain committee threshold-signed
}
```

See §7 for the governance vote that produces these certs. On successful submission:
1. The transaction includes the upgrade in the next wave's commit.
2. A `ParachainVersionRecord` is appended to `versions` with `activated_at_wave = current_wave + grace_period` (default 100 waves ≈ 50s at 500ms/wave).
3. The parachain's `current_version` is bumped at the activation wave.
4. ALL parachain peers + relay nodes simultaneously swap the wasmtime `Module` instance. Old instance is discarded, new active. Module is pre-compiled and cached so the swap is sub-millisecond.
5. First N waves post-activation: nodes verify their local execution matches consensus. Mismatch = halt + alert (indicates corrupted upgrade or compile-time variation).

### 6.3 Pause / Unpause (owner-only)

Owner can pause the parachain via `PauseParachainTx`. While paused:
- New transactions targeting the parachain are rejected at ingress.
- Existing in-flight transactions complete normally.
- State is preserved; the subtree continues to exist.

Owner can resume via `UnpauseParachainTx`. No governance vote needed for pause/unpause — this is operational lifecycle, not a protocol-level decision.

### 6.4 Kill (owner-only, irreversible)

`KillParachainTx` marks the parachain `Killed`. After kill:
- New transactions are rejected.
- The owner deposit is returned to the owner (minus a cleanup fee).
- The parachain's state subtree is retained on-chain for `STATE_RETENTION_WAVES` (default ~1 year), then pruned by archive nodes.
- The name remains in the registry but cannot be re-registered for `NAME_REUSE_GRACE` (default 1 year) to prevent confusion.

### 6.5 Version history retention — never discarded

```rust
pub struct ParachainAccount {
    pub name: String,
    pub parachain_id: [u8; 32],
    pub current_version: u32,
    pub versions: Vec<ParachainVersionRecord>,    // FULL HISTORY, ordered
    pub balance: u128,
    pub config: ParachainConfig,
    pub state_root: [u8; 32],
    pub owner: Address,
    pub status: ParachainStatus,
}

pub struct ParachainVersionRecord {
    pub version: u32,
    pub wasm_hash: [u8; 32],
    pub wasm_blob_ref: ContentAddress,
    pub config_snapshot: ParachainConfig,
    pub activated_at_wave: WaveId,
    pub deactivated_at_wave: Option<WaveId>,
    pub upgrade_proposal_id: ProposalId,
    pub upgrade_vote_certs: Vec<FalconSig>,
    pub upgrade_committee_threshold_sig: ThresholdSig,
}
```

**Storage tiering:** the last 5 versions store WASM bytes on-chain. Older versions store only `wasm_hash` + `wasm_blob_ref` pointing to off-chain content-addressed storage (IPFS-like). Metadata (hashes, configs, signatures) stays on-chain forever. Authors are expected to maintain off-chain mirrors of historical builds; archive nodes also pin them.

**Why retain forever**: every parachain-touching tx receipt includes `(parachain_id, parachain_version, wasm_hash)`. Wave-commit records include a manifest of parachain versions active during that wave. Replay nodes (during state sync verification, slashing-evidence replay, or historical queries) use these to fetch the *exact* WASM binary that originally executed each tx. Discarding history would make replay impossible.

## 7. Governance: equal-power voting

```text
Parachain validators:  one validator, one vote
Quorum:                configurable per parachain (default 2/3 of validators must vote)
Threshold:             2/3 of voters say YES to pass
```

This is NOT stake-weighted. Each registered parachain validator gets exactly one vote on upgrade proposals, regardless of their stake size. The rationale (which mirrors Pyde's main-committee philosophy):

- Stake-weighting concentrates governance power in deep-pocketed validators.
- Equal-power voting is consistent with the anti-plutocracy stance baked into committee selection (see WHITEPAPER §5.5).
- Coalitions form on merit and operational reliability, not capital.

The vote flow:

1. **Proposal submission.** Anyone can submit an `UpgradeProposalTx` containing the new WASM + new config. The proposal enters a `Pending` state with a public discussion period (default: 7 days).
2. **Voting window.** Each parachain validator can submit a `VoteTx` with `{proposal_id, vote: yes|no|abstain, sig: FalconSig}`. Voting is open for the configured window (default: 3 days after the discussion period).
3. **Tally.** After the voting window closes, vote certs are collected. If quorum (2/3 of validators must vote) is met and threshold (2/3 of voters say YES) is hit, the proposal advances to `Approved`.
4. **Threshold ceremony.** The parachain's validator committee runs a threshold-signing ceremony over the proposal hash. The output is the `upgrade_committee_threshold_sig` that goes into the version record.
5. **Activation.** An `UpgradeParachainTx` includes the vote certs + threshold sig + new WASM + scheduled activation wave. After the grace period, the upgrade activates as described in §6.2.

If quorum is not met or threshold is not hit, the proposal is `Rejected` and cannot be re-submitted unchanged for `PROPOSAL_COOLDOWN` (default: 30 days).

## 8. Capability model (host-function allowlist)

Parachain WASM is sandboxed; host functions are the only escape. Pyde exposes a fixed allowlist:

**EXPOSED (parachain ABI):**

```text
storage:
  parachain_storage_read(key_ptr, key_len, out_ptr, out_len_ptr) -> i32
  parachain_storage_write(key_ptr, key_len, val_ptr, val_len) -> i32
  parachain_storage_delete(key_ptr, key_len) -> i32

events:
  parachain_emit_event(topic_ptr, topic_len, data_ptr, data_len) -> i32

context:
  parachain_get_caller(out_ptr) -> i32
  parachain_get_block_height() -> u64
  parachain_get_wave_id() -> u64
  parachain_get_parachain_id(out_ptr) -> i32

cross-parachain messaging (rate-limited):
  parachain_send_xparachain_message(target_id_ptr, msg_ptr, msg_len, callback_spec_ptr) -> i32

threshold crypto (optional):
  threshold_decrypt(ciphertext_ptr, ciphertext_len, out_ptr, out_len_ptr) -> i32
  threshold_encrypt(plaintext_ptr, plaintext_len, out_ptr, out_len_ptr) -> i32

hashing primitives:
  hash_keccak256(in_ptr, in_len, out_ptr) -> i32
  hash_blake3(in_ptr, in_len, out_ptr) -> i32
  hash_poseidon2(in_ptr, in_len, out_ptr) -> i32

explicit gas metering:
  consume_gas(units: u64) -> i32
```

**EXPLICITLY FORBIDDEN:**

```text
network calls (any kind) — non-deterministic
file/disk access — non-deterministic + capability escape
system clock — non-deterministic; use get_block_height instead
non-deterministic entropy — non-deterministic; use VRF beacon via host fn
direct RocksDB access — must route through parachain_storage_*
WASM threads — non-deterministic by definition
non-deterministic SIMD / float ops — determinism risk
WASI — not allowed (whole interface forbidden)
```

Deploy-time validation rejects any `.wasm` whose imports reference functions outside the allowlist. Hard-enforced — there is no opt-out.

## 9. Cross-parachain messaging

Parachains call each other via `parachain_send_xparachain_message`. Mechanics:

```text
send_xparachain_message(
  target_id: [u8; 32],          // target parachain
  msg: bytes,                   // payload (parachain-defined format)
  callback_spec: {
    callback_fn: String,        // function on the calling parachain
    max_callback_gas: u64,
    timeout_waves: u64,         // give up after this many waves
  }
) -> XCallId
```

The flow:
1. **Send.** Calling parachain's WASM invokes the host fn. A `XCallMessage` is recorded in the calling parachain's outgoing-queue state. The current wave's commit records the outgoing message.
2. **Threshold sig.** The calling parachain's validator committee threshold-signs the outgoing message (deferred to the next wave's vertex piggybacking; one threshold sig per outgoing message).
3. **Route.** Pyde's main consensus relays the message: every wave commit, the engine scans all outgoing-queue diffs and produces `XCallDeliveryTx` transactions targeting the destination parachain.
4. **Verify on receive.** The target parachain's validator committee verifies the incoming threshold sig against the source committee's pubkeys (which it knows from the on-chain registry). On verify failure, the message is dropped + logged (no callback fires).
5. **Execute.** On verify success, the target parachain's WASM is invoked with the message payload as input. The target executes, may emit events, may write state.
6. **Callback.** A return value (or timeout) is recorded in the target's outgoing-queue, routed back to the original caller, and that caller's `callback_fn` is invoked with the result + the callback context.

**Rate limit**: each parachain has a configurable budget of outgoing messages per wave (default: 64). Exceeding the budget causes the host fn to trap with `XCallRateLimited`.

**Callback context** is preserved across the round-trip:

```text
callback_id        unique per call
original_caller    address that initiated the original tx
original_fn        function that issued the cross-call
original_args_hash hash of original args (full args retrievable from chain log)
issued_at_wave     when the call was issued
target_id          which parachain was called
```

This is the same callback context model as `cross_call` (Chapter 13 §13.4), just specialized for parachain-to-parachain.

## 10. No-SDK approach

Pyde does **not** ship a maintained per-language SDK for parachain development. The rationale (locked in 2026-05-21 session):

- A solo-founder's bandwidth cannot maintain language-specific SDKs alongside the core protocol — that is months of work per year per language.
- The WASM ecosystem already has mature toolchains for Rust, AssemblyScript, Go (TinyGo), C/C++, Zig.
- Per-language SDKs create version-skew between SDK and ABI; better to have a single ABI doc that languages adapt to (and that the language-community can wrap on their own time).
- Ethereum's ecosystem has 50+ community Web3 libraries — none "official." Healthy decentralized tooling emerges this way.

What Pyde provides:

1. **Host Function ABI Specification** — a ~10-page document covering names, signatures, memory layout conventions, gas cost table per host function, ABI versioning rules.
2. **`otigen parachain` CLI**:
   - `bundle`: package `.wasm` + `parachain.toml` into a deploy artifact.
   - `submit`: sign and send the deploy tx.
   - `upgrade`: replace WASM bytes via governance flow.
   - `pause` / `unpause` / `kill`.
3. **On-chain parachain registry** — single source of truth for config + WASM bytes + version history.
4. **Hardcoded bootstrap nodes** — peer discovery; no DHT (see [Network Protocol](./NETWORK_PROTOCOL.md)).
5. **Slashing preset menu** — minimal / standard / strict; authors pick at deploy time.
6. **Canonical example parachains** (NOT maintained SDKs — just starter projects authors can copy and modify):
   - `hello-world-parachain` (Rust)
   - `hello-world-parachain` (AssemblyScript)
   - `hello-world-parachain` (Go/TinyGo)

What authors provide:

- Their compiled `.wasm` (any wasm32-target language).
- A `parachain.toml` config file declaring state schema, consensus preset, slashing preset, allowed host imports.
- Manual `extern "C"` (or language-equivalent) import declarations for host functions they call.

## 11. ZK-readiness path baked in

Authors are instructed (in the ABI doc) to use the deterministic WASM subset:
- No floats outside canonical NaN.
- No threads.
- No non-deterministic SIMD.
- No mutable globals (only immutable globals or per-instance memory).

This keeps WASM bytecode amenable to future **zk-WASM proving** (~2-3 years out per current research trajectory). Authors who comply now will be ZK-ready by default later. Non-deterministic features are already blocked by Pyde's wasmtime config (deploy validator rejects them), so compliance is automatic.

## 12. Slashing presets

Parachains pick from a three-tier menu at deploy time:

| Preset | Equivocation | Bad state root | Liveness (offline) |
|---|---|---|---|
| `minimal` | 5% | 5% | 0.5%/epoch |
| `standard` | 25% | 10% | 1%/epoch |
| `strict` | 50% | 25% | 2%/epoch |

The preset applies to that parachain's validator committee only — not to those validators' main-committee stake. Main-committee slashing (see [SLASHING.md](./SLASHING.md)) is separate and additive.

Why a preset menu rather than free parameters: small parachain teams should not have to make slashing-economics decisions. The presets are sane defaults chosen by Pyde's economic model. If a parachain wants custom slashing, they can submit a PPIP to add a new preset; the existing three should cover 95% of use cases.

## 13. Parachain economics

PYDE is the gas token across the platform. Every parachain operation that touches state, emits events, sends cross-parachain messages, or consumes execution gas is metered in PYDE via wasmtime fuel — exactly the same as smart-contract operations. Authors pay registration fees + owner deposits in PYDE at deploy time. Validators of a parachain earn PYDE rewards via the standard inflation distribution, weighted by their committee membership and uptime.

Parachain authors can layer their own internal token economies on top (e.g., a DEX parachain might mint LP tokens; a DAO parachain might mint governance tokens) — but those are application-layer concerns, not protocol-level mechanics. The protocol charges PYDE; what the parachain charges its users is its own decision.

This keeps the gas accounting simple: one token, one fuel mechanism, uniform across smart contracts and parachains.

## 14. Failure modes

| Failure | Detection | Recovery |
|---|---|---|
| Parachain WASM enters infinite loop | Fuel exhausted → trap | Tx fails; gas charged; state rolled back |
| Cross-parachain message verify fails | Target committee rejects | Message dropped + logged; no callback fires |
| Cross-parachain message timeout | `timeout_waves` exceeded | Callback fires with `XCallTimeout` error |
| Parachain committee falls below quorum | Wave-commit fails for parachain txs | Parachain enters `LimpMode`; only no-state txs land until quorum restored |
| Bad WASM upgrade (deterministic divergence) | First N post-activation waves see local-vs-consensus mismatch | Hard halt + alert; manual emergency rollback via main governance |
| State subtree corruption | JMT root mismatch on snapshot verification | Cross-verify with peers; re-sync the parachain's subtree from snapshot |
| Name registry race (two parties register same name simultaneously) | Atomic registry check rejects later one | First confirmed at wave-commit wins; later one refunded |

## 15. v2 directions

Tracked but explicitly deferred to v2 or later:

- **ZK-aggregated FALCON signature verification** for parachain committees — the path to massively higher throughput. ~95% of the prerequisite work (dual-hash JMT, Poseidon2 state root) is done at v1; the aggregation circuit + verifier is v2 work.
- **Adaptive validator-set rotation per parachain** — currently the validator set is fixed at deploy and changes via governance. v2 may allow continuous rotation based on uptime / stake.
- **Multi-WASM execution within one parachain** — currently one parachain = one WASM module. v2 could allow modular parachains with hot-swappable components.
- **First-class light-client parachain bootstrap** — currently new parachain validators sync the full subtree. v2 could ship per-parachain light-client mode for resource-constrained validators.

## 16. References

- Narrative overview: [Chapter 13](../chapters/13-cross-chain.md)
- Account model + naming: [Chapter 11](../chapters/11-account-model.md)
- State model + PIP-2 clustering: [Chapter 4](../chapters/04-state-model.md)
- Execution layer + WASM: [Chapter 3](../chapters/03-virtual-machine.md)
- Slashing: [SLASHING.md](./SLASHING.md)
- Threat model: [THREAT_MODEL.md](./THREAT_MODEL.md)
- Network protocol: [NETWORK_PROTOCOL.md](./NETWORK_PROTOCOL.md)

---

**Document version:** 0.1

**License:** See repository root
