# Chapter 20: Appendix

Reference material from across the book in one place: the glossary, the
constants tables, the discriminator registry, the JSON-RPC method index,
and the post-mainnet roadmap.

---

## A. Glossary

| Term                 | Definition                                                                 |
| -------------------- | -------------------------------------------------------------------------- |
| **Pyde**             | The post-quantum L1 blockchain. Name of the protocol, the network, and the binary. |
| **PYDE**             | The native token. 1 PYDE = 10^9 quanta.                                     |
| **Otigen**           | Pyde's smart-contract language. Source files use `.oti`. Compiled by `otic`.|
| **otic**             | The Otigen compiler. Produces a JSON artifact (PVM bytecode + ABI).         |
| **PVM**              | Pyde Virtual Machine. Register-based, 32-bit fixed encoding, 62 opcodes.    |
| **AOT**              | Ahead-of-time compiler (Cranelift) that turns PVM bytecode into native code at deploy.|
| **JMT**              | Jellyfish Merkle Tree. The state commitment structure (radix-16, path-compressed). |
| **Blake3**           | Fast bitwise hash. Used for JMT internals, batch hashes, vertex hashes, gossip de-dup. |
| **Poseidon2**        | Algebraic hash over the Goldilocks field. State root commit, addresses, MAC, VRF, ZK-bearing paths. |
| **FALCON-512**       | NIST FIPS 206 post-quantum signature scheme. ~666-byte sigs, 897-byte pks.   |
| **Kyber-768**        | NIST FIPS 203 post-quantum KEM. P2P session keys and threshold mempool.    |
| **Threshold encryption** | Mempool encryption such that any 85 of 128 committee members combine to decrypt.|
| **PSS**              | Proactive Secret Sharing — refresh key shares without changing the public key.|
| **DKG**              | Distributed Key Generation. Pedersen DKG ceremony each epoch for threshold pubkey. |
| **VRF**              | Verifiable Random Function. Lattice-based; built from FALCON + Poseidon2.   |
| **Mysticeti**        | The DAG-based consensus protocol Pyde uses (post-May-2026 pivot, formerly HotStuff). |
| **DAG**              | Directed Acyclic Graph. Every round, each committee member produces a vertex; parents must be strictly prior rounds. |
| **Vertex**           | A committee member's per-round output: batch refs + parent refs + state-root sigs + decryption shares + FALCON sig. |
| **Round**            | A ~150 ms DAG cycle. Each member produces one vertex per round.            |
| **Wave**             | The Mysticeti commit unit. Anchor at round R+3 commits the subdag rooted at round R. |
| **Anchor**           | Deterministically-selected committee member whose round-R vertex commits the wave. `Hash(beacon, round, recent_state_root) mod 128`. |
| **Worker / Primary** | Narwhal pattern: workers gossip tx batches, primary produces vertices and runs consensus. |
| **HardFinalityCert** | ≥ 85 FALCON sigs over `(wave_id, blake3_state_root, poseidon2_state_root)`. |
| **Committee**        | The 128 active validators per epoch. Equal vote weight; uniform random selection. |
| **Epoch**            | ~3 hours of waves. PSS resharing fires at epoch boundary.                   |
| **Validator**        | Node staking PYDE; eligible for committee selection (tiered: 10M committee, 100K non-committee). |
| **Full node**        | Node that executes waves and serves RPC, but does not stake.                |
| **MEV**              | Maximal Extractable Value. The MEV class is structurally closed in Pyde.    |
| **Encrypted mempool**| Optional Kyber-encrypted submission. Decryption deferred until after DAG anchor commit. |
| **Commit-before-reveal**| DAG anchor commits canonical ordering before threshold-decryption shares are released. |
| **Hybrid scheduler** | Execution model: static access lists (Solana-style) + Block-STM speculation (Aptos-style). |
| **Sentry node**      | Public-facing proxy in front of a committee validator. Hides validator's real IP. |
| **Treasury**         | The system account at `Poseidon2("pyde-treasury")`. Spent via on-chain multisig.|
| **PIP**              | Pyde Improvement Proposal. Off-chain documents that drive code changes.     |
| **Multisig signers** | The on-chain set authorized to spend the treasury (`MULTISIG_SIGNERS`).     |
| **Emergency pause**  | Multisig-authorized halt of non-Resume txs; max 30 days, auto-expiring.     |
| **Hard halt**        | Automatic chain halt on detected safety violation (state root divergence, equivocation cluster). |
| **Weak-subjectivity checkpoint**| Hard-finalized wave commit (`wave_id` + `state_root` + committee FALCON sigs) that a fresh node trusts to anchor sync. |
| **Quanta**           | Smallest PYDE denomination. 1 PYDE = 10^9 quanta.                           |
| **Access list**      | Per-tx declaration of state slots the tx will read or write.                |
| **Nonce window**     | 16-slot bitmap of in-flight nonces per account.                              |
| **Gas tank**         | Per-account dedicated balance for sponsoring user transactions.              |
| **Paymaster**        | A contract that pays gas on behalf of a user, with custom validation logic. |
| **Parachain operator** | Permissionless v2 actor who stakes PYDE, fulfills `cross_call!` to other chains, earns gas fees. |

