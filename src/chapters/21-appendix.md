# Chapter 21: Appendix

Reference material from across the book in one place: the glossary, the
constants tables, the discriminator registry, the JSON-RPC method index,
and the post-mainnet plan.

---

## A. Glossary

| Term                 | Definition                                                                 |
| -------------------- | -------------------------------------------------------------------------- |
| **Pyde**             | The post-quantum L1 blockchain. Name of the protocol, the network, and the binary. |
| **PYDE**             | The native token. 1 PYDE = 10^9 quanta.                                     |
| **otigen**           | Pyde's developer toolchain (the binary). Scaffolds projects, builds WASM artifacts, deploys, manages wallets. Name carried forward from the retired Otigen language. |
| **WASM**             | WebAssembly. Pyde's execution layer; smart contracts and parachains compile to WASM and execute under wasmtime. |
| **wasmtime**         | The WebAssembly runtime used by Pyde. Bytecode Alliance project, production-vetted at Microsoft / Fastly / Shopify. |
| **Host Function ABI**| The stable interface contracts use to interact with chain state (sload, sstore, transfer, hashing, FALCON verify, cross_call, etc.). See the Host Function ABI spec. |
| **Cranelift**        | The code generator used by wasmtime for ahead-of-time WASM-to-native compilation. |
| **Otigen** (retired) | Was Pyde's domain-specific smart-contract language. Retired in the WASM pivot; see [The Pivot preface](../preface/pivot.md). The Otigen Book is preserved as a historical artifact. |
| **JMT**              | Jellyfish Merkle Tree. The state commitment structure (radix-16, path-compressed). |
| **Blake3**           | Fast bitwise hash. Used for JMT internals, batch hashes, vertex hashes, gossip de-dup. |
| **Poseidon2**        | Algebraic hash over the Goldilocks field. State root commit, addresses, MAC, VRF, ZK-bearing paths. |
| **FALCON-512**       | NIST FIPS 206 post-quantum signature scheme. ~666-byte sigs, 897-byte pks.   |
| **Kyber-768**        | NIST FIPS 203 post-quantum KEM. P2P / transport session keys.              |
| **Threshold encryption** *(retired)* | A committee-key encrypted mempool (Kyber + Shamir 85-of-128) from earlier drafts. Removed from the protocol: trustless PQ threshold keygen is research-blocked (lattice pubkeys do not combine homomorphically). MEV protection is now the keyless commit-reveal mempool (Chapter 9). A one-shot ciphertext lane stays v2+ research; see [Chapter 20](20-future-direction.md). |
| **PSS** *(retired)*  | Proactive Secret Sharing, which refreshed threshold key shares in the retired encrypted-mempool design. Gone with the threshold lane. |
| **DKG** *(retired)*  | Distributed Key Generation: the per-epoch threshold-pubkey ceremony in the retired encrypted-mempool design. Gone with the threshold lane. |
| **VRF**              | Verifiable Random Function. Lattice-based; built from FALCON + Poseidon2.   |
| **Mysticeti**        | The DAG-based consensus protocol Pyde uses (post-2026 pivot, formerly HotStuff). |
| **DAG**              | Directed Acyclic Graph. Every round, each committee member produces a vertex; parents must be strictly prior rounds. |
| **Vertex**           | A committee member's per-round output: batch refs + parent refs + state-root sigs + FALCON sig. |
| **Round**            | A ~150 ms DAG cycle. Each member produces one vertex per round.            |
| **Wave**             | The Mysticeti commit unit. Anchor at round R+3 commits the subdag rooted at round R. |
| **Anchor**           | Deterministically-selected committee member whose round-R vertex commits the wave. `Hash(beacon, round, prev_state_root) mod 128`. |
| **Worker / Primary** | Narwhal pattern: workers gossip tx batches, primary produces vertices and runs consensus. |
| **HardFinalityCert** | ≥ 86 FALCON sigs over `(wave_id, blake3_state_root, poseidon2_state_root)`. |
| **Committee**        | The 128 active validators per epoch. Equal vote weight; uniform random selection. |
| **Epoch**            | ~3 hours of waves. Committee rotation + next-epoch beacon fire at the boundary. |
| **Validator**        | Node staking ≥ `MIN_VALIDATOR_STAKE` (10,000 PYDE). Single tier; uniform-random committee selection picks 128 from the eligible pool each epoch. |
| **Full node**        | Node that executes waves and serves RPC, but does not stake.                |
| **MEV**              | Maximal Extractable Value. The MEV class is structurally closed in Pyde.    |
| **Commit-reveal mempool** | Optional keyless commit-reveal lane for MEV-sensitive txs: Commit (0x11) locks a Blake3 commitment + bond, Reveal (0x12) discloses the inner tx after DAG order is fixed. No committee key, no decryption. See Chapter 9. |
| **Commit-reveal**    | The commit-reveal mempool mechanism: the DAG fixes commit order before inner-tx content is revealed, so revealed txs execute in that fixed order (not reveal order). Front-running is structurally impossible; no committee key involved. |
| **Block-STM scheduler** | Execution model: uniform optimistic parallel execution through an MVCC layer; conflicts detected at validation, losers re-execute until fixpoint. Access lists from `pyde_simulateTransaction` drive PIP-3 multiget prefetch but never partition the wave. |
| **Sentry node**      | Public-facing proxy in front of a committee validator. Hides validator's real IP. |
| **Treasury**         | The system account at `Poseidon2("pyde-treasury")`. Spent via on-chain multisig.|
| **PIP**              | Pyde Improvement Proposal. Off-chain documents that drive code changes.     |
| **Multisig signers** | The on-chain set authorized to spend the treasury (`MULTISIG_SIGNERS`).     |
| **Emergency pause**  | Multisig-authorized halt of non-Resume txs; max 30 days, auto-expiring.     |
| **Hard halt**        | Automatic chain halt on detected safety violation (state root divergence, equivocation cluster). |
| **Weak-subjectivity checkpoint**| Hard-finalized commit (`wave_id` + `state_root` + committee FALCON sigs) that a fresh node trusts to anchor sync. |
| **Quanta**           | Smallest PYDE denomination. 1 PYDE = 10^9 quanta.                           |
| **Access list**      | Per-tx declaration of state slots the tx will read or write.                |
| **Nonce window**     | 16-slot bitmap of in-flight nonces per account.                              |
| **Gas tank**         | Per-account dedicated balance for sponsoring user transactions.              |
| **Paymaster**        | A contract that pays gas on behalf of a user, with custom validation logic. |
| **Parachain operator** | Permissionless v2 actor who stakes PYDE, fulfills `parachain_call!` requests to other chains and data sources, earns gas fees. |

