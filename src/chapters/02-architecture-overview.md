# Architecture Overview

## System Architecture

Pyde is a monolithic Layer 1 — consensus, execution, and state in a single binary. Validators and full nodes run the same `pyde` process; role differentiation is configuration (whether the node stakes, whether it joins the active committee, whether it serves RPC).

```
┌─────────────────────────────────────────────┐
│ Application Layer                           │
│ WASM smart contracts, dApps, wallets, RPC   │
├─────────────────────────────────────────────┤
│ Execution Layer                             │
│ WebAssembly (wasmtime + Cranelift AOT),     │
│ Block-STM scheduler, MVCC, access-list      │
│ prefetch                                    │
├─────────────────────────────────────────────┤
│ State Layer                                 │
│ Jellyfish Merkle Tree (JMT), dual-hash      │
│ Blake3 + Poseidon2 per node, PIP-2 clusters │
├─────────────────────────────────────────────┤
│ Consensus Layer                             │
│ Mysticeti DAG, anchor selection, finality   │
├─────────────────────────────────────────────┤
│ Cryptography Layer                          │
│ FALCON-512, Kyber-768 threshold, DKG        │
├─────────────────────────────────────────────┤
│ Network Layer                               │
│ libp2p + QUIC, Gossipsub, worker/primary    │
└─────────────────────────────────────────────┘
```

## Worker / Primary Split (Narwhal Pattern)

Within each validator, the consensus role is split:

- **Workers (N processes per validator):** handle transaction ingress, build batches of incoming transactions, gossip batches peer-to-peer with other validators' workers
- **Primary (one process per validator):** handles consensus — produces vertices each round, gathers parent references, signs state roots

This separation decouples high-volume data dissemination from low-volume consensus structure. Transactions travel the network exactly once (via worker gossip); consensus vertices stay tiny (carry only batch hashes by reference).

```
┌────────────────────────────────────────────────────┐
│ Validator Process                                  │
│                                                    │
│  ┌──────────────┐    ┌──────────────────────────┐ │
│  │   Workers    │    │       Primary            │ │
│  │  (1 or more) │◄───┤  - Produces vertices     │ │
│  │              │    │  - Tracks DAG            │ │
│  │ - Tx ingress │    │  - Signs state roots     │ │
│  │ - Build      │    │  - Runs DKG ceremonies   │ │
│  │   batches    │    │  - Executes WASM         │ │
│  │ - Gossip     │    └──────────────────────────┘ │
│  │   batches    │                                  │
│  └──────────────┘                                  │
└────────────────────────────────────────────────────┘
```

Workers can be scaled independently of the primary. A validator with high incoming traffic can run 4-8 workers; a quieter validator can run 1.

## Consensus: Mysticeti DAG

Pyde's consensus is a Mysticeti-style DAG protocol. Every round (~150ms), each committee member's primary produces exactly one vertex. The vertex contains:

