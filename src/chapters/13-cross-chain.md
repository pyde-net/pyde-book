# Chapter 13: Parachains and Cross-Chain

This chapter covers two distinct (and sometimes conflated) topics:

1. **Pyde's parachain framework** — the v1 mechanism for app-specific execution contexts that run as WebAssembly modules with their own state subtrees, their own governance, and their own validator sets opting in from Pyde's main committee.
2. **Cross-chain bridges to other L1s** — the post-mainnet path to interoperability with Ethereum, Bitcoin, and other chains.

These are different things. A Pyde parachain is an on-chain WASM module with extra privileges (its own state space, cross-parachain messaging, threshold-crypto access). A cross-chain bridge is infrastructure that ferries proofs between Pyde and a foreign chain.

**For parachains: the framework ships at v1** — the on-chain registry, governance, lifecycle, and execution environment are all part of mainnet. Authors write parachain logic in any wasm32-target language (Rust, AssemblyScript, Go, C/C++) and deploy via the `otigen` toolchain. The full design is in [`memory/parachain-v1-design`](https://github.com/pyde-net/.github/blob/main/memory-references.md) and the upcoming PPIPs (Pyde Parachain Improvement Proposals).

**For cross-chain bridges: the surface ships at v1; the implementation ships post-mainnet.** The `cross_call` host function, the `HardFinalityCert` primitive, and the unified gas model are all available at genesis so contracts can be written today against the interface. The actual cross-chain transports (FALCON-in-EVM verifier, light-client contracts, relay infrastructure) ship after mainnet stability is proven.

---

## 13.1 What Mainnet Ships

At mainnet, Pyde does **not** ship:

- A native bridge to any other chain (no Ethereum bridge, no Bitcoin
  bridge, no IBC channel).
- Native cross-chain message passing to foreign L1s at the protocol level
  (the `cross_call` interface exists; the transports do not).
- Slot auctions or Polkadot-style shared-security parachains. Pyde's parachain
  model is different — see §13.5.

What it **does** ship:

- A sovereign L1 with the full execution model (WASM contracts via wasmtime,
  encrypted mempool, FALCON-quorum finality, JMT state).
- The parachain framework (registry, governance, lifecycle, execution environment) — see §13.5 below.
- Hard-finality certificates suitable for use as cross-chain proof inputs
  by any future bridge contract.
- An architecture that leaves room for cross-chain bridges as
  post-mainnet extensions.

The reasoning: bridges are the largest historical source of catastrophic
loss in the cryptocurrency ecosystem. Shipping a bridge at mainnet without
months of audit and incentivized testnet exposure would be irresponsible
relative to the launch timeline. A bridge added later, against a stable
chain with proven liveness, is a much smaller surface to audit.

---

## 13.2 Why Cross-Chain Is Hard

Cross-chain communication boils down to one question: how does Chain B
verify that something happened on Chain A? Three families of answers
exist:

| Approach          | Trust assumption                                          |
| ----------------- | --------------------------------------------------------- |
| Trusted relay     | A multisig or enclave attests to events                    |
| Light-client proof| Chain B verifies Chain A's consensus signatures directly   |
| Validity proof (ZK)| Chain B verifies a SNARK/STARK of Chain A's execution     |

Trusted relays are the cheapest to build and the worst by every other
metric — every major bridge exploit (Wormhole, Ronin, Nomad, Multichain)
hit a trusted-relay design. Light-client proofs require Chain B to
implement Chain A's signature verification on-chain, which is expensive but
honest. Validity proofs are the strongest model and the most complex to
implement.

For Pyde's eventual bridges, the design constraints are:

1. **No new trusted parties.** No multisig "guardians" sit between Pyde and
   the counterparty chain.
2. **Light-client verification.** The counterparty chain runs a Pyde light
   client (FALCON verification + finality cert) that proves "block N was
   hard-finalized on Pyde."
3. **Symmetric or asymmetric, but always verifiable.** If the counterparty
   chain has its own light-client logic implementable on Pyde, the bridge
   is symmetric. If not (e.g., Bitcoin), Pyde verifies the counterparty
   one direction only.

None of this work is on the mainnet critical path.

---

## 13.3 Hard-Finality Certificates as Bridge Inputs

The one piece of cross-chain infrastructure mainnet does ship — implicitly
— is the **hard-finality certificate** (Chapter 6):

```rust
struct HardFinalityCert {
    wave_id:              u64,
    blake3_state_root:    Hash,
    poseidon2_state_root: Hash,
    voter_bitmap:         u128,                     // 128-bit bitmap
    signatures:           Vec<FalconSignature>,     // ≥ 85
}
```

This certificate, signed by ≥ 2f+1 = 85 of the active committee, is
exactly the input a future light-client bridge needs:

- A counterparty bridge contract holds the active committee's FALCON
  public keys (refreshed at epoch boundaries).
- To accept a Pyde-side event, the bridge requires:
  1. A `HardFinalityCert` for the commit that included the event.
  2. A Merkle proof from the wave's `blake3_state_root` (native) or
     `poseidon2_state_root` (ZK-circuit-friendly) to the event's storage
     slot.
- Verification is `(85 × FALCON_verify) + (one Merkle path verification)`,
  feasible on any chain with a reasonable VM.

The committee size of 128 caps the per-cert verification cost at ≥ 85
FALCON verifies. At ~1 ms per verify on commodity hardware, that's
~85 ms of counterparty execution per accepted Pyde event — non-trivial
but not catastrophic.

---

## 13.4 The `cross_call` Host Function

Cross-context invocation in Pyde is exposed as a WASM host function:

```rust
// From the WASM contract author's perspective (Rust example):
let result = pyde::cross_call(
    target_address,                    // contract or parachain address
    "request_price",                   // function name
    &args,                             // serialized arguments
    CallbackSpec {
        success_method: "on_price_received",
        error_method:   "on_price_failed",
        max_callback_gas: 100_000,
        timeout_waves:   100,
    },
)?;
```

The same primitive serves three call shapes:

1. **Smart contract → smart contract** (same chain, fully working at v1). Synchronous if both contracts are in the same wave; asynchronous via callback if execution spans waves.
2. **Smart contract → parachain** (working at v1 once parachain framework is live). Asynchronous; the parachain's committee processes the call and submits a callback transaction with the result.
3. **Smart contract → foreign L1** (interface available at v1; transport ships post-mainnet). Until the cross-chain transport lands, this returns `NotYetSupported` at runtime — but contract code written against `cross_call` to a foreign target compiles and deploys today, ready for when the transport ships.

The host function signature is part of the v1 Host Function ABI specification and is stable at genesis. Contracts written today against the v1 interface continue to work as additional transports come online.

### Callback context preserved

Every `cross_call` carries enough context that the callback can reconstruct what happened:

- `callback_id` (unique per call)
- `original_caller` (address that initiated the original transaction)
- `original_fn` (function that issued the cross_call)
- `original_args_hash` (hash of original args; full args retrievable from the chain log)
- `issued_at_wave` (when the call was issued)
- `target` (who was called)

On result (success, error, or timeout), the callback handler receives both the result payload and the context. Full audit trail is always preserved.

---

## 13.5 The Parachain Framework (v1)

Pyde's parachain framework is **not** a Polkadot-style slot-auction model and is **not** a separate operator network running off-chain. It is an on-chain execution mechanism for app-specific WebAssembly modules with extra capabilities relative to ordinary smart contracts.

The distinction matters because the "parachain" word is overloaded in the L1 ecosystem. In Pyde:

- **Smart contracts** are WASM modules with the standard host-function ABI. They share Pyde's state space, follow Pyde's transaction lifecycle, are scheduled by Pyde's main executor.
- **Parachains** are WASM modules with an extended host-function allowlist (cross-parachain messaging, threshold-crypto access, governance hooks) and their own state subtree partitioned by `parachain_id[..16]` under PIP-2 clustering. They have their own validator committees (subsets of the main Pyde committee that opt in), their own consensus instance (chosen from a preset menu at deploy time), and their own upgrade governance (equal-power voting among their validators).

### What ships at v1

The full framework: registration, deployment, lifecycle, upgrade governance, state partitioning, cross-parachain messaging, version history retention, and the host-function ABI surface that parachain WASM is built against.

What v1 does **not** include (deferred to v2 or later):

- A maintained per-language SDK (per the [no-SDK approach](https://github.com/pyde-net/.github/blob/main/memory-references.md): authors compile their own WASM in any wasm32-target language using the published Host Function ABI; canonical example projects are provided as starting points, but there is no per-language SDK to maintain).
- ZK-aggregated signature verification for parachain committees (the path to massively higher throughput; v2/v3 work).

### Parachain deployment

Authors deploy a parachain the same way they deploy a smart contract — via the `otigen` toolchain:

```bash
otigen init my_parachain --lang rust --type parachain
# ... author writes parachain logic in src/main.rs ...
# ... declares state schema, consensus preset, slashing preset in otigen.toml ...
otigen build
otigen deploy --network testnet --name "chainlink"
```

`otigen.toml` for a parachain extends the smart-contract schema with parachain-specific fields:

```toml
[contract]
type = "parachain"

[parachain]
consensus_preset = "simple_bft"      # or "threshold" or "optimistic"
min_validators   = 7
quorum_threshold = "2/3"

[slashing]
preset = "standard"                  # minimal / standard / strict

[hosts]
allowed = [
  "storage_read", "storage_write", "emit_event",
  "send_xparachain_message", "threshold_decrypt",
  # ... full parachain-extension allowlist
]
```

### Parachain governance

Parachain upgrades go through equal-power voting among the parachain's validators (one validator, one vote — NOT stake-weighted). Configurable quorum, configurable threshold, with a default 2/3 supermajority. Owner-only emergency pause and kill are available for operational lifecycle. Governance can claw back squatted names via PPIP if the dispute warrants.

Full upgrade history is retained on-chain forever. Every transaction receipt records `(parachain_id, parachain_version, wasm_hash)` so historical replay can fetch the exact WASM binary that originally executed each tx.

### Cross-parachain messaging

Parachains can call each other via the `send_xparachain_message` host function. Rate-limited, threshold-signed (the calling parachain's committee signs the outgoing message; the receiving parachain's committee verifies it), and routed through Pyde's main consensus as regular transactions. The full mechanism is documented in the upcoming PPIPs.

### Why this model rather than slot auctions

Slot auctions (Polkadot-style) concentrate parachain rights in deep-pocketed operators, creating political and centralization risk. Pyde's parachain model is closer to "deploy a contract that happens to have its own state space and validator committee" — anyone can deploy, costs are predictable (ENS-style name registration + owner deposit), and economic alignment is via stake and slashing rather than auction proceeds.

---

## 13.6 Native Bridges (Post-Mainnet)

Beyond a parachain SDK, the longer-term direction includes purpose-built
bridges to specific chains.

| Direction                | Mechanism                                       | Difficulty             |
| ------------------------ | ----------------------------------------------- | ---------------------- |
| Pyde → Ethereum          | Ethereum contract verifies Pyde finality certs  | Moderate (FALCON in EVM)|
| Ethereum → Pyde          | Pyde contract verifies Ethereum execution proofs | Moderate (Merkle Patricia)|
| Pyde → Bitcoin           | SPV-style proofs of Bitcoin finality             | Hard (PoW finality is probabilistic)|
| Pyde → other PoS L1s     | Each side verifies the other's signature scheme  | Variable                |

The Ethereum bridge is the most concrete near-term target post-mainnet.
The work splits into:

1. **An Ethereum-side contract** that verifies FALCON signatures and
   `HardFinalityCert` structures. FALCON-512 verification in EVM is
   non-trivial (algebraic operations over a 12,289-mod ring) but not
   fundamentally blocked.
2. **A Pyde-side contract** that verifies Ethereum execution proofs
   (Merkle Patricia paths). This part is straightforward — WASM contracts
   on Pyde can implement Patricia path verification just as Solidity contracts can.
3. **A relay process** that ferries finality certs and execution proofs
   between the two chains. The relay is permissionless — anyone can run it,
   and anyone can verify the outputs.

No mainnet timeline commitment exists. The bridge is contingent on:

- Pyde mainnet stability (Phase 9 + Phase 10 of the launch plan).
- Independent audit of the FALCON-in-EVM verifier (probably the most
  novel piece of crypto code in the bridge stack).
- A specific use case that justifies the bridge (e.g., bringing
  Ethereum-issued stablecoins to Pyde at scale).

---

## 13.7 What WASM Contracts Can Do Today (No Bridge)

A few cross-chain-adjacent things are still possible at the application
layer without any protocol-level bridge:

### Off-chain oracle pattern

A contract on Pyde that needs an external value (e.g., an asset price)
can:

1. Define an `oracle: Address` storage field.
2. Allow only that address to write to a `prices` map.
3. The "oracle" is an off-chain process running by some trusted operator
   (or a multisig) that submits update transactions.

This is not a bridge. It is a trusted off-chain feed. But it works, and it
unlocks DeFi applications without waiting for a bridge.

### Mirror tokens

A token contract on Pyde can represent off-chain assets (USDC,
ETH-pegged) by trusting a multisig minter. This is the same trust model
as wrapped tokens on every other chain — appropriate when the operator is
sufficiently trusted (e.g., a regulated custodian) but not appropriate as
a default bridge.

### Light-client deployments

If a developer wants to verify Ethereum events on Pyde today, they can
deploy an Ethereum-light-client WASM contract that consumes Ethereum
block headers (relayed by an off-chain process) and verifies execution
proofs against them. The verification work is done by the contract; the
relay is just data ferrying.

This is the right pattern, even if the relay is operationally trusted —
the verification is on-chain and trustless.

---

## 13.8 Parachain Economics

A common question: what does PYDE pay for in a parachain world?

PYDE is the gas token across the platform. Every parachain operation that touches state, emits events, sends cross-parachain messages, or consumes execution gas is metered in PYDE via wasmtime fuel — exactly the same as smart-contract operations. Authors pay registration fees + owner deposits in PYDE at deploy time. Validators of a parachain earn PYDE rewards via the standard inflation distribution, weighted by their committee membership and uptime.

Parachain authors can layer their own internal token economies on top (e.g., a DEX parachain might mint LP tokens; a DAO parachain might mint governance tokens) — but those are application-layer concerns, not protocol-level mechanics. The protocol charges PYDE; what the parachain charges its users is its own decision.

This keeps the gas accounting simple: one token, one fuel mechanism, uniform across smart contracts and parachains.

---

## 13.9 What the Roadmap Looks Like

| Stage                      | Cross-chain capability                                |
| -------------------------- | ---------------------------------------------------- |
| **Mainnet (v1)**           | Parachain framework live (WASM-based); `cross_call` host function available; `HardFinalityCert` format stable |
| **Post-mainnet — Stage 1** | First production parachains deployed (DEX, oracle, etc.)     |
| **Post-mainnet — Stage 2** | First Ethereum bridge (FALCON-verifier on EVM + Pyde-side Patricia verifier) |
| **Post-mainnet — Stage 3** | Multi-chain bridges (additional foreign L1s)                  |
| **Post-mainnet — Stage 4** | ZK-aggregated FALCON signatures (reduces bridge verification cost dramatically) |
| **Post-mainnet — Stage 5** | zk-WASM proven execution (where research is heading)         |

These are directional. Each stage is gated on the maturity of the previous
stage and on credible auditor capacity, not on a calendar.

---

## Summary

| Capability                            | At mainnet? | Post-mainnet plan?     |
| ------------------------------------- | ----------- | ---------------------- |
| Sovereign L1                          | Yes         | —                      |
| Hard-finality certificate (cert format)| Yes        | Used by future bridges |
| Parachain framework (WASM-based)      | Yes         | Production parachains roll in over time |
| Cross-parachain messaging             | Yes (with framework) | Optimizations + ZK aggregation |
| `cross_call` host function (interface)| Yes         | Foreign-chain transports wired post-mainnet |
| Smart-contract → smart-contract calls | Yes (working) | Performance optimizations |
| Smart-contract → parachain calls      | Yes (with framework) | — |
| Smart-contract → foreign L1 calls     | Interface only, returns `NotYetSupported` | Wired when bridges ship |
| Native bridge to Ethereum             | No          | Yes (FALCON-in-EVM)    |
| Native bridge to Bitcoin              | No          | Maybe (SPV proofs)     |
| Off-chain oracle / multisig mints     | Possible at app layer | Same as today  |
| Light-client contracts (Ethereum)     | Possible at app layer | Easier with bridge|

Pyde at launch is a sovereign network with a working parachain framework, designed not to *depend* on cross-chain bridges. Sovereign assets, sovereign users, sovereign apps, sovereign parachains. Foreign-chain bridge work begins once that base is provably stable.

The next chapter covers the PYDE token: supply, inflation, distribution,
fee mechanics, and staking economics.