---

## B. Network Constants

| Constant                           | Value                          | Where                              |
| ---------------------------------- | ------------------------------ | ---------------------------------- |
| `ROUND_PERIOD_MS`                  | 150 (DAG round cadence)         | `consensus/round.rs`                |
| `WAVE_COMMIT_TARGET_MS`            | 500 (median wave commit)        | `consensus/wave.rs`                 |
| `EPOCH_LENGTH`                     | ~3 hours of waves               | `consensus/epoch.rs`                |
| `COMMITTEE_SIZE` (mainnet)         | 128                             | `consensus/committee.rs`            |
| `THRESHOLD` (2f+1)                 | 85                              | `consensus/quorum.rs`               |
| `EQUIVOCATION_THRESHOLD` (n-2f)    | 44                              | `consensus/quorum.rs`               |
| `RANDOMNESS_THRESHOLD`             | 85 (sorted before combine)     | `consensus/epoch_randomness.rs`     |
| `RESHARE_AGGREGATION_DELAY_WAVES`  | 5                               | `crypto/threshold.rs` / validator   |
| `MIN_COMMITTEE_STAKE`              | 10M PYDE                        | `slashing/lib.rs`                   |
| `MIN_NON_COMMITTEE_STAKE`          | 100K PYDE                       | `slashing/lib.rs`                   |
| `UNBONDING_PERIOD`                 | 30 days                          | `consensus/validator.rs`            |
| `FINDER_FEE_PERCENT`               | 10                              | `slashing/lib.rs`                   |
| `EVIDENCE_VERSION`                 | 1                               | `slashing/lib.rs`                   |
| `MULTISIG_VERSION`                 | 0x01                            | `tx/multisig.rs`                    |
| `MAX_MULTISIG_SIGNERS`             | 16                              | `tx/multisig.rs`                    |
| `MAX_PAUSE_DURATION_WAVES`         | ~30 days of waves               | `tx/pipeline.rs`                    |
| `MAX_BATCH_SIZE`                   | 4 MB                            | `mempool/batch.rs`                  |

## C. Gas / Fee Constants