---

## B. Network Constants

| Constant                           | Value                          | Where                              |
| ---------------------------------- | ------------------------------ | ---------------------------------- |
| — (no constant)                    | ~150 ms DAG round, observed     | Rounds advance on ≥ quorum distinct members, never on a clock (`consensus/src/round.rs`); the ~150 ms figure is documented on `Round` in `types/src/consensus.rs` |
| `TARGET_WAVE_MS`                   | 500 (median commit)             | `types/src/consensus.rs`            |
| `EPOCH_LENGTH_WAVES`               | 21,600 (3 h at 500 ms)          | `types/src/consensus.rs`            |
| `COMMITTEE_SIZE` (mainnet)         | 128                             | `types/src/consensus.rs`            |
| `QUORUM` (⌊(n+f)/2⌋+1)             | 86                              | `types/src/consensus.rs`            |
| — (no constant)                    | 44 equivocation threshold (n−2f) | Derived as `2 × QUORUM − COMMITTEE_SIZE`; the matching `f = 42` is `MAX_BYZANTINE` in `slashing/src/amount.rs` |
| — (no constant)                    | 86 beacon-combine threshold     | `derive_beacon_combine_thresholds` in `node/src/validator.rs` clamps the node's configured `support_quorum` (86 in production) and passes it to `FalconBeaconScheme::with_threshold`. The `BEACON_THRESHOLD = 85` in `consensus/src/beacon.rs` is only the default of each scheme's `new()`; the validator path never uses it |
| `COMMIT_REVEAL_WINDOW_WAVES`       | 120                             | `tx/src/commit_reveal.rs`           |
| `MIN_COMMIT_BOND`                  | 1e9 quanta (1 PYDE)             | `tx/src/commit_reveal.rs`           |
| `MIN_VALIDATOR_STAKE`              | 10¹³ quanta (10,000 PYDE)       | `tx/src/handlers/staking.rs` (single tier) |
| `OPERATOR_CAP`                     | 3                               | `tx/src/handlers/staking.rs` (anti-Sybil cap) |
| `UNBONDING_PERIOD_WAVES`           | 5,184,000 (30 days)             | `tx/src/handlers/staking.rs`        |
| `MAX_MULTISIG_SIGNERS`             | 16                              | `types/src/account.rs`              |
| `NONCE_WINDOW_SIZE`                | 16                              | `types/src/account.rs`              |
| `BATCH_MAX_BYTES`                  | 4 MB                            | `node/src/vertex_producer.rs`       |

