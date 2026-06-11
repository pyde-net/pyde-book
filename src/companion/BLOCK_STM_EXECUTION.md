# Pyde Block-STM Execution Layer

**Version 0.1**

How transactions in a committed wave execute on a validator. v1 mainnet ships parallel execution via a Block-STM scheduler — every wave's txs run optimistically in parallel, conflicts are detected via multi-version concurrency control, and the final state is deterministic across validators.

The wire protocol, gas semantics, and `commit_wave` interface are all unchanged from a hypothetical serial implementation. The parallelism lives entirely inside the executor crate; chain rules don't depend on it.

## Goals

1. **Parallel within a wave** — every tx in a wave runs concurrently on a `num_cpus`-wide rayon pool. Throughput scales with hardware.
2. **Deterministic final state** — every validator that applies the same `walked_subdag` produces the same JMT root + the same receipt set. Per-tx execution attempt order can differ across validators or across re-runs; only the committed final state has to match.
3. **Gas charged once** — speculative re-executions are free. Authors pay for the successful attempt only.
4. **Backwards-compatible interface** — `StateMutator::commit_wave(walked_subdag) -> WaveCommitInputs` is the only entry point. Switching between serial and parallel impls is a code-level swap, not a chain fork.
5. **Soft-list access hints** — wallets attach a `Tx.access_list` produced by `pyde_simulateTransaction` to enable partition-level parallelism. If state moved between simulate and execute, the MVCC layer catches divergence and re-executes; the tx still succeeds.

## Non-Goals

- **Speculative across waves.** Cross-wave reordering is out. Each wave's `walked_subdag` defines a strict canonical order; tx_index is the sole tiebreaker.
- **Strict trace determinism.** Re-runs do not have to produce identical per-tx attempt traces. Only the committed receipt + state root must match. Aptos / Sui made the same call.
- **Eliminating sequential commit semantics.** The conceptual model is still "execute these N txs in canonical order against the prior wave's state, produce a new state." Parallelism is a performance technique under that model, not a re-design of the consensus contract.

## Where it Lives

A new crate, `pyde-engine-parallel-exec`, depending on:

- `pyde-engine-state` (JMT, slot APIs, `StateMutator` trait)
- `pyde-engine-wasm-exec` (per-tx wasmtime adapter)
- `pyde-engine-types` (Tx, AccessList, WaveCommitInputs)
- `rayon` (work-stealing CPU pool)

The crate exposes one type:

```rust
pub struct BlockStmExecutor {
    pool: rayon::ThreadPool,
    // owned wasmtime Engine + per-thread Linker cache (see WASM ABI spec)
}

impl BlockStmExecutor {
    pub fn new(num_threads: usize) -> Self;
    pub fn execute_wave(
        &self,
        walked_subdag: &[Tx],
        prior_state: Arc<StateStore>,
    ) -> WaveCommitInputs;
}
```

Validators construct one `BlockStmExecutor` at boot and reuse it across every wave. The pool is sized to `num_cpus()` by default; `pyde validator --executor-threads N` overrides for benchmarks.

The serial fallback (`SerialExecutor`) is kept in `wasm-exec` as a differential-testing oracle. It's compiled in `cfg(test)` only.

## Core Data Structures

### MvccLayer

The multi-version store. Buffers every per-tx-attempt write; reads scan backwards from the calling tx's index for the most recent committed write.