- Batch hashes (data layer references)
- 85+ parent vertex hashes (consensus structure, from prior round)
- State root signatures (attestations on recent commits)
- Anchor attestation (prior round's anchor vertex hash)
- Decryption shares (piggybacked partial decryptions)
- FALCON signature

Vertices form a Directed Acyclic Graph: parents must be strictly from prior rounds. This is purely a consensus structure; transaction data lives in batches referenced by hash.

Each round has a deterministically-selected **anchor**:
```
anchor_member = Hash(beacon, round, prev_state_root) mod 128
```

When the anchor vertex collects sufficient support from later rounds (Mysticeti 3-stage support), a commit fires. ~95% of rounds commit successfully; ~5% skip (next round absorbs the skip).

End-to-end commit latency: **~500ms median**.

## Execution: WebAssembly + Block-STM

After consensus commits a wave (canonical ordered transactions), the execution layer:

1. **Threshold decryption** for encrypted transactions (≥85 partials combined per tx)
2. **Access-list prefetch** — one batched `state_cf.multi_get` (PIP-3) over the union of every tx's declared `(addr, slot)` pairs lands warm values in the dashmap (PIP-4) before workers start. The lists are hints only; they never partition the wave or affect correctness.
3. **Block-STM scheduler** runs every tx in parallel on a `rayon` pool: optimistic execute against an MVCC layer + validate against canonical tx_index order + cascade-invalidate + re-incarnate on conflict + fixpoint. Final state per slot is the highest-tx_index's last write. Full algorithm in [companion/BLOCK_STM_EXECUTION.md](../companion/BLOCK_STM_EXECUTION.md).
4. **wasmtime executes** each tx with Cranelift AOT and fuel-based gas metering. Smart contracts compile from Rust, AssemblyScript, Go, or C/C++ to WASM.
5. **State root computed** — dual-hash (Blake3 + Poseidon2) per JMT node
6. **Committee FALCON-signs state root** (piggybacked on next vertices)
7. **Finality** when ≥85 state root signatures collected

## State: Jellyfish Merkle Tree

Account state and contract storage are stored in a **Jellyfish Merkle Tree (JMT)** — radix-16, path-compressed. Compared to a fixed-depth-256 Sparse Merkle Tree:

- ~5-10 nodes touched per state operation (vs ~256)
- Substantial I/O savings at high TPS
- Same authentication properties (Merkle commitment, inclusion / exclusion proofs)
- Production-proven (Diem, Aptos)

State commitment is dual-rooted:
- **Blake3 root:** fast native verification (committee + validators)
- **Poseidon2 root:** ZK-circuit-friendly (future light clients, validity proofs)

## Cryptography Layer

Three primitives form the cryptographic foundation:

### FALCON-512 (Signatures)
NIST FIPS 206 standard. Used for: user tx authorization, vertex production, state root attestations, decryption share authentication. 666-byte signature, ~80μs verification.

### Kyber-768 Threshold (Encryption)
NIST FIPS 203 standard with threshold variant. Per-epoch public key from DKG; ≥85 partials decrypt any ciphertext. Enables encrypted-mempool MEV resistance.

### Poseidon2 + Blake3 (Hashing)
Hybrid layered: Blake3 for high-volume native paths (JMT internals), Poseidon2 for ZK-bearing paths (state root commitment exposed to future ZK proofs, address derivation, FALCON sig hashing inside ZK circuits).

## Network Layer

- **Transport:** QUIC over UDP (no HOL blocking, TLS 1.3 built-in, mature in Rust via quinn). TCP fallback.
- **P2P library:** libp2p (Rust) — mature, audited, used by Ethereum/Filecoin/Polkadot
- **Peer discovery:** layered (hardcoded → DNS → on-chain validator registry → PEX → cache). No DHT.
- **Gossip:** Gossipsub with per-topic meshes
- **DoS protection:** 4-layer (connection / message / peer-scoring / application)
- **Committee defense:** sentry node pattern (Cosmos-style)

Committee NIC requirement at v1's honest throughput target (to be established by the multi-region performance harness) is **≥500 Mbps**. Higher-throughput regimes are post-mainnet scaling work; the v1 target is what mainnet hardware is sized against.

## Account Model

Accounts hold:
- nonce (8 bytes)
- balance (16 bytes, u128)
- gas_tank (16 bytes — pre-deposited gas for encrypted submission)
- auth_keys (variable: Single | Multisig | Programmable)
- code_hash (32 bytes, for contracts)
- storage_root (32 bytes, JMT subtree for contract storage)
- key_nonce (4 bytes, FALCON key rotation counter)

**Native multisig** at v1 — `AuthKeys::Multisig(M, [pubkey_1, ..., pubkey_N])` with max 16 signers. Better than Gnosis Safe contract-multisig (Ethereum), which reimplements the same logic with subtle bugs across projects.

**Programmable accounts** and **session keys** ship post-mainnet. v1 reserves the `Programmable` enum variant so contracts written today survive the upgrade without rewriting.

**16-slot nonce window** — accounts can have up to 16 transactions in-flight out-of-order within the window. Decouples user-level submission from consensus-level execution ordering.

## Transaction Lifecycle

```
1. Wallet constructs tx
2. Wallet → RPC: pyde_estimateAccess(tx) → returns gas_estimate + access_list
3. Wallet attaches access_list to tx
4. Wallet FALCON-signs tx hash
5. (Optional) Wallet encrypts signed_tx + access_list with epoch Kyber PK
6. Wallet submits: pyde_sendRawTransaction or pyde_sendRawEncryptedTransaction
7. RPC node validates wire format, forwards to nearest worker
8. Worker (plaintext) verifies sig, batches, gossips
9. Primary produces vertex, gossips
10. Commit fires (Mysticeti, sub-second target): anchor selected, subdag walked, canonical order emitted
11. (Encrypted) threshold decryption ceremony per encrypted tx (batches contain a mix of plaintext + encrypted txs)
12. wasmtime executes WASM modules in canonical order
13. JMT updates (dual-hash per node), state root signed
14. Finality declared (≥85 state root sigs)
```

## Cross-Chain (Post-Mainnet)

Cross-chain interactions happen through a permissionless **parachain layer** — operators implement a Pyde-published specification, stake PYDE, follow protocol rules, and earn gas fees from contracts that call them via the `cross_call!` macro.

The protocol-level surface (`cross_call!` macro, `HardFinalityCert` primitive, unified gas model) is settled at v1 genesis. The actual parachain layer ships post-mainnet.

## Three-Tier Node Model

| Tier | Stake | Committee Role | Earns |
|---|---|---|---|
| Committee validator | ≥10K PYDE (single-tier min) | Active (1 of 128) | Activity rewards + pool yield + inflation |
| Non-committee validator | ≥10K PYDE (single-tier min — same floor) | Stake-only, waiting selection | Pool yield + inflation |
| RPC node | None | None | Off-chain RPC fees (market-set) |

RPC providers (Infura/Alchemy analog) fit Tier 3 — no stake, no slashing risk.

## Key Differentiators

| | Ethereum | Solana | Sui | **Pyde** |
|---|---|---|---|---|
| Post-Quantum | Migration 5+ years | No plan | No plan | **Default at genesis** |
| MEV resistance | Auction (PBS) | Proposer extracts | Some via Mysticeti | **Structurally impossible** |
| Finality | 12-15s | 400ms | 390ms | **~500ms** |
| Commodity validator | Possible | No (12+ cores) | No (datacenter) | **Yes (any validator awaiting committee selection)** |
| Smart contract language | Solidity | Rust/Anchor | Move | **Any wasm32 target** (Rust, AssemblyScript, Go, C/C++) |
| Account abstraction | Retrofit (ERC-4337) | None native | Limited | **Native (v2)** |
| Cross-chain | Bridges ($3B+ hacked) | Bridges | Bridges | **Permissionless parachain (v2)** |
| ZK readiness | Retrofit ongoing | Limited | Limited | **Architecture ready (v2)** |

## Next Chapters

- Chapter 3: Execution Layer — wasmtime runtime, host function ABI, Cranelift AOT, fuel-based gas, determinism boundary
- Chapter 4: State Model — JMT details, dual-hash strategy, PIP-2 clustering
- Chapter 5: Otigen Toolchain — the developer-facing binary (build, deploy, wallet, ABI extraction, per-language attribute declaration)
- Chapter 6: Consensus — full Mysticeti DAG specification
- Chapter 7: State Sync & Chain Halt — operational protocols
- Chapter 8: Cryptography — FALCON, Kyber, Poseidon2, DKG, threshold details
- Chapter 9: MEV Protection — threshold encryption + commit-before-reveal architecture