Finder's fee, evidence version, multisig version and a maximum pause
duration were listed here in earlier drafts as named constants. No
constant by any of those names exists in the engine today, so they have
been removed rather than pointed at a plausible-looking file; re-add
them only alongside a real definition site.

## C. Gas / Fee Constants

| Constant                | Value                       | Where             |
| ----------------------- | --------------------------- | ----------------- |
| `GAS_TARGET`            | 400,000,000                  | `tx/src/fee.rs`        |
| `GAS_CEILING`           | 1,600,000,000 (4× target)    | `tx/src/fee.rs`        |
| `base_fee_start`        | 100 quanta/gas (genesis manifest field, not a code constant) | `types/src/genesis.rs` |
| `MIN_BASE_FEE`          | 1                            | `tx/src/fee.rs`        |
| `ADJUSTMENT_DIVISOR`    | 8 (1/8 = 12.5% per wave)     | `tx/src/fee.rs`        |
| `BURN_BPS`              | 3,000 (30%)                  | `tx/src/fee.rs`        |
| `REWARD_POOL_BPS`       | 5,000 (50%)                  | `tx/src/fee.rs`        |
| (treasury)              | remainder (20%, catches dust) | `tx/src/fee.rs`        |
| `MIN_GAS_LIMIT`         | 21,000                       | `types/src/tx.rs`  |
| `MAX_TX_SIZE`           | 128 KB                       | `tx/src/validation.rs` |
| `MAX_CALLDATA`          | 64 KB                        | `tx/src/validation.rs` |
| `EMISSION_CAP_BPS`      | 100 (~1%/yr, one-way-down)   | `tx/src/distributor.rs`|
| `WAGE_CAP_PER_SEAT_EPOCH` | 13,698,630,136 quanta (40K PYDE/seat/yr) | `tx/src/distributor.rs`|
| `GENESIS_SUPPLY_QUANTA` | 10^18 quanta (1B PYDE)       | `tx/src/distributor.rs`|

## D. Mempool Constants

| Constant                                  | Value      | Where             |
| ----------------------------------------- | ---------- | ----------------- |
| `DEFAULT_MAX_SIZE` (pool capacity)        | 50,000     | `mempool/src/mempool.rs` |
| `DEFAULT_MAX_PER_SENDER`                  | 64         | `mempool/src/mempool.rs` |
| `DEFAULT_RATE_PER_SEC` (per sender)       | 10         | `mempool/src/mempool.rs` |
| `DEFAULT_RATE_BURST` (per sender)         | 20         | `mempool/src/mempool.rs` |
| `DEFAULT_GLOBAL_RATE_PER_SEC`             | 1,000      | `mempool/src/mempool.rs` |
| `DEFAULT_GLOBAL_BURST`                    | 2,000      | `mempool/src/mempool.rs` |
| `NONCE_WINDOW_SIZE` (nonce bitmap)        | 16         | `types/src/account.rs` (re-exported from `types/src/tx.rs`) |
| `MIN_COMMIT_BOND`                         | 10^9 quanta (1 PYDE) | `tx/src/commit_reveal.rs` |
| `COMMIT_REVEAL_WINDOW_WAVES`              | 120        | `tx/src/commit_reveal.rs` |

## E. WASM Execution Constants

