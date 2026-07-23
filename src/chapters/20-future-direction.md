# Chapter 20: Future Direction

This chapter is the post-v1 capability plan: what's deliberately
deferred, why, what changes for users when each lands, and the
reservations v1 makes so future work doesn't require breaking changes.

The discipline is simple: **v1 ships interfaces, v2 ships
implementations**. Where a capability needs an on-chain hook to land
cleanly later, v1 reserves the hook now (a tag byte, a struct field, a
host-fn slot) so the future change is additive, not a hard fork of
fundamentals. Where a capability is purely additive (new RPC, new SDK,
new client tooling), no reservation is needed.

No calendar commitments. Items move on PIP merit, audit capacity, and
ecosystem demand. The
[Post-Mainnet Plan](21-appendix.md#l-post-mainnet-plan) in the
appendix is the priority-sorted index; this chapter is the prose behind
it.

---

## 20.1 Accounts and User Experience

The v1 account model is intentionally minimal: an address holds either
an EOA (FALCON-512 keypair) or a contract. The reservations below let
the model grow toward smart-account ergonomics without ever rotating
the address shape, the auth-key encoding, or the multisig pipeline.

### 20.1.1 Programmable Accounts

What it is. An account whose authorization logic is itself a WASM
contract, not a fixed-pubkey check. The auth contract decides whether
a tx is authorized to spend from the account. Same shape as
ERC-4337 / EIP-7702 in EVM-land, redesigned native.

Why deferred. The cost is high: every tx becomes a contract call for
auth verification, the auth-contract has to be a deterministic
subset of the full WASM ABI, and the simulation-vs-execution gap that
trips up EVM account-abstraction needs to be carefully closed. None of
that is hard; all of it takes audit cycles.

What v1 reserves. The `AuthKeys` enum carries a `Programmable` variant
(tag `0x03`) that's defined in the wire format but rejected at
admission today. Account records carry a `policy_mode` flag with one
allowed value (`Static`); future `Programmable` accounts flip to the
contract-driven path. The address shape is unchanged.

What changes when it ships. Wallet UX gains paymasters, multi-call
authorization, social recovery, conditional spending. Encrypted-lane
support arrives in lockstep with the programmable account.

### 20.1.2 Session Keys

What it is. A short-lived keypair the account authorizes to act within
a tight scope, bounded by which contracts it can call, which methods
within those contracts, a spending cap, and an expiry. Revocable at
any time. Designed for the dApp pattern where a user signs once and
plays for an hour without re-authorizing every tx.

Why deferred. Session keys are only safe inside programmable accounts.
A static FALCON pubkey with side keys would require either a new
chain-level scope-enforcement engine (duplicate work) or trusting
clients to enforce scope (worthless). Pair them with §20.1.1.

What v1 reserves. The `AuthKeys::Programmable` tag (above) is the
single chokepoint that gates this feature.

### 20.1.3 Native Multisig

What it is. A first-class multisig account where the signature
threshold and signer set are stored on-chain and the chain itself
checks the M-of-N condition: no contract wrapper, no
deploy-a-multisig-per-team friction.

Why deferred. v1 currently routes multisig via the `MultisigTx`
transaction type, which is operational but not ergonomic: there's no
named account, no balance-of-multisig query, no auto-aggregation of
partial signatures. The v2 design uses the same on-chain pipeline,
just exposed through a real account type.

What v1 reserves. `MultisigTx` is already canonical; the v2 account
type is a wrapper over the same pipeline. No wire-format change.

### 20.1.4 Sponsored Transactions

What it is. A pattern where a paymaster account picks up the gas bill
for a user's transaction, letting new users transact without holding
PYDE first. dApps subsidize their own onboarding; protocol-level fee
markets keep abuse bounded.

Why deferred. Sponsored txs require programmable accounts (the
paymaster needs to enforce its own policy: "only sponsor calls to
contract X up to budget Y") and a tx-envelope extension where the
paymaster's signature is a peer of the sender's. Both depend on
§20.1.1.

What v1 reserves. The fee-payer field on `Tx` is already an explicit
`FeePayer` enum (today only `Sender`); future variants `Paymaster(addr)`
and `Sponsored(addr, sig)` slot in without breaking the wire shape.

### 20.1.5 AI-Assisted Wallet Previews

What it is. The wallet shows the user not just "you're approving
contract X to spend Y PYDE" but the downstream consequences: "this
also grants method Z permissions to contract W for the next 30 days,"
or "this matches the drainer pattern seen in the last 200 phishing
incidents."

Why deferred. v1 ships the foundation: every wallet can run a local
WASM simulation of the tx and show the immediate state changes. The
heuristic + LLM layers are additive client-side work; they don't need
chain hooks.

What v1 reserves. Nothing. This is pure client-side innovation that
gets better with ecosystem maturity. The wallet SDK already exposes
the simulation primitives.

### 20.1.6 ENS-Style Name Extensions

What it is. Subdomains, name TTLs, off-chain text records, reverse
lookups, multi-tier registry governance. Reaches feature parity with
the most mature naming systems in the ecosystem.

Why deferred. v1 ships the core: 32-byte addresses, contracts and
parachains use ENS-style unique names, the registry uniqueness check
prevents collisions. The fancy bits (subdomains, TTLs) are additive
on top of the existing registry.

What v1 reserves. The name registry uses a versioned record format;
future extensions add fields without rotating the address shape or
breaking existing resolution.

---

## 20.2 Cryptography

Three families of work: tightening existing primitives, adding
zero-knowledge proofs, and the open research direction that would let
the private mempool offer one-shot ciphertext UX without giving up its
trustless, keyless guarantee.

### 20.2.1 Algebraic Batch FALCON Verification

What it is. A signature scheme that lets a verifier check N FALCON
signatures in time substantially less than N individual verifications
(typically O(log N) or O(N / k)) using algebraic identities over the
underlying lattice ring.

Why deferred. The cryptographic construction is published; the
engineering cost is reimplementing the FALCON verifier with batch
math and re-auditing it. Worth doing once aggregation savings start to
matter (high-throughput, high-N committees).

What it brings. Per-wave signature-verification cost drops sharply.
Most useful for the wave-commit FALCON-cert path and the per-vertex
producer signature.

### 20.2.2 ZK Validity Proofs

What it is. Zero-knowledge proofs (STARK or SNARK) attesting that a
wave's state transition is correct, without re-executing the wave.
Light clients verify a small proof instead of replaying transactions.

Why deferred. Pyde's primitive choice is already ZK-friendly
(Poseidon2 for state root, Goldilocks field, JMT structure). The
proving system itself is research-grade work: months of design,
implementation, and audit. The economics also need rethinking: who
runs the prover, how proving cost is priced, how the chain handles
prover failure.

What v1 reserves. The state root is already Poseidon2 (provable
cheaply). The state model is already a Merkle structure (JMT). No wire
change needed when ZK lands; proofs become a new RPC and a new vertex
field.

### 20.2.3 Threshold-LWE One-Shot Private Mempool

What it is. A lattice-based (LWE / threshold ML-KEM) threshold
encryption scheme that would let a user submit a **single ciphertext
transaction** (encrypted to a validator-committee key, decrypted only
after the DAG has fixed its order) instead of the two-phase
commit-then-reveal flow v1 ships. Same front-running guarantee
(ordering locked before contents are visible), but **one-shot**: no
second reveal transaction, and the sender's address can be hidden too,
not just the payload.

Why it is future, not v1. This is the "encrypted mempool" the original
design attempted and v1 deliberately does **not** ship. Making it
trustless requires a *distributed* threshold key with no trusted
dealer, and post-quantum threshold keygen is an open research problem:
lattice public keys do not combine homomorphically the way BLS keys
do, so there is no clean DKG that yields a shared threshold ML-KEM/LWE
key without either a trusted setup or an unproven construction. v1's
keyless [commit-reveal private mempool](./09-mev-protection.md) exists
precisely because it needs none of this (no committee key, nothing to
collude over, nothing to reconstruct) and delivers the same ordering
guarantee today.

What it would add, and its cost. One-shot UX and sender-metadata
hiding, offered as an **optional** lane *alongside* the keyless
commit-reveal default, never replacing it. The trade is explicit: a user who
chooses the ciphertext lane accepts a `t`-of-`n` honest-committee
assumption (the committee *can* decrypt early if it colludes), whereas
commit-reveal is unconditional. The trustless, keyless path stays the
default; the ciphertext lane is convenience for those who want it.

Status. Research-gated. Blocked on a practical trustless post-quantum
threshold-keygen primitive (or a deliberate decision to accept a
one-time trusted-setup ceremony). Not a near-term item; tracked here so
the door to one-shot private-tx UX stays explicit if and when the
primitive matures. Adjacent operational work, namely following the
NIST FIPS 203 (ML-KEM) reference crate from its release-candidate to
its stable release, only becomes relevant if this lane is built.

---

## 20.3 Execution and Performance

The v1 execution layer is uniform Block-STM. Beyond v1, the scaling
story is layered: each layer is additive, gated on measurement, and
non-breaking for contract authors. The Block-STM core ABI doesn't
change.

### 20.3.1 Block-STM Scaling Layers

Each layer is independent; ship in the order that the measurements
justify.

| Layer | What it does | Expected gain on its workload |
|-------|--------------|--------------------------------|
| L1: Access-list scheduling fast path | Use declared access lists to schedule conflict-free tx batches in parallel without MVCC overhead | 1.5 to 3× on access-list-heavy workloads |
| L2: Pipelined execution + consensus | Overlap wave N+1 execution with wave N consensus | ~2× |
| L3: Read-write set classification | Pre-classify txs as read-only / write-only / read-modify-write; run read-only path in parallel without conflict tracking | 2 to 5× |
| L4: GPU acceleration for PQ crypto | FALCON verify + Kyber decapsulate on GPU; encrypted-lane txs benefit most | 5 to 10× on encrypted-heavy workloads |
| L5: Native precompiles for hot patterns | Skip WASM execution entirely for common patterns (transfers, well-known token standards) | 10× on the specific patterns |
| L6: Execution sharding | Partition the wave across executor pools; merge state changes deterministically | Linear in shard count |
| L7: Chain sharding | Multi-chain state, cross-shard txs, post-mainnet whole-chain rewrite | Linear in shard count, with cross-shard overhead |

**Not planned.** Object-centric models (Sui-style) are
structurally incompatible with Pyde's slot-keyed `sstore(slot, value)`
model and would require breaking the host-function ABI. The decision
to stay slot-keyed is intentional and locked.

### 20.3.2 Two-Dimensional Gas

What it is. Gas accounts for two dimensions: execution cost (the v1
metric) and proving cost (when ZK validity proofs land). Some opcodes
are cheap to execute but expensive to prove; a fair pricing model
needs both dimensions.

Why deferred. Depends on ZK proving (§20.2.2) being far enough along
to measure proving cost per opcode.

What v1 reserves. The gas accounting structure carries a single
dimension today; the receipt format leaves room for the second
without breaking older readers.

### 20.3.3 Persistent Receipt Store (Archive-Node Mode)

What it is. A separate node mode that retains every receipt forever,
not just within the active state-sync window. Production block
explorers and analytics services run on archive nodes.

Why deferred. Validator nodes don't need archived receipts; the
explorer / indexer use case is operationally distinct. Engineering
effort tracked for the storage layout, the snapshot inclusion path,
and the operator runbook.

### 20.3.4 State Expiration

What it is. A protocol-level mechanism where state slots not accessed
in N epochs become "expired": their data is purged from active state
but provable from archives. Reactivation requires submitting a proof.

Why deferred. The economics are research-grade. v1's state model is
JMT with full retention; expiration overlays without breaking that.

What v1 reserves. The slot-key shape and JMT structure are both
expiration-compatible without protocol changes.

---

## 20.4 Cross-Chain

### 20.4.1 Native Ethereum Bridge

What it is. A trust-minimized bridge between Pyde and Ethereum: a
FALCON-in-EVM verifier contract on Ethereum (or a wrapper using the
existing pairing-based aggregation), plus a Patricia-tree verifier on
Pyde as a WASM contract that validates Ethereum state.

Why deferred. The verifier contracts are non-trivial, particularly
the FALCON-in-EVM side, which needs careful gas-cost analysis.
Bridges are the most-attacked surface in DeFi; getting this right is
audit-heavy.

What it brings. Native token bridging without trusted custodians.
Pyde dApps gain reach into the largest existing user base.

### 20.4.2 Native Bitcoin Bridge

What it is. SPV-style bridge: Pyde validates Bitcoin block headers and
verifies inclusion proofs for specific UTXOs.

Why deferred. Bitcoin's PoW finality is probabilistic, not BFT;
operating across different finality models needs careful design of
the confirmation policy. Lower priority than Ethereum since Bitcoin
DeFi is smaller surface area.

### 20.4.3 Parachain SDKs

What it is. First-class SDKs in Rust, Go, and C++ for building
parachains. v1 ships the parachain runtime; SDKs reduce per-author
boilerplate.

Why deferred. v1's design is no-SDK by intent: parachain authors
declare their host imports manually and compile any wasm32-target
language. This proves the model works without lock-in to a specific
SDK. SDKs are a downstream productivity layer.

### 20.4.4 TypeScript SDK Feature Parity

What it is. The TypeScript SDK reaches full feature parity with the
Rust SDK across encrypted-lane txs, threshold queries, parachain
operations, and event subscriptions.

Why deferred. v1 ships the WASM bridge (pyde-crypto-wasm) which the
TypeScript SDK already vendors. Filling out the remaining surface is
incremental work on top.

---

## 20.5 Operations and Network Hardening

### 20.5.1 Sentry-Node Validator Hiding

What it is. Pattern where validator nodes are not directly reachable
on the public network: they peer only with operator-controlled
sentry nodes that absorb DoS attempts and front the gossip topology.

Why deferred. Operational pattern, not a protocol feature. Validators
configure their own sentry topology; the chain doesn't need to know.

What v1 reserves. The validator's peer-discovery layer already
supports the sentry pattern through the standard libp2p peer
relationships. No protocol change needed.

### 20.5.2 Sophisticated Peer Scoring

What it is. Multi-topic peer scoring with decay parameters, weighted
by topic priority, used to throttle or eject misbehaving peers before
they hit slashable thresholds.

Why deferred. v1 ships basic per-peer rate limiting; the
multi-topic decay model is operational polish.

### 20.5.3 Signed-Mempool Commitments + Censorship Slashing

What it is. Each validator periodically signs a commitment over the
mempool view they've seen, broadcast publicly. If a validator's
proposed wave omits a transaction that's been in their signed
mempool view for K rounds, that's evidence of censorship and is
slashable.

Why deferred. The mechanism design is subtle: you need to handle
legitimate omissions (insufficient gas, denylisted addresses) without
either creating false positives or letting real censorship slip
through. Requires its own PIP and audit.

What v1 reserves. The mempool view already exposes a stable identifier
per transaction; future censorship-slashing reads from that identifier
without needing wire changes.

### 20.5.4 Mempool-Level Emergency Pause

What it is. During an emergency pause, the mempool refuses admission
at the gateway instead of accepting transactions and rejecting them
at wave-commit time. Cleaner UX, less waste.

Why deferred. The current emergency-pause gate-check at admission
works correctly; the mempool-level optimization is operational
polish.

### 20.5.5 Graceful Drain-and-Shutdown on Persist Failure

What it is. When a validator hits a persistent disk or RocksDB
failure, it drains its current wave commitments cleanly instead of
crashing mid-commit.

Why deferred. Operational hardening. The current crash-on-failure
path is correct (no partial state ever persisted) but loud.

### 20.5.6 Off-Chain Merkle Builder CLI

What it is. A small CLI for operators to build Merkle roots from
arbitrary data, useful for airdrops, allowlist rollouts, and other
operational batched-proof patterns.

Why deferred. ~150 LOC of tooling. Builds when an operator asks.

---

## 20.6 Native Browser Wallet

What it is. A first-party browser wallet for Pyde: keystore, signing,
contract interaction, network management. Same shape as MetaMask but
native to Pyde's primitive set (FALCON keys, Kyber envelopes for
encrypted-lane txs).

Why deferred. v1 ships the primitives the wallet needs
(pyde-crypto-wasm, the JSON-RPC surface, deterministic key
derivation); the wallet itself is an ecosystem deliverable. The
toolchain ships otigen for developers; the wallet ships for users.

What v1 reserves. The wallet doesn't need protocol reservations. It
needs the simulation primitives (already exposed) and the encrypted-tx
envelope construction path (already exposed). The deferred work is the
wallet UX itself, not the chain hooks.

---

## 20.7 What's Explicitly Not Planned

A short list of things considered and deliberately rejected:

- **Object-centric execution model.** Sui's object ownership pattern
  is structurally incompatible with Pyde's slot-keyed sstore. Picking
  it up later would require breaking the host-function ABI. Decision
  locked.

- **Session keys without programmable accounts.** Possible to layer on
  top of static FALCON keys, but unsafe: scope enforcement would have
  to live in clients, which is worthless. Tied to programmable
  accounts forever.

- **Otigen→native compile.** Considered; rejected. Determinism,
  sandboxing, and metering are weaker for direct-native code than for
  WASM. Precompiles (§20.3.1 L5) cover the performance cases without
  losing those properties.

- **Gas refunds.** v1 ships zero gas refunds. EIP-3529 in EVM-land
  showed refunds are net-negative for user incentives once you
  understand the second-order effects. Pyde has PIP-4 (state-cleanup
  pricing) which makes refund-as-incentive unnecessary.

- **On-chain governance switch.** Pyde uses voluntary validator
  upgrades, not on-chain rule-changes. No protocol-level governance
  vote can flip consensus rules without each validator opting in by
  running new software. See [Chapter 18](18-protocol-upgrades.md).

---

## 20.8 The Discipline

The list above is long because v1 is intentionally lean. Each
deferred item is justifiable on its own merits, but the principle
that ties them together is the one stated at the top:

> v1 ships interfaces, v2 ships implementations.

Each capability above either lands additively (new RPC, new SDK, new
contract type) or slots into a reservation v1 has already made
(`AuthKeys::Programmable` tag, `FeePayer::Paymaster` variant). The
pieces that need protocol-level breaking changes (Sui-style objects,
gas refunds, on-chain governance) are not planned and aren't coming.
The one exception the list keeps deliberately open is a threshold-LWE
one-shot ciphertext lane (§20.2.3): a purely additive *optional* lane,
gated on a research primitive, that would sit beside, never replace,
the keyless commit-reveal default.

This is the bet: a small, correct, audited v1 surface is worth more
than a feature-rich one. Everything in this chapter is an addition to
that surface, not a replacement for it.