```rust
pub struct MvccLayer {
    // Per-slot version history. BTreeMap key is (tx_index, attempt).
    // Reads at tx_index T scan for the largest key whose tx_index < T,
    // ignoring later attempts of the same earlier tx.
    versions: DashMap<SlotHash, BTreeMap<VersionKey, Value>>,
    // Genesis fallback — the JMT view at the start of the wave.
    base: Arc<StateStore>,
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct VersionKey {
    pub tx_index: u32,
    pub attempt: u32,
}

impl MvccLayer {
    /// Read the value at `slot` from the perspective of tx `at_index`.
    /// Returns the most recent committed write from any tx with
    /// `tx_index < at_index`; falls through to `base` if no in-wave write.
    pub fn read(&self, slot: SlotHash, at_index: u32) -> Option<Value>;

    /// Record a write by tx `(at_index, attempt)`.
    pub fn write(&self, slot: SlotHash, at_index: u32, attempt: u32, value: Value);

    /// Drop every write recorded by `(at_index, attempt)`. Called
    /// when the tx is aborted + re-incarnated at a higher attempt.
    pub fn invalidate(&self, at_index: u32, attempt: u32);

    /// Final wave-commit snapshot: for each slot, take the highest
    /// tx_index's last committed write. Flushes to the underlying JMT.
    pub fn finalize(self) -> JmtFlush;
}
```

`DashMap` for the outer map gives us lock-free contention on disjoint slots. The per-slot `BTreeMap` is wrapped in a fine-grained lock; reads and writes to the same slot serialize.

### AccessTracker

Per tx-attempt, the set of `(read_slot, observed_version)` and `(write_slot, value_hash)` pairs. Drives the validation pass.

```rust
pub struct AccessTracker {
    pub reads: Vec<(SlotHash, Option<VersionKey>)>,
    pub writes: Vec<SlotHash>,
}

impl AccessTracker {
    /// Returns true iff every observed_version in `reads` is still
    /// the most-recent-prior-version at the calling tx's index.
    pub fn validate(&self, layer: &MvccLayer, at_index: u32) -> bool;
}
```

`Option<VersionKey>` covers reads that fell through to the base JMT (no in-wave write at the time).

### Scheduler

The dispatch + retry loop. Holds the per-tx state machine and the next-up queues.

```rust
pub struct Scheduler {
    txs: Vec<TxState>,
    // FIFO of tx_index values ready to execute (next attempt).
    execute_queue: Mutex<VecDeque<u32>>,
    // FIFO of tx_index values whose latest attempt finished + needs validation.
    validate_queue: Mutex<VecDeque<u32>>,
    done_count: AtomicU32,
}

pub struct TxState {
    pub tx_index: u32,
    pub status: AtomicU8,   // Pending | Executing | Validating | Validated | Aborted
    pub attempt: AtomicU32,
    // Latest AccessTracker for this tx, written by the executor + read by the validator.
    pub tracker: ArcSwap<Option<AccessTracker>>,
}
```

The scheduler exposes `next_task() -> Task`:

```rust
pub enum Task {
    Execute { tx_index: u32, attempt: u32 },
    Validate { tx_index: u32, attempt: u32 },
    Done,
}
```

Workers pull from `execute_queue` first (fast path: txs flowing forward), then `validate_queue`. The pool exits when `done_count == N`.

## Algorithm

The wave's canonical order is the `walked_subdag`'s `included_txs`. tx_index assigned 0..N at the top of `execute_wave`.

### 1. Initial enqueue

Push every `tx_index ∈ 0..N` onto `execute_queue`. Initial state for each tx: `attempt = 0, status = Pending`.

### 2. Optimistic execute (rayon workers)

Each worker pulls a `Task::Execute { tx_index, attempt }` and runs:

```rust
let mut store = wasmtime::Store::new(&engine, MvccContext { layer, tx_index, attempt });
let mut tracker = AccessTracker::default();
let outcome = wasm_exec.execute(&mut store, &tx, &mut tracker)?;

// Writes already landed in MvccLayer via the host-fn shim during execute.
// `tracker` carries the read + write record.

scheduler.set_tracker(tx_index, attempt, tracker);
scheduler.transition(tx_index, Executing -> Validating);
scheduler.validate_queue.push_back(tx_index);
```

The wasmtime Store's `Data` is `MvccContext`. Every host-fn read/write goes through the MvccLayer at the calling `(tx_index, attempt)`. Host-fn semantics, gas costs, and FALCON-sig verification are unchanged from the existing wasm-exec adapter.

### 3. Validation (rayon workers)