| Constant                    | Value          | Where / meaning                                    |
| --------------------------- | -------------- | -------------------------------------------------- |
| `POOL_MAX_MEMORY_SIZE`      | 4 MB           | `wasm-exec/src/engine.rs` — per-instance linear-memory ceiling in the wasmtime pooling allocator |
| `POOL_TOTAL_MEMORIES`       | 1,024          | `wasm-exec/src/engine.rs` — pooled memory slots; the VMA reservation is this × `POOL_MAX_MEMORY_SIZE` |
| `POOL_TOTAL_INSTANCES`      | 1,024          | `wasm-exec/src/engine.rs`                          |
| `POOL_LINEAR_MEMORY_KEEP_RESIDENT` | 64 KB   | `wasm-exec/src/engine.rs` — kept mapped between calls; the rest is decommitted |
| `DEFAULT_MAX_MODULES`       | 1,024 entries  | `wasm-exec/src/cache.rs` — AOT module cache is bounded by entry COUNT, not bytes. TTL eviction exists but defaults to `None` (disabled) |
| `VIEW_FUEL_CAP`             | 10,000,000     | `wasm-exec/src/host_fns/cross_call_static.rs` — per-call fuel cap for `cross_call_static` views (≈ 3 ms commodity). View calls are free; this bounds wall-clock. |
| Stack depth limit           | wasmtime-enforced | Rejects modules exceeding the configured cap    |

Note: PVM-era constants (4 MB address space, 16+8 register file, 62 opcodes) are retired. WASM's instruction set is the WebAssembly Core Specification; the host-function ABI is defined in [companion/HOST_FN_ABI_SPEC.md](../companion/HOST_FN_ABI_SPEC.md).

## F. Network / Discovery Constants

| Constant                       | Value         | Where             |
| ------------------------------ | ------------- | ----------------- |
| `MAX_ESTABLISHED_INCOMING`     | 128           | `net/src/behaviour.rs` |
| `MAX_ESTABLISHED_OUTGOING`     | 64            | `net/src/behaviour.rs` |
| `MAX_ESTABLISHED_TOTAL`        | 192 (= in + out) | `net/src/behaviour.rs` |
| `MAX_ESTABLISHED_PER_PEER`     | 4             | `net/src/behaviour.rs` |
| `MAX_PENDING_INCOMING`         | 32            | `net/src/behaviour.rs` |
| `MAX_PENDING_OUTGOING`         | 16            | `net/src/behaviour.rs` |
| `GOSSIPSUB_HEARTBEAT`          | 1 s           | `net/src/behaviour.rs` |
| `SMALL_CLUSTER_HEARTBEAT`      | 200 ms (devnet clusters < 6) | `net/src/behaviour.rs` |
| `GOSSIPSUB_MAX_TRANSMIT_SIZE`  | 4 MiB         | `net/src/behaviour.rs` |
| `CONSENSUS_FETCH_CAPACITY` / refill | 2,048 / 1,024 per s | `net/src/inbound_limit.rs` |
| `CHUNK_SERVE_CAPACITY` / refill| 512 / 256 per s | `net/src/inbound_limit.rs` |
| `DURABLE_VERTEX_SERVE_CAPACITY` / refill | 64 / 32 per s | `net/src/inbound_limit.rs` |
| Bootnodes                      | operator-supplied file, no compiled-in seed list | `net/src/discovery.rs` (`read_bootnodes` / `parse_bootnodes`) |

There are no `MAINNET_SEEDS` / `TESTNET_SEEDS` / `MAINNET_DNS_SEED`
constants in the tree, and no per-IP connect-rate or idle-timeout setting:
peer sources are operator-configured or chain-derived (Chapter 12 §12.5).

---

## G. State Discriminators

Used in `Poseidon2(addr || discriminator || sub_key)` for storage keys.
The discriminant constants are defined in `crates/tx/src/system_slots.rs`;
the key derivation that consumes them is `crates/state/src/slot_key.rs`.

| Discriminator | Name                      | Holds                                   |
| ------------- | ------------------------- | --------------------------------------- |
| 0x14          | `REWARDS_PER_STAKE_UNIT`  | Legacy accrual accumulator (inert in v1; pay is the per-epoch wage) |
| 0x15          | `TOTAL_ACTIVE_STAKE_WEIGHTED` | Legacy pool denominator (inert in v1)      |
| 0x16          | `TOTAL_BURNED`            | Cumulative fee burn counter                    |
| 0x17          | `EPOCH_FEE_INFLOW`        | Reward-pool fee inflow since the last distribution |
| 0x18          | `AIRDROP_ROOT`            | Genesis airdrop Merkle root                    |
| 0x19          | `AIRDROP_DEADLINE`        | wave_id after which sweep is allowed           |
| 0x1A          | `AIRDROP_CLAIMED`         | Per-leaf-index claim bitmap                    |
| 0x1B          | `AIRDROP_EXPECTED_SUM`    | Genesis pool size invariant                    |
| 0x1C          | `TOTAL_MINTED`            | Cumulative emission mint (mirror of `TOTAL_BURNED`) |
| 0x1D          | `EPOCH_SEAT_ANCHORS`      | Per-seat committed anchor-leadership tally (payout weight) |
| 0x26          | `NEXT_DISTRIBUTION_EPOCH` | Distributor idempotence guard                  |
| 0x28          | `COMMITTEE_REGISTRY`      | member_id to operator map for the settled epoch |
| 0xF0          | `MULTISIG_SIGNERS`        | Treasury multisig signer set (FALCON pks)      |
| 0xF1          | `MULTISIG_THRESHOLD`      | Required signature count                       |
| 0xF2          | `MULTISIG_NONCE`          | Replay-protection counter for multisig actions |
| 0xF3          | `IS_PAUSED`               | Emergency-pause gate                           |

