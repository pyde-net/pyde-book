# Chapter 13: Cross-Chain

This chapter is about what crosses Pyde's chain boundary, both at mainnet
and on the post-mainnet roadmap.

**v1 settles the surface; v2 ships the implementation.** Pyde's v1 wire
format includes the `cross_call!` macro, the `HardFinalityCert` primitive,
and a unified gas model that prices cross-chain calls — the protocol
surface that parachain operators and bridge contracts will integrate
against is **stable at genesis**. The parachain layer itself — the
permissionless network of operators who stake PYDE and serve cross-chain
calls — ships post-mainnet, once mainnet stability is proven.

This chapter covers what mainnet does and doesn't do, what the bridge
threat model looks like, and the parachain layer direction.

---

## 13.1 What Mainnet Ships

At mainnet, Pyde does **not** ship:

- A native bridge to any other chain (no Ethereum bridge, no Bitcoin
  bridge, no IBC channel).
- Cross-chain message passing primitives at the protocol level.
- Parachain support — there is no `pyde/parachains/1` topic, no slot
  auctions, no shared-security model.

What it **does** ship:

- A sovereign L1 with the full execution model (Otigen contracts,
  encrypted mempool, FALCON-quorum finality, JMT state).
- Hard-finality certificates suitable for use as cross-chain proof inputs
  by any future bridge contract.
- An architecture that leaves room for parachains and bridges as
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

## 13.4 Cross-Chain Message Stub: `cross_call!`

The Otigen compiler parses a `cross_call!` macro:

```otigen
cross_call!(
    target:   "ethereum",
    method:   "request_price",
    args:     (pair, address(self)),
    callback: "on_price_received",
);
```

At mainnet, this lowers to a no-op (or compile error, depending on context)
because no cross-chain transport exists. The stub is in place so that when
the parachain SDK or a bridge contract lands, contract code that already
uses `cross_call!` works without rewriting the language.

Without an active transport, `cross_call!`-using contracts compile and
deploy, but the macro returns "not yet supported" at runtime.

---

## 13.5 Parachain Layer (Post-Mainnet)

The parachain direction is **permissionless infrastructure**, not slot
auctions. Operators implement a Pyde-published specification, stake PYDE,
follow protocol rules, and earn gas fees from contracts that invoke them
via the `cross_call!` macro.

The distinction matters:

- **Otigen contracts** run inside Pyde's PVM and share Pyde's state, gas,
  and validators.
- **Parachain operators** are independent processes (any language, any
  VM) that stake PYDE on a special parachain contract, listen for
  `cross_call!` invocations, fulfill them on the target chain, and post
  results back with proofs. They earn fees in PYDE for each fulfilled
  call.

**Why permissionless rather than auctioned slots.** Slot auctions
(Polkadot-style) concentrate parachain rights in deep-pocketed
operators, creating both political and centralization risk. Pyde's
parachain layer instead works like RPC providers on Ethereum: anyone can
stake and run an operator, contracts can pick which operator they trust,
and the market sets prices.

The parachain SDK aims to provide:

| Component                       | Purpose                                          |
| ------------------------------- | ------------------------------------------------ |
| Operator runtime (Rust)         | Reference implementation; listen, fulfill, post  |
| `cross_call!` semantics         | Async, with HardFinalityCert verification on result |
| Operator slashing               | Stake at risk for misreporting or non-fulfillment |
| Operator discovery              | On-chain registry of staked operators + reputation |
| Multi-chain support             | Ethereum, Bitcoin, Solana, Polkadot adapters     |

The SDK does not exist yet. It ships post-mainnet, once mainnet stability is established.

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
   (Merkle Patricia paths). This part is straightforward — Otigen contracts
   can implement Patricia path verification just as Solidity contracts can.
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

## 13.7 What Otigen Contracts Can Do Today (No Bridge)

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
deploy an Ethereum-light-client Otigen contract that consumes Ethereum
block headers (relayed by an off-chain process) and verifies execution
proofs against them. The verification work is done by the contract; the
relay is just data ferrying.

This is the right pattern, even if the relay is operationally trusted —
the verification is on-chain and trustless.

---

## 13.8 Parachain Native Token Question

A common question: what does PYDE pay for in a parachain world?

The intended answer: parachains pay PYDE for inclusion. A parachain's
block hash gets anchored in Pyde state; that state write costs Pyde gas;
the gas is paid in PYDE. The parachain operator either pays directly or
collects fees in their parachain's native token and converts.

This means PYDE is the bandwidth token of the parachain ecosystem (Pyde's
state writes are the bandwidth) without requiring parachain users to hold
PYDE. The ecosystem-level economics will be designed in detail when the
parachain SDK is closer to launch.

---

## 13.9 What the Roadmap Looks Like

| Stage                      | Cross-chain capability                                |
| -------------------------- | ---------------------------------------------------- |
| **Mainnet (v1)**           | Surface-only: `cross_call!`, `HardFinalityCert` available |
| **Stage 1 (post-mainnet)** | Parachain SDK alpha (Rust operator runtime)            |
| **Stage 2**                | First Ethereum parachain operator (FALCON-verifier on EVM) |
| **Stage 3**                | Parachain layer live; permissionless operator registry |
| **Stage 4**                | Multi-chain operators (Ethereum + others)              |
| **Stage 5**                | Operator slashing on-chain; reputation system mature    |

These are directional. Each stage is gated on the maturity of the previous
stage and on credible auditor capacity, not on a calendar.

---

## Summary

| Capability                            | At mainnet? | Post-mainnet plan?     |
| ------------------------------------- | ----------- | ---------------------- |
| Sovereign L1                          | Yes         | —                      |
| Hard-finality certificate (cert format)| Yes        | Used by future bridges |
| Native bridge to Ethereum             | No          | Yes (FALCON-in-EVM)    |
| Native bridge to Bitcoin              | No          | Maybe (SPV proofs)     |
| Parachain SDK                         | No          | Yes (Rust/Go/C++)      |
| Cross-parachain messaging             | No          | Yes (post-SDK)         |
| `cross_call!` Otigen macro            | Stub only   | Wired when SDK lands   |
| Off-chain oracle / multisig mints     | Possible at app layer | Same as today  |
| Light-client contracts (Ethereum)     | Possible at app layer | Easier with bridge|

Pyde at launch is a sovereign network designed not to need bridges —
sovereign assets, sovereign users, sovereign apps. The bridge work begins
once that base is provably stable.

The next chapter covers the PYDE token: supply, inflation, distribution,
fee mechanics, and staking economics.