| Constant                | Value                       | Where             |
| ----------------------- | --------------------------- | ----------------- |
| `GAS_TARGET`            | 400,000,000                  | `tx/fee.rs`        |
| `GAS_CEILING`           | 1,600,000,000 (4× target)    | `tx/fee.rs`        |
| `GENESIS_BASE_FEE`      | 50,000,000,000 quanta        | `tx/fee.rs`        |
| `MIN_BASE_FEE`          | 1                            | `tx/fee.rs`        |
| `ADJUSTMENT_DIVISOR`    | 8 (1/8 = 12.5% per block)    | `tx/fee.rs`        |
| `FEE_BURN_PCT`          | 70                           | `tx/execution.rs`  |
| `FEE_REWARD_POOL_PCT`   | 20                           | `tx/execution.rs`  |
| `FEE_TREASURY_PCT`      | 10                           | `tx/execution.rs`  |
| `MIN_GAS_LIMIT`         | 21,000                       | `tx/validation.rs` |
| `MAX_TX_SIZE`           | 128 KB                       | `tx/validation.rs` |
| `MAX_CALLDATA`          | 64 KB                        | `tx/validation.rs` |
| `WAVES_PER_YEAR`        | 63,113,904 (2/sec)           | `tx/fee.rs`        |
| `INFLATION_BPS`         | [500, 300, 200, 100]         | `tx/fee.rs`        |
| `GENESIS_SUPPLY`        | 10^18 quanta (1B PYDE)       | `tx/fee.rs`        |

## D. Mempool Constants

| Constant                                  | Value      | Where             |
| ----------------------------------------- | ---------- | ----------------- |
| `DEFAULT_MAX_TX_PER_WINDOW_PER_SENDER`    | 10         | `mempool/pool.rs`  |
| `DEFAULT_MAX_CONCURRENT_PER_SENDER`       | 100        | `mempool/pool.rs`  |
| `RATE_WINDOW_MS`                          | 1000       | `mempool/pool.rs`  |
| `WINDOW_SIZE` (nonce bitmap)              | 16         | `account/nonce.rs` |
| `MAX_RECEIPT_SLOTS`                       | 10,000     | `node/receipt_store.rs` |

## E. PVM Constants

| Constant         | Value      | Meaning                              |
| ---------------- | ---------- | ------------------------------------ |
| Total memory     | 0x400000 (4 MB) | Per-execution address space     |
| Page size        | 4 KB       | Allocation granularity               |
| `PAGE_ALLOC_GAS` | 200        | Gas per first-touch page             |
| `NULL_PAGE_END`  | 0x1000     | Reads/writes below this trap         |
| `CODE_START`     | 0x1000     | Bytecode load base                   |
| `CODE_END`       | 0x10000    | Max code size 60 KB                  |
| `HEAP_START`     | 0x10000    | Initial heap base                    |
| `STACK_TOP`      | 0x400000   | Initial stack top (exclusive)        |
| GP register count| 16 × 64-bit | `r0`–`r15`                           |
| Wide register count| 8 × 256-bit | `w0`–`w7`                          |
| Opcode count     | 62 of 64   | All slots assigned, 2 reserved       |

## F. Network / Discovery Constants

| Constant                       | Default       | Where             |
| ------------------------------ | ------------- | ----------------- |
| `DEFAULT_PORT`                 | 30303         | `net/config.rs`    |
| `DEFAULT_MAX_PEERS`            | 50            | `net/config.rs`    |
| `DEFAULT_MAX_INBOUND`          | 30            | `net/config.rs`    |
| `DEFAULT_MAX_OUTBOUND`         | 20            | `net/config.rs`    |
| `DEFAULT_RATE_LIMIT_PER_IP`    | 5 / sec       | `net/config.rs`    |
| `DEFAULT_IDLE_TIMEOUT`         | 60 s          | `net/config.rs`    |
| Gossipsub mesh_n               | 8             | `net/node.rs`      |
| Gossipsub heartbeat            | 150 ms (DAG round) | `net/node.rs` |
| `MAINNET_SEEDS`                | (set at launch)| `net/discovery.rs`|
| `TESTNET_SEEDS`                | (set at launch)| `net/discovery.rs`|
| `MAINNET_DNS_SEED`             | `seed.pyde.network` | `net/discovery.rs` |

---

## G. State Discriminators

Used in `Poseidon2(addr || discriminator || sub_key)` for storage keys.
Defined in `crates/state/src/keys.rs`.