---

## H. Transaction Type Registry

Defined as `TxType` in `crates/types/src/tx.rs`.

Tag `2` is intentionally vacant: `Batch` was prototyped pre-mainnet and
removed before launch (see Chapter 11 §11.9). A forged `tx_type = 2`
fails decode.

| ID  | Name              | Purpose                                                |
| --- | ----------------- | ------------------------------------------------------ |
| 0   | `Standard`        | Value transfer or contract call                         |
| 1   | `Deploy`          | Contract deployment                                     |
| 3   | `StakeDeposit`    | Lock ≥ 10,000 PYDE and register validator (single tier, uniform-random committee selection per epoch) |
| 4   | `StakeWithdraw`   | Begin 30-day unbonding                                  |
| 5   | `Slash`           | Submit double-sign evidence                             |
| 6   | `ClaimReward`     | Claim accrued staking yield from the pool               |
| 7   | `ClaimAirdrop`    | Claim genesis airdrop with Merkle proof                 |
| 8   | `SweepAirdrop`    | Move unclaimed airdrop residue to treasury (post-deadline)|
| 9   | `MultisigTx`      | Treasury spend with multisig signatures                  |
| 10  | `RotateMultisig`  | Rotate multisig signer set + threshold                   |
| 11  | `EmergencyPause`  | Halt wave production (multisig-signed)                   |
| 12  | `EmergencyResume` | Resume normal processing                                  |
| 13  | `RegisterPubkey`  | First-time pubkey binding for a funded-but-unregistered account (no sig, no gas; proof is address-derivation) |
| 17 (`0x11`) | `Commit`  | Commit-reveal mempool commit: `to` = zero, `value` = required_bond, `data` = borsh(`CommitPayload { commitment, value_ceiling }`). Bond escrowed on inclusion; refunded on accepted reveal, burned on expiry. |
| 18 (`0x12`) | `Reveal`  | Commit-reveal mempool reveal: `to` = zero, `value` = 0, `data` = borsh(`RevealPayload { commitment, nonce, inner_tx }`). Any account may submit; inner tx executes in DAG commit order within `COMMIT_REVEAL_WINDOW_WAVES`. |

---

## I. WASM Host Function Surface (Summary)

Pyde's execution layer is WebAssembly. The WASM instruction set itself is the WebAssembly Core Specification, defined and maintained externally, not by Pyde. What Pyde defines is the **Host Function ABI**: the chain-side surface that contracts call to interact with state, accounts, crypto, events, and other chain primitives.

The full Host Function ABI specification (signatures, memory layout conventions, gas cost table, versioning rules, parachain-extension allowlist, forbidden imports) lives at [companion/HOST_FN_ABI_SPEC.md](../companion/HOST_FN_ABI_SPEC.md). The high-level surface, organized by category:

### Storage
`sload`, `sstore`, `sdelete`

### Balances and transfers
`balance`, `transfer`

### Execution context
`caller`, `origin`, `self_address`, `wave_id`, `wave_timestamp`, `chain_id`

### Events
`emit_event`

### Hashing primitives
`keccak256`, `blake3`, `poseidon2`

### Post-quantum cryptography
`falcon_verify`

### Cross-contract / cross-parachain
`cross_call`

### Gas accounting
`consume_gas`

### Parachain-extension host functions (parachain-only)
`send_xparachain_message`, `get_committee_info`, additional governance hooks (full list in the Host Function ABI spec).

### Forbidden imports (enforced at deploy)
Network calls, filesystem access, system clock, non-deterministic entropy, WASM threads, non-deterministic SIMD.

The deploy-time validator rejects any WASM module whose import section references functions outside this allowlist.