Workers also pull `Task::Validate { tx_index, attempt }`:

```rust
let tracker = scheduler.tracker(tx_index, attempt);
if tracker.validate(&layer, tx_index) {
    scheduler.transition(tx_index, Validating -> Validated);
    scheduler.done_count.fetch_add(1, Ordering::AcqRel);
} else {
    // Conflict: a tx with lower tx_index wrote to a slot we read,
    // and our observed_version no longer matches.
    layer.invalidate(tx_index, attempt);
    scheduler.set_attempt(tx_index, attempt + 1);
    scheduler.transition(tx_index, Validating -> Pending);
    scheduler.execute_queue.push_back(tx_index);
}
```

A conflict re-incarnates the tx at `attempt + 1`. The OLD attempt's writes are dropped from the MvccLayer.

When `validate(tx_index)` finds a conflict, a CASCADE rule fires: every tx with `tx_index' > tx_index` whose `tracker.reads` includes any slot in this tx's write set must also re-validate. The cheap way to handle this: maintain a `dependents[tx_index]` map; when tx fails validation, mark its dependents `Validating -> Pending` (they'll re-execute against the new lower-version writes).

Aptos's published bound: O(N) re-executions in pathological cases. Real-world workloads typically reach fixpoint in 1-2 passes.

### 4. Finalize

When `done_count == N`:

- For every slot ever written, take the highest `tx_index`'s last write. That's the canonical value.
- Receipts are written in canonical tx_index order, using each tx's final-attempt events + return_data + gas_used.
- `MvccLayer::finalize()` flushes the canonical-value set to the JMT in one `StateCommitter::commit_batch` call.

## Access List from Simulate

### Wire format

`Tx.access_list: Vec<AccessListItem>` already exists in the types crate. v1 Block-STM gives it semantics:

```rust
pub struct AccessListItem {
    pub addr: Address,
    pub slots: Vec<SlotHash>,
    // mode: see below
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum AccessListMode {
    /// Use the list to partition for parallelism. If execution
    /// touches outside the list, MvccLayer catches it + re-runs.
    /// Tx still succeeds.
    Hint = 0,
    /// Touching outside the list reverts the tx. Forces simulate-
    /// then-submit close in time but gives the scheduler stronger
    /// guarantees. Reserved for v2; v1 always uses Hint.
    Strict = 1,
}
```

v1 mainnet ships `Hint` only. The `Strict` mode is reserved in the enum (1-byte field) so v2 can flip it on without a wire break.

### Soft-list partitioning

Before the optimistic-execute pass, the scheduler walks the wave once and builds an undirected conflict graph:

- Two txs conflict if their declared access lists overlap on any `(addr, slot)`.
- Run union-find to compute connected components.

Components run completely independently. Within a component, full Block-STM (with MVCC validation).

A tx with NO declared access list is treated as conflicting with every other tx in the wave — falls through to a single "everything" component. Wallets that want partition speedup must declare; wallets that don't pay the full Block-STM overhead.

### `pyde_simulateTransaction` RPC

Mirrors `eth_estimateGas` + `eth_createAccessList`. Wallet sends a dry-run tx:

```json
{
  "jsonrpc": "2.0",
  "method": "pyde_simulateTransaction",
  "params": ["0x<borsh-encoded tx hex>"]
}
```

Validator runs the tx against its current state in dry-run mode (no commit, no gas charge, FALCON sig optional). Returns:

```json
{
  "gas_used": "0x5208",
  "status": "Success",
  "return_data": "0x...",
  "access_list": [
    { "addr": "0x...", "slots": ["0x...", "0x..."] },
    ...
  ],
  "events": [ ... ]
}
```

The wallet attaches `access_list` to the real tx, signs, submits via `pyde_sendRawTransaction`. The validator that finalizes the wave uses the attached list for partitioning.

### Soft-list divergence

State can move between simulate-time and finalize-time. Three cases:

| Case | Behavior |
|---|---|
| Tx touched only slots in declared list | Component-isolated; fast path. |
| Tx touched a slot outside its declared list, no other tx in the wave wrote there | MvccLayer.read falls through to base state. Validation passes. No re-exec. |
| Tx touched a slot outside its declared list AND another tx in the wave wrote there | MvccLayer catches the conflict in validation. Re-exec at higher attempt with the new value. Tx succeeds. |

In every case the tx eventually commits its successful attempt. Bad declared lists waste re-execution work but don't fail txs.

## Gas + Receipts

- **Gas**: charged once, on the successful final attempt. Aborted attempt gas is discarded.
- **Receipts**: written in canonical `tx_index` order. Each receipt carries the final attempt's `gas_used`, `events`, `return_data`, and `status`.
- **Fee distribution**: per `HOST_FN_ABI_SPEC` §10.5 — the 70/20/10 burn/reward/treasury split is computed from `successful_attempts.sum(fee_paid)`. Aborted-attempt fees do not exist.

The "no refunds in v1" rule still holds. If a tx hits a tx-level revert (not an MVCC abort — those are silent retries), gas == `tx.gas_limit` and value transfer is rolled back. Only MVCC re-incarnations are free.

## Determinism Contract

Every validator that applies the same `walked_subdag` against the same prior state **MUST** produce:

1. The same JMT root after `MvccLayer::finalize()`.
2. The same set of receipts, in the same order, with identical `gas_used`, `events`, `return_data`, and `status` fields.
3. The same `WaveCommitInputs` returned from `execute_wave`.

What we do **NOT** require:

- Identical per-tx attempt count. Validator A might Block-STM-fixpoint in 1 pass; Validator B might take 3. Both produce the same final receipts.
- Identical per-tx attempt traces. Intermediate writes + dropped versions vary by thread interleaving.
- Identical timestamps on attempts. Wall-clock isn't part of the chain hash.

The contract is enforced by:

- **Property tests**: random tx mixes, random rayon pool sizes, identical seeds → identical finalized state.
- **Differential tests**: every wave runs both `BlockStmExecutor` and a `SerialExecutor` oracle; their outputs must match bit-for-bit.
- **Fuzzing**: AFL+ harness against `execute_wave` with mutated wave inputs.

Differential vs serial is the load-bearing check. Any divergence is a chain-fork bug; CI is configured to refuse merges when differential coverage drops.

## Cross-Contract Calls

When tx A calls X.foo() which dynamically calls Y.bar(), the discovered slot reads can exceed the attached access list. Behavior:

- The reads + writes still go through `MvccLayer` via the host fns — there is no separate code path.
- `AccessTracker` records every slot touched, regardless of whether it was in the declared list.
- Validation uses the recorded reads, not the declared list. So a tx that "exceeds" its declared list still validates correctly.
- The only consequence of exceeding the declared list is that the soft-list partitioning was over-optimistic: the tx may end up in a too-narrow component and MVCC catches divergence at execution.

`Strict` mode (reserved for v2) would revert in this case; v1 `Hint` mode just absorbs the cost.

## State-Holding Host Functions

The host fns that read or write chain state — `sload`, `sstore`, `sdelete`, `balance`, `code_size`, `code_hash`, `block_*` (frozen), etc. — all route through `MvccLayer` in the parallel executor. Pure host fns (Blake3, FALCON verify, etc.) don't touch state and are unaffected.

The `wasm-exec` adapter exposes a `HostFnBackend` trait:

```rust
pub trait HostFnBackend: Send + Sync {
    fn sload(&self, addr: &Address, slot: &SlotHash) -> Option<Value>;
    fn sstore(&self, addr: &Address, slot: &SlotHash, value: Value);
    fn sdelete(&self, addr: &Address, slot: &SlotHash);
    fn balance(&self, addr: &Address) -> Balance;
    // ...
}
```

`SerialExecutor` implements `HostFnBackend` directly against `AccountStore`. `BlockStmExecutor`'s `MvccContext` implements it against `MvccLayer` at the calling `(tx_index, attempt)`.