| Discriminator | Name                      | Holds                                   |
| ------------- | ------------------------- | --------------------------------------- |
| 0x12          | `SUPPLY`                  | Total PYDE supply counter                |
| 0x13          | `TOTAL_BURNED`            | Cumulative fee burn counter              |
| 0x14          | `REWARDS_PER_VALIDATOR`   | Lazy-accrual block reward accumulator    |
| 0x15          | `ACTIVE_VALIDATOR_COUNT`  | Pool divisor (excludes exited / slashed) |
| 0x16          | `VESTING`                 | Per-account vesting schedule (40 bytes)  |
| 0x17          | `VALIDATOR_SUBSIDY`       | (total_amount, end_wave) streaming subsidy|
| 0x18          | `AIRDROP_ROOT`            | Genesis airdrop Merkle root              |
| 0x19          | `AIRDROP_DEADLINE`        | wave_id after which sweep is allowed     |
| 0x1A          | `AIRDROP_CLAIMED`         | Per-leaf-index claim bitmap              |
| 0x1B          | `AIRDROP_EXPECTED_SUM`    | Genesis pool size invariant              |
| 0x1C          | `MULTISIG_SIGNERS`        | Treasury multisig signer set (FALCON pks)|
| 0x1D          | `MULTISIG_THRESHOLD`      | Required signature count                  |
| 0x1E          | `MULTISIG_NONCE`          | Replay-protection counter for multisig   |
| 0x1F          | `EMERGENCY_PAUSE_END_WAVE`| End wave_id of an active emergency pause    |

---

## H. Transaction Type Registry

Defined in `crates/tx/src/types.rs`.

| ID  | Name              | Purpose                                                |
| --- | ----------------- | ------------------------------------------------------ |
| 0   | `Standard`        | Value transfer or contract call                         |
| 1   | `Deploy`          | Contract deployment                                     |
| 2   | `Batch`           | Multiple operations atomically (or best-effort)         |
| 3   | `StakeDeposit`    | Lock ≥ tier-min PYDE (10M committee / 100K non-committee), register validator|
| 4   | `StakeWithdraw`   | Begin 14-day unbonding                                  |
| 5   | `Slash`           | Submit double-sign evidence                             |
| 6   | `ClaimReward`     | Claim accrued staking yield from the pool               |
| 7   | `ClaimAirdrop`    | Claim genesis airdrop with Merkle proof                 |
| 8   | `SweepAirdrop`    | Move unclaimed airdrop residue to treasury (post-deadline)|
| 9   | `MultisigTx`      | Treasury spend with multisig signatures                  |
| 10  | `RotateMultisig`  | Rotate multisig signer set + threshold                   |
| 11  | `EmergencyPause`  | Halt block production (multisig-signed)                  |
| 12  | `EmergencyResume` | Resume normal processing                                  |

---

## I. PVM Opcode Registry

Defined in `crates/pvm/src/isa.rs`. Full table including gas costs is in
Chapter 3.

### Scalar arithmetic / logic

`Add` 0x01, `Sub` 0x02, `Mul` 0x03, `Div` 0x04, `Mod` 0x05, `And` 0x06,
`Or` 0x07, `Xor` 0x08, `Addi` 0x0E, `Not` 0x0F, `Shl` 0x14, `Shr` 0x15,
`Sar` 0x16, `Lt` 0x17, `Gt` 0x33, `Eq` 0x34, `Slt` 0x35, `Sgt` 0x36

### Wide arithmetic / logic

`Wadd` 0x09, `Wsub` 0x0A, `Wmul` 0x0B, `Wdiv` 0x0C, `Wmod` 0x0D,
`Wnot` 0x1F, `Wand` 0x2D, `Wor` 0x2E, `Wxor` 0x2F, `Wshift` 0x3A,
`Weq` 0x00, `Wlt` 0x3F

### Memory