---

## J. JSON-RPC Method Index

Full reference in Chapter 17. The methods, prefixed `pyde_`:

| Method                          | Returns                                |
| ------------------------------- | -------------------------------------- |
| `pyde_getBalance`               | balance (quanta string)                |
| `pyde_getTransactionCount`      | nonce (u64)                            |
| `pyde_getCode`                  | hex bytecode                           |
| `pyde_getStorageAt`             | hex value                              |
| `pyde_chainId`                  | hex chain_id                           |
| `pyde_waveId`                   | hex head wave_id                       |
| `pyde_gasPrice`                 | base fee (quanta)                      |
| `pyde_stateRoot`                | current state root                     |
| `pyde_syncing`                  | sync status object                     |
| `pyde_getValidators`            | validators with status + stake          |
| `pyde_getWave`                  | wave commit record (no arg = latest)   |
| `pyde_getWaveClosure`           | committed sub-DAG closure for a wave   |
| `pyde_getTransactionReceipt`    | receipt with logs + fee breakdown       |
| `pyde_getLogs`                  | matching logs                          |
| `pyde_mempoolSize`              | pending tx count                        |
| `pyde_sendRawTransaction`       | tx hash                                |
| `pyde_sendTransaction`          | (dev only) tx hash                     |
| `pyde_call`                     | view-function return data (FREE off-chain) |
| `pyde_estimateGas`              | gas estimate                           |
| `pyde_createAccessList`         | inferred access list                   |
| `pyde_getHardFinalityCert`      | committee-signed cert for a wave (incl. state_root + events_root + events_bloom) |
| `pyde_getSnapshotManifest`      | snapshot manifest for state sync       |
| `pyde_resolveName`              | name → address registry lookup         |

WebSocket subscriptions (via `pyde_subscribe({method, ...})`): `newHeads`
(wave commits), `accountChanges`, `logs` (events with AND+OR topic / contract
filter; at-least-once delivery with cursor for dedup). `pyde_resubscribe({from: cursor})`
resumes a `logs` stream after disconnect. Full mechanics:
[HOST_FN_ABI_SPEC §15.5](../companion/HOST_FN_ABI_SPEC.md).

---

## K. Cryptographic Primitives Summary

| Purpose                | Primitive                       | Sizes                             |
| ---------------------- | ------------------------------- | --------------------------------- |
| Digital signatures     | FALCON-512 (NIST FIPS 206)      | pk 897 B, sk 1281 B, sig ~666 B   |
| Key encapsulation      | Kyber-768 / ML-KEM (FIPS 203)   | pk 1184 B, sk seed 64 B, ct 1088 B|
| High-volume hashing    | Blake3                           | 256-bit output, ~3 GB/s native     |
| ZK-bearing hashing     | Poseidon2 over Goldilocks       | 256-bit output, ~400 constraints/hash|
| Commit-reveal mempool (MEV) | Blake3 commitment + FALCON sig | keyless commit-reveal; 32-byte commitment, no committee key |
| VRF                    | FALCON-proof + Poseidon2 output | inherits FALCON security           |
| Symmetric AEAD         | AES-256-GCM (hardware-accelerated)| 32-byte key, 16-byte tag          |
| Address                | `Poseidon2(falcon_pubkey)`       | 32 bytes                           |

No elliptic curves anywhere in the protocol.

---

## L. Post-Mainnet Plan

Items explicitly out of scope for the launch network, with the rough
priority each is tracked at:

| Item                                                      | Priority | Notes                                      |
| --------------------------------------------------------- | -------- | ------------------------------------------ |
| Persistent receipt store (archive-node mode)              | High     | Task 058. Needed for production explorers. |
| ML-KEM upgrade from 0.3.0-rc to stable                    | High     | Task 057. Once NIST stable releases.       |
| Algebraic batch FALCON verification                       | High     | Per-wave verification cost reduction.       |
| Signed-mempool commitments + censorship slashing          | High     | Replaces local-view mandatory inclusion.    |
| Threshold-LWE one-shot ciphertext mempool                 | Research | Optional lane beside the keyless commit-reveal default; gated on a trustless PQ threshold-keygen breakthrough. See [Chapter 20](20-future-direction.md). |
| Graceful drain-and-shutdown on persist failure            | Medium   | Task 014e. Operational polish.              |
| Two-dimensional gas (exec + prove)                        | Medium   | Depends on ZK proving landing.              |
| Off-chain Merkle builder CLI for airdrop ops              | Medium   | Operator tooling, ~150 LOC.                 |
| Mempool-level filter during emergency pause               | Low      | Cleaner than gate-check at admission.       |
| Sentry-node validator hiding                              | Low      | Operational pattern, not protocol.          |
| Sophisticated peer scoring                                | Medium   | Multi-topic + decay parameters.              |
| Fancy version-signaling on-chain                          | Low      | Currently out-of-band.                       |
| ZK validity proofs (STARK proving)                        | Research | Major redesign; restores prover economics.   |
| Native Ethereum bridge                                    | High     | FALCON-in-EVM verifier + Patricia verifier as a Pyde WASM contract. |
| Native Bitcoin bridge                                     | Medium   | SPV-style proofs; PoW finality is probabilistic.|
| Parachain SDK (Rust / Go / C++)                            | Medium   | Sovereign chains sharing Pyde security.      |
| TypeScript SDK                                            | Medium   | WASM bridge available now; dedicated TS later.|
| Native browser wallet                                     | Low      | Ecosystem; WASM exposes primitives.          |
| Block-explorer frontend                                   | High     | Backend in Phase 7; UI is ecosystem.         |

The list is the project's tracked future work, not a commitment timeline.
Each item moves on PIP merit, audit capacity, and ecosystem demand.

---

## M. Key References in the Codebase