The wasmtime Store's `Data` carries the backend, so no host-fn body changes.

## Implementation Phases

Roughly 8 weeks of focused effort.

### Phase A — Spec lock (week 1)

This document. Determinism contract, MVCC API, scheduler state machine, RPC shape. No code.

### Phase B — Skeleton + MVCC (weeks 2-3)

- New crate `pyde-engine-parallel-exec`.
- `MvccLayer` with serial single-thread access. Unit tests for read-back-through-versions, finalize, invalidate.
- `HostFnBackend` trait extracted from `wasm-exec`. `SerialExecutor` adapted to implement it.
- `SerialExecutor::execute_wave` wired through `StateMutator::commit_wave` — behavior unchanged from today.

Gate to next phase: differential test passes (serial via new path == serial via old path, byte-for-byte).

### Phase C — Parallel scheduler (weeks 4-5)

- Add rayon dependency.
- `Scheduler` + `Task` types.
- Execute → validate → retry loop.
- `BlockStmExecutor::execute_wave` swapped in behind a feature flag.

Gate: differential test passes (parallel == serial across 10⁵ random waves).

### Phase D — Soft access list + simulate RPC (week 6)

- Component partitioning via union-find on declared access lists.
- `pyde_simulateTransaction` RPC handler.
- Wallet-side helper in `pyde stake` (and reused by Otigen's send-tx path).

Gate: soft-list partitioned waves measurably faster than no-list waves on a benchmark with declared txs (target: 2x on a 4-component wave).

### Phase E — Determinism testing (weeks 7-8)

- Property tests with proptest: random tx mixes, random pool sizes, identical final state.
- AFL+ fuzz harness against `execute_wave`.
- Soak: 24h continuous waves on a 4-validator cluster with random tx mixes; zero state-root divergence required.

Gate: 24h soak clean.

### Phase F — Production swap (week 8+)

Remove the feature flag. `BlockStmExecutor` becomes the default in `pyde validator`. `SerialExecutor` stays compiled `cfg(test)` only, used by the differential test infrastructure.

## Open Questions

1. **Worker pool sizing**. Default to `num_cpus()`? Halve it on a host that's also running a libp2p stack? Probably default to `num_cpus / 2` with an explicit `--executor-threads N` override.
2. **Failed-tx retention**. Block-STM aborts re-incarnate the tx but a hard revert (`HandlerError::*`) terminates it. Does the receipt record the abort attempts? No — only the final terminal attempt. Aborts are internal.
3. **Memory pressure**. For a 50K-tx wave with high-conflict txs, MVCC could hold tens of thousands of `(tx_index, attempt)` versions per slot. Need an eviction policy or hard cap. Probably: cap attempts per tx at 8; on the 9th, fall back to serial-execute-after-all-prior-committed for that tx. Pathological but bounded.
4. **Determinism under wasmtime fuel exhaustion**. If a tx runs out of fuel mid-execute, the partial writes are dropped (already the case in serial). Block-STM treats it the same as an explicit revert: receipt with `gas_used = gas_limit`, no state changes, no re-incarnation.
5. **Performance target**. v1 mainnet aspirational throughput is 10–30K plaintext TPS on commodity hardware. Block-STM should hit this with ~80% efficiency vs perfect linear scaling. Anything below 70% means the conflict rate is too high in practice; we'll need to tune partition heuristics.

## Versioning + Upgrade

Block-STM ships in v1 mainnet. The `commit_wave` interface is stable; v2 changes will be inside `BlockStmExecutor` and won't affect the chain hash.

Validators can run a mix of v1 and v1.x point-releases without forking — `MvccLayer::finalize()` outputs are deterministic regardless of pool size, scheduler heuristics, or partition algorithm. The differential test infrastructure stays in `cfg(test)` permanently as a regression guard.

The reserved `AccessListMode::Strict` flag in the wire format lets v2 introduce strict access lists without a wire break, if real-world data shows the soft-list approach hits a wall on partitioning efficiency.