`Load` 0x10, `Store` 0x11, `Push` 0x12, `Pop` 0x13, `Wload` 0x37,
`Wstore` 0x3B, `Wmov` 0x3C, `Narrow` 0x3D, `Widen` 0x3E, `Memcpy` 0x39

### Control flow

`Jmp` 0x18, `Beq` 0x19, `Bne` 0x1A, `Blt` 0x1B, `Bge` 0x1C, `Call` 0x1D,
`Ret` 0x1E

### Blockchain syscalls

`Sload` 0x20, `Sstore` 0x21, `Sdelete` 0x22, `Caller` 0x23, `Callvalue` 0x24,
`Blockhash` 0x25, `CallExt` 0x26, `Delegate` 0x27, `Create` 0x28,
`Selfdestruct` 0x29, `Log` 0x2A, `Revert` 0x2B, `Halt` 0x2C

### Crypto syscalls

`Poseidon` 0x30, `VerifySig` 0x31, `MerkleVerify` 0x32

### Misc

`Assert` 0x38

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
| `pyde_blockNumber`              | hex head wave_id                       |
| `pyde_gasPrice`                 | base fee (quanta)                      |
| `pyde_stateRoot`                | current state root                     |
| `pyde_syncing`                  | sync status object                     |
| `pyde_getValidators`            | validators with status + stake          |
| `pyde_getBlockByNumber`         | BlockHeader                            |
| `pyde_getBlockByHash`           | BlockHeader                            |
| `pyde_getTransactionReceipt`    | receipt with logs + fee breakdown       |
| `pyde_getLogs`                  | matching logs                          |
| `pyde_mempoolSize`              | pending tx count                        |
| `pyde_sendRawTransaction`       | tx hash                                |
| `pyde_sendTransaction`          | (dev only) tx hash                     |
| `pyde_sendEncryptedTransaction` | tx hash                                |
| `pyde_call`                     | hex return data                        |
| `pyde_estimateGas`              | gas estimate                           |
| `pyde_createAccessList`         | inferred access list                   |

WebSocket subscriptions: `pyde_subscribe` (block headers),
`pyde_subscribePending` (pending tx hashes), `pyde_subscribeLogs` (events).

---

## K. Cryptographic Primitives Summary

| Purpose                | Primitive                       | Sizes                             |
| ---------------------- | ------------------------------- | --------------------------------- |
| Digital signatures     | FALCON-512 (NIST FIPS 206)      | pk 897 B, sk 1281 B, sig ~666 B   |
| Key encapsulation      | Kyber-768 / ML-KEM (FIPS 203)   | pk 1184 B, sk seed 64 B, ct 1088 B|
| High-volume hashing    | Blake3                           | 256-bit output, ~3 GB/s native     |
| ZK-bearing hashing     | Poseidon2 over Goldilocks       | 256-bit output, ~400 constraints/hash|
| Threshold encryption   | Shamir SSS + Kyber + Poseidon2  | 85-of-128, ~250 B per share        |
| PSS resharing          | Lagrange interpolation over Goldilocks | preserves underlying secret       |
| DKG                    | Pedersen DKG over Kyber-768     | per-epoch threshold pubkey         |
| VRF                    | FALCON-proof + Poseidon2 output | inherits FALCON security           |
| Symmetric AEAD         | AES-256-GCM (hardware-accelerated)| 32-byte key, 16-byte tag          |
| Address                | `Poseidon2(falcon_pubkey)`       | 32 bytes                           |

No elliptic curves anywhere in the protocol.

---

## L. Post-Mainnet Roadmap

Items explicitly out of scope for the launch network, with the rough
priority each is tracked at:

| Item                                                      | Priority | Notes                                      |
| --------------------------------------------------------- | -------- | ------------------------------------------ |
| Persistent receipt store (archive-node mode)              | High     | Task 058. Needed for production explorers. |
| ML-KEM upgrade from 0.3.0-rc to stable                    | High     | Task 057. Once NIST stable releases.       |
| Algebraic batch FALCON verification                       | High     | Per-block verification cost reduction.      |
| Signed-mempool commitments + censorship slashing          | High     | Replaces local-view mandatory inclusion.    |
| Pedersen / KZG commitments for PSS resharing              | High     | Closes the malicious-contributor edge case. |
| Graceful drain-and-shutdown on persist failure            | Medium   | Task 014e. Operational polish.              |
| Two-dimensional gas (exec + prove)                        | Medium   | Depends on ZK proving landing.              |
| Off-chain Merkle builder CLI for airdrop ops              | Medium   | Operator tooling, ~150 LOC.                 |
| Mempool-level filter during emergency pause               | Low      | Cleaner than gate-check at admission.       |
| Sentry-node validator hiding                              | Low      | Operational pattern, not protocol.          |
| Sophisticated peer scoring                                | Medium   | Multi-topic + decay parameters.              |
| Fancy version-signaling on-chain                          | Low      | Currently out-of-band.                       |
| ZK validity proofs (STARK proving)                        | Research | Major redesign; restores prover economics.   |
| Native Ethereum bridge                                    | High     | FALCON-in-EVM verifier + Patricia in Otigen. |
| Native Bitcoin bridge                                     | Medium   | SPV-style proofs; PoW finality is probabilistic.|
| Parachain SDK (Rust / Go / C++)                            | Medium   | Sovereign chains sharing Pyde security.      |
| TypeScript SDK                                            | Medium   | WASM bridge available now; dedicated TS later.|
| Native browser wallet                                     | Low      | Ecosystem; WASM exposes primitives.          |
| Block-explorer frontend                                   | High     | Backend in Phase 7; UI is ecosystem.         |

The list is the project's tracked future work, not a commitment timeline.
Each item moves on PIP merit, audit capacity, and ecosystem demand.

---

## M. Key References in the Codebase

For readers diving into the source. All paths relative to the workspace
root.

| Subsystem            | Key files                                                    |
| -------------------- | ------------------------------------------------------------ |
| ISA + interpreter    | `crates/pvm/src/isa.rs`, `cpu.rs`, `memory.rs`                |
| AOT compiler         | `crates/aot/src/lib.rs`, `codegen.rs`, `host.rs`              |
| Crypto stack         | `crates/crypto/src/{falcon,kyber,poseidon2,threshold,vrf}.rs` |
| State commitment     | `crates/state/src/jmt_store.rs`, `witness.rs`, `keys.rs`      |
| Account record       | `crates/account/src/{types,address,nonce}.rs`                 |
| Slashing constants   | `crates/slashing/src/lib.rs`                                  |
| TX types + pipeline  | `crates/tx/src/{types,validation,pipeline,fee,execution}.rs`  |
| Multisig / governance| `crates/tx/src/multisig.rs`, `crates/tx/src/vesting.rs`        |
| Airdrop              | `crates/tx/src/airdrop.rs`                                    |
| Consensus            | `crates/consensus/src/{dag,vertex,wave,anchor,subdag,validator,finality,slashing,epoch_randomness,committee,quorum,round}.rs` |
| Networking           | `crates/net/src/{node,channels,auth,peer,ddos,discovery,config}.rs` |
| Mempool              | `crates/mempool/src/{pool,block_builder,inclusion,encrypted}.rs` |
| Node binary + RPC    | `crates/node/src/{main,cli,rpc,validator,consensus_store,receipt_store}.rs` |
| Otigen compiler      | `crates/otic/src/{lexer,parser,resolve,typecheck,safety,lower,optimize,codegen,abi}.rs` |
| Project dev CLI      | `crates/pyde-dev/src/{main,cli}.rs`                           |
| Rust SDK             | `crates/pyde-rust-sdk/src/{lib,client,wallet,contract,signer,abi,types,ws}.rs` |
| WASM crypto          | `crates/pyde-crypto-wasm/src/lib.rs`                          |