For readers diving into the source. Every `crates/…` path below is
relative to the `engine` workspace and resolves in the current tree;
rows naming a separate repository (`pyde-crypto`, `pyde-rust-sdk`,
`pyde-crypto-wasm`, `otigen`) are polyrepos alongside it. The
pre-pivot PVM-era crates are preserved with full git history in
[`pyde-net/archive`](https://github.com/pyde-net/archive), but nothing
in this table points there.

| Subsystem            | Key files                                                    |
| -------------------- | ------------------------------------------------------------ |
| Crypto stack         | `pyde-crypto` polyrepo (FALCON, Blake3, Poseidon2) — not in the engine tree |
| State commitment     | `crates/state/src/{jmt_store,slot_key,snapshot,snapshot_verify}.rs` |
| Account record       | `crates/account/src/{account,address,names,store}.rs`          |
| Slashing             | `crates/slashing/src/{amount,offense,evidence,slasher,downtime,rewards}.rs` |
| TX validation + fees | `crates/tx/src/{validation,fee,signature,hashing}.rs`, handlers in `crates/tx/src/handlers/` |
| Multisig / governance| `crates/tx/src/multisig.rs`, `crates/tx/src/handlers/multisig_tx.rs` |
| Airdrop              | `crates/tx/src/handlers/airdrop.rs`                            |
| Consensus            | `crates/consensus/src/{dag,anchor,wave_commit,validator,finality,beacon,committee,round}.rs` |
| Networking           | `crates/net/src/{network,behaviour,peer,transport,discovery,topics,inbound_limit}.rs` |
| Mempool              | `crates/mempool/src/{lib,mempool,mempool_view}.rs`            |
| Node binary + RPC    | `crates/node/src/{main,cli,rpc,validator,consensus_store,full_node,runtime}.rs` |
| WASM execution layer  | `crates/wasm-exec/src/{lib,executor,executor_impl,engine,cache,fuel,deploy,block_stm_executor}.rs` + the `host_fns/` directory |
| `otigen` developer toolchain | `pyde-net/otigen` (separate repo): subcommand framework, otigen.toml schema, language detection, state binding generators (Rust/AS/Go/C), deploy flow, wallet |
| Rust SDK             | `pyde-rust-sdk` polyrepo: `src/{lib,constants,factory,multisig}.rs` + the `provider/`, `signer/`, `wallet/`, `contract/`, `tx/`, `abi/`, `types/`, `ws/` modules |
| WASM crypto          | `pyde-crypto-wasm` polyrepo (`src/lib.rs`)                    |

Launch plan, hardening status, and the phased route to mainnet:
chapter 19 (Launch Strategy).

---

## N. Where the Numbers Came From

The key headline figures, with their sources:

| Claim                              | Source                                       |
| ---------------------------------- | -------------------------------------------- |
| ~150 ms DAG round period            | No constant — rounds advance on ≥ quorum distinct members (`consensus/src/round.rs`); the figure is documented on `Round` in `types/src/consensus.rs` |
| ~500 ms median commit          | `TARGET_WAVE_MS` in `types/src/consensus.rs`|
| v1 plaintext throughput target      | Awaiting multi-region performance harness measurement; publish only what the harness measures under sustained, production-realistic conditions ([companion/PERFORMANCE_HARNESS.md](../companion/PERFORMANCE_HARNESS.md)) |
| v1 commit-reveal mempool throughput  | Same harness; Commit + Reveal are two ordinary txs (no decryption stage) |
| 30 / 50 / 20 fee split              | `BURN_BPS` / `REWARD_POOL_BPS` in `tx/src/fee.rs`; treasury is the remainder |
| Capped shortfall emission (1%/yr ceiling) | `EMISSION_CAP_BPS` in `tx/src/distributor.rs` |
| 10,000 PYDE validator min stake     | `MIN_VALIDATOR_STAKE` in `tx/src/handlers/staking.rs` (single tier)|
| 3 max validators per operator       | `OPERATOR_CAP` in `tx/src/handlers/staking.rs` (anti-Sybil) |
| 30-day unbonding                    | `UNBONDING_PERIOD_WAVES` in `tx/src/handlers/staking.rs` |
| 16-slot nonce window                | `NONCE_WINDOW_SIZE` in `types/src/account.rs`  |
| 128 KB tx / 64 KB calldata caps     | `MAX_TX_SIZE`, `MAX_CALLDATA` in `tx/src/validation.rs`|
| 4 MB batch hard cap                 | `BATCH_MAX_BYTES` in `node/src/vertex_producer.rs` |
| WASM host function ABI v1.0         | `wasm-exec/src/host_fns/` + [companion/HOST_FN_ABI_SPEC.md](../companion/HOST_FN_ABI_SPEC.md) |
| wasmtime + Cranelift AOT            | Pinned wasmtime version in `Cargo.toml`         |
| Module cache capacity (1024 modules) | `DEFAULT_MAX_MODULES` in `wasm-exec/src/cache.rs` |
| Committee 128, threshold 86          | `COMMITTEE_SIZE`, `QUORUM` in `types/src/consensus.rs`|
| 86-of-128 beacon quorum             | `derive_beacon_combine_thresholds` in `node/src/validator.rs`, feeding `FalconBeaconScheme::with_threshold` in `consensus/src/beacon.rs` |

---

## O. License and Contribution

The Pyde codebase is licensed under Apache 2.0 (workspace-wide, in
`Cargo.toml`). Contributions go through the PR process at
`github.com/pyde-net/...`. Substantive protocol changes go through a PIP
first (see Chapter 15).

This book is part of the project repository. Corrections and additions
are welcomed via PR.

---

## End Notes

Pyde is what a base layer could have been from the start: fair ordering, honest finality, a node anyone can run, and verification that outlives the cryptography it was built with. Mainnet ships:

- **No elliptic curves**: FALCON-512, Kyber-768, Blake3, Poseidon2, lattice VRF.
- **Mysticeti-style consensus, no proposers**: each round every committee member produces a vertex; canonical order is structural.
- **Uniform Block-STM execution**: optimistic parallel exec + MVCC validation; access lists from `pyde_simulateTransaction` drive PIP-3 multiget prefetch into the dashmap cache, never partition the wave.
- **Keyless commit-reveal mempool**: opt in per-tx for MEV protection; no committee decryption key. Commit then reveal; inner txs execute in DAG commit order (Chapter 9). A one-shot ciphertext lane stays v2+ research (Chapter 20).
- **No tip mechanism**: fees are exactly `gas_used × base_fee`.
- **No on-chain stake-weighted vote**: governance is PIPs + on-chain multisig.
- **No bridge at v1**: `parachain_call!` surface reserved; parachain operator layer ships post-mainnet.
- **Structural MEV protection**: commit-reveal + structural ordering + no tips = unexpressible MEV.

Everything that doesn't ship at mainnet is tracked, scoped, and
prioritized for post-launch work. Honesty about what's in vs out is the
single biggest difference between this book and earlier drafts.

The next thing to read isn't a separate file; it's chapter 19
(Launch Strategy), where the phased work-in-flight to mainnet lives.
The [Companion Specifications](../SUMMARY.md) section of this book holds
the full technical specs (Whitepaper, Design, Threat Model, Performance
Harness, Parachain Design, Brand, and more).