Mainnet plan, audit trail, and current task status: `MAINNET_PLAN.md` at
the repo root.

---

## N. Where the Numbers Came From

The key headline figures, with their sources:

| Claim                              | Source                                       |
| ---------------------------------- | -------------------------------------------- |
| ~150 ms DAG round period            | `ROUND_PERIOD_MS` in `consensus/round.rs`     |
| ~500 ms median wave commit          | `WAVE_COMMIT_TARGET_MS` in `consensus/wave.rs`|
| v1 plaintext TPS: 10-30K            | Performance harness measurement, "claim 1/3 of measured peak" rule (`docs/PERFORMANCE_HARNESS.md`) |
| v1 encrypted TPS: 0.5-2K             | Same harness; threshold-decryption serial cost |
| 70 / 20 / 10 fee split              | `FEE_BURN_PCT` etc in `tx/execution.rs`        |
| 5% → 1% inflation schedule          | `INFLATION_BPS` in `tx/fee.rs`                 |
| 10M PYDE committee min stake        | `MIN_COMMITTEE_STAKE` in `slashing/lib.rs`     |
| 100K PYDE non-committee min stake   | `MIN_NON_COMMITTEE_STAKE` in `slashing/lib.rs` |
| 14-day unbonding                    | `UNBONDING_PERIOD` in `consensus/validator.rs` |
| 16-slot nonce window                | `WINDOW_SIZE` in `account/nonce.rs`            |
| 128 KB tx / 64 KB calldata caps     | `MAX_TX_SIZE`, `MAX_CALLDATA` in `tx/validation.rs`|
| 4 MB batch hard cap                 | `MAX_BATCH_SIZE` in `mempool/batch.rs`          |
| 1 MB witness cap                    | `MAX_WITNESS_SIZE` in `state/witness.rs`       |
| 62 PVM opcodes                      | enum + gas table in `pvm/isa.rs`               |
| 16 GP + 8 wide registers            | `Cpu` in `pvm/cpu.rs`                          |
| 4 MB PVM address space              | `MEM_SIZE` in `pvm/memory.rs`                  |
| Committee 128, threshold 85          | `COMMITTEE_SIZE`, `THRESHOLD` in `consensus/quorum.rs`|
| 85-of-128 threshold for decryption  | `RANDOMNESS_THRESHOLD` (and equivalent for Kyber) |

---

## O. License and Contribution

The Pyde codebase is licensed under Apache 2.0 (workspace-wide, in
`Cargo.toml`). Contributions go through the PR process at
`github.com/zarah-s/...`. Substantive protocol changes go through a PIP
first (see Chapter 15).

This book is part of the project repository. Corrections and additions
are welcomed via PR.

---

## End Notes

Pyde is a sovereign post-quantum L1. Mainnet ships:

- **No elliptic curves** — FALCON-512, Kyber-768, Blake3, Poseidon2, lattice VRF.
- **DAG consensus, no proposers** — Mysticeti-style; each round every committee member produces a vertex; canonical order is structural.
- **Hybrid execution scheduler** — static access lists + Block-STM speculation.
- **Optional threshold encryption** — opt in per-tx for MEV protection; plaintext supported at lower cost.
- **No tip mechanism** — fees are exactly `gas_used × base_fee`.
- **No on-chain stake-weighted vote** — governance is PIPs + on-chain multisig.
- **No bridge at v1** — `cross_call!` macro stable; parachain operator layer ships post-mainnet.
- **Structural MEV protection** — commit-before-reveal + DAG ordering + no tips = unexpressible MEV.

Everything that doesn't ship at mainnet is tracked, scoped, and
prioritized for post-launch work. Honesty about what's in vs out is the
single biggest difference between this book and earlier drafts.

The next thing to read isn't a chapter — it's the `MAINNET_PLAN.md` in
the repo root, where the work-in-flight to launch lives, and the
`docs/` directory at the repo root for full technical specs.
