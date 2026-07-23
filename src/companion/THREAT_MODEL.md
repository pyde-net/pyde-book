# Pyde Threat Model

**Version 0.1**

This is the canonical threat model for Pyde. It catalogs ~50 threats across 7 layers, maps each to its mitigation in the protocol design, and acknowledges residual risks.

This is a living document. Update on new threats discovered, protocol changes, and quarterly review.

> **Companion to Chapter 16.** [Chapter 16: Security](../chapters/16-security.md) is the narrative defense reference. It walks the same ground in essay form, explains why each defense was chosen, and is intended for readers building intuition. This document is the catalog: every threat carries an ID, severity, detection signal, and mitigation reference. External auditors should treat this document as the entry point; bug reporters should reference threat IDs from this catalog.

## 1. Scope & Assets

### In Scope (Protocol Responsibility)

- User funds (PYDE balances + staked amounts)
- State integrity (no fork, no double-spend)
- Transaction ordering integrity (no proposer-MEV)
- Private-mempool invariants (commit-before-reveal)
- Validator stake (fair slashing)
- Pre-reveal confidentiality of private-mempool transaction contents
- Liveness (chain progress)
- Cross-chain finality (HardFinalityCert correctness)

### Out of Scope (User / Operational Responsibility)

- User wallet compromise (private key custody is the user's)
- Smart contract bugs in user-deployed WASM contracts (audit + safety features mitigate, but protocol doesn't enforce)
- RPC provider failures (orthogonal infrastructure)
- Single-node hardware failures (operator responsibility, mitigated by redundancy)
- Social engineering of multisig holders (organizational responsibility)
- Future quantum compute attacks on archived data (out of scope; consensus/account primitives are all PQ)
- Application-layer DDoS (dApp choosing weak rate limits)

### Asset Value Classification

| Asset | Value | Loss impact |
|---|---|---|
| User funds | Critical | Direct financial loss to users |
| State integrity | Critical | Chain becomes untrustworthy |
| MEV resistance | Critical | Core value proposition |
| Validator stake | High | Slashing must be fair |
| Liveness | High | Chain stops being useful |
| Privacy | High | Pre-reveal confidentiality promise violated |
| Cross-chain integrity | High | Bridges hacks have caused $3B+ historical losses |

## 2. Adversary Model

### Adversary Types

| Type | Motivation | Resources | Likelihood |
|---|---|---|---|
| MEV bot operator | Profit | Modest infrastructure, deep mempool knowledge | High |
| Economic actor | Profit (large) | Significant capital, can stake | Medium |
| Coordinated cartel | Combined economic gain | Large stake + infrastructure | Medium |
| State adversary | Geopolitical, censorship | Nation-state resources, BGP control | Low but high-impact |
| Insider (validator) | Profit, sabotage | Has stake, software access | Low but high-impact |
| Cryptographic adversary | Research or destruction | Mathematician + compute | Low |
| Quantum adversary | Long-term destruction | Future quantum computer | Very low (decade+) |
| Network adversary | Disruption | ISP / BGP position | Low |
| Software supply chain | Various | Dependency access | Medium |
| Social attacker | Various | Social skills | Medium |

### Adversary Capabilities

**Default network adversary (Dolev-Yao):**
- ✅ Observe public messages
- ✅ Delay, reorder, drop, duplicate messages
- ✅ Spoof network packets
- ❌ Cannot forge FALCON signatures
- ❌ Cannot read a commitment's content (it is a Blake3 hash; no key exists)
- ❌ Cannot find hash collisions in Blake3 or Poseidon2

**Insider validator (single):**
- ✅ Has one FALCON private key
- ✅ Has validator software access
- ❌ Cannot read private-mempool content before reveal (no committee key exists)
- ❌ Cannot forge other validators' signatures
- ❌ Cannot violate determinism alone (constrained by protocol rules)

**Coordinated insiders (≤42 validators, below BFT threshold):**
- ✅ Can equivocate (each commits slashable offense)
- ✅ Can collude on transactions (but ordering is deterministic)
- ❌ Cannot read private-mempool content before reveal (no key to collude on; the property is unconditional)
- ❌ Cannot violate safety (need 85+ for any commit)
- ❌ Cannot censor (other 86+ can include any transaction)

**Coordinated insiders (≥85 validators, above BFT threshold):**
- ✅ Can commit to invalid states (others detect and halt)
- ✅ Can censor
- ✅ Can fork the chain
- **This is the "BFT broken" scenario, out of normal protocol scope. Residual risk.**

## 3. Trust Assumptions

### Cryptographic
- FALCON-512 is EUF-CMA secure (NIST standard)
- Blake3 and Poseidon2 are collision- and preimage-resistant (the private mempool's commitment hiding rests on this alone; no committee key is assumed)
- Kyber-768 is IND-CCA2 secure (NIST FIPS 203), used only for transport-layer session keys
- Random beacon is unpredictable until the last signer contributes

### Network
- Partially synchronous: messages eventually delivered (no permanent partition)
- Clock skew bounded (~5 seconds maximum)
- At least one honest path exists between any two honest nodes

### Validator Behavior
- ≥85 of 128 committee members are honest (BFT supermajority)
- Honest nodes follow the protocol; slashing punishes deviation
- Validator software is correctly implemented (defense via formal methods + audits)

### Operational
- Genesis ceremony participants are honest
- Hardcoded seed nodes are operated honestly
- DNS infrastructure is reliable
- Foundation multisig members are not compromised (>4 of 7 honest for 7-of-12 threshold)

## 4. Threat Catalog

### Consensus Layer

| ID | Threat | Severity | Detection | Mitigation |
|---|---|---|---|---|
| T-CONS-1 | Equivocation (validator signs contradictory messages) | High | Cryptographic evidence | Equivocation slashing 10-50% |
| T-CONS-2 | Long-range attack (rewrite history) | Medium | State root signatures, finality | Bounded rollback (1 epoch), weak-subjectivity checkpoints |
| T-CONS-3 | Bad state-root signing | High | Contradictory roots for same commit | Bad-state-root slashing 10%, correlation multiplier |
| T-CONS-4 | Anchor predictability exploitation | Medium | Public beacon analysis | Lookback state-root randomness |
| T-CONS-5 | Adaptive corruption (mid-epoch) | Medium | Liveness slashing | Epoch boundary commitment, slashing accumulation |
| T-CONS-6 | Slashing race (withdraw before slash applies) | High | Unbonding period | Unbonding (30d) > evidence freshness (21d) |
| T-CONS-7 | DAG cycle / invalid parent refs | Critical | Structural validation | Auto-reject vertex, slash producer |
| T-CONS-8 | Coordinated proposer attack | High | DAG has no proposer | Structurally impossible |

### Cryptographic Layer

| ID | Threat | Severity | Detection | Mitigation |
|---|---|---|---|---|
| T-CRYPT-1 | FALCON key compromise (single validator) | Medium | Anomaly detection | Key rotation, HSM recommended |
| T-CRYPT-2 | Commitment preimage / second-preimage (read or grind a commit before reveal) | Very low | Cryptanalysis | Blake3 preimage resistance + domain-separated tag; no key to compromise |
| T-CRYPT-3 | Hash collision (Blake3 / Poseidon2) | Very low | Cryptanalysis | Standardized primitives, dual hash strategy |
| T-CRYPT-4 | Random beacon bias | Medium | Output analysis | Aggregated per-member FALCON beacon (no single party controls) |
| T-CRYPT-5 | Future quantum on stored data | Long-term | N/A | Out of scope; all consensus/account primitives are PQ |

### MEV / Economic Layer

| ID | Threat | Severity | Detection | Mitigation |
|---|---|---|---|---|
| T-MEV-1 | Front-running via early content disclosure | High | N/A | Commit-before-reveal invariant enforced; content is a Blake3 hash until reveal |
| T-MEV-2 | Sandwich attacks | High | N/A | Content hidden behind commitment until order committed |
| T-MEV-3 | Liquidation racing | Medium | N/A | Mitigated by keyless commit-reveal ordering |
| T-MEV-4 | Time-bandit attacks | High | Finality | Bounded rollback, slashing |
| T-MEV-5 | Validator-builder collusion | Medium | N/A | No proposer-builder separation; DAG eliminates surface |
| T-MEV-6 | Stake concentration → control 43+ committee | High | Public stake state | Anti-Sybil (operator identity cap), stake cap |
| T-MEV-7 | Bribery of committee for ordering | Medium | Behavior analysis | Equal-power voting + slashing makes bribery expensive |
| T-MEV-8 | Censorship (selective exclusion) | High | Detection hard | 127 others can include; censorship requires near-unanimous |

### Network Layer

| ID | Threat | Severity | Detection | Mitigation |
|---|---|---|---|---|
| T-NET-1 | Eclipse attack (isolate target) | Medium | Peer diversity analysis | Anti-eclipse: diverse IPs/ASNs, persistent peers |
| T-NET-2 | DDoS on committee validator | High | Traffic analysis | Sentry node pattern, rate limits, peer scoring |
| T-NET-3 | BGP hijack / route manipulation | Low (rare) | Out-of-band | Out of scope (network responsibility) |
| T-NET-4 | Sybil on peer discovery | Medium | IP/ASN concentration | Layered discovery (not DHT), peer score |
| T-NET-5 | Message flooding / spam | Medium | Rate limits | Per-peer rate limiting, gas tank requirement |
| T-NET-6 | Network partition (deliberate or accidental) | Medium | Quorum detection | Partition-aware slashing pause; halt detection |

### Economic / Governance Layer

| ID | Threat | Severity | Detection | Mitigation |
|---|---|---|---|---|
| T-ECON-1 | Stake concentration (rich operator, many cheap validators) | High | On-chain analysis | Operator identity binding, max 3 per operator |
| T-ECON-2 | Validator collusion (43+ coordinated offline DoS) | High | Quorum detection | Slashing + partition handling |
| T-ECON-3 | Treasury attacks (governance capture) | Medium | Public proposals | Off-chain governance, transparent PIP process |
| T-ECON-4 | Multisig compromise (emergency halt abuse) | High | Multi-key threshold | 7-of-12 multisig, slashable malicious unhalt |
| T-ECON-5 | Token price collapse → slashing economics broken | Medium | Market data | Numbers tunable, treasury can adjust |

### Software / Implementation Layer

| ID | Threat | Severity | Detection | Mitigation |
|---|---|---|---|---|
| T-SW-1 | WASM execution non-determinism bug | Critical | State root divergence | Extensive testing, formal verification, halt detection |
| T-SW-2 | Toolchain binding-generator bug | High | Contract test failures | Per-language generator audits, fuzz testing across all four targets |
| T-SW-3 | FALCON sig side-channel | Low | Timing analysis | Constant-time implementation |
| T-SW-4 | Memory corruption (buffer overflow) | High | Rust borrow checker, audits | Use safe Rust, audit unsafe blocks |
| T-SW-5 | Cryptographic library bug | High | Audits | Use well-audited libraries (RustCrypto) |
| T-SW-6 | State corruption (disk errors) | Medium | Snapshot verification | JMT root recomputation, peer cross-verification |

### Authorization Layer (v2: session keys + programmable accounts)

Session keys ship at v2. The threats below are catalogued now so the v2 implementation lands against a known surface. Until v2, the `AuthKeys::Programmable` variant is reserved-but-disabled; these threats are inactive at v1.

| ID | Threat | Severity | Detection | Mitigation |
|---|---|---|---|---|
| T-AUTH-1 | Session-key theft (compromised dApp leaks key) | Medium | User notification; on-chain anomaly (unusual spend pattern within scope) | Limited blast radius via scope (contracts + methods + spend cap + expiry); user can revoke instantly with a single signed tx; main `auth_keys` untouched |
| T-AUTH-2 | Revoked-key replay (attacker submits tx signed by previously-revoked session key) | Low | Authorization-time `revoked` check | Revocation is on-chain state; tx rejected at validation with `KeyRevoked` |
| T-AUTH-3 | Scope expansion via mutable storage manipulation | High | Policy WASM audit | Policy WASM runs in restricted-state mode; cannot modify own `scope` without main-key signature on a `RegisterSessionKey`/`UpdateScope` tx |
| T-AUTH-4 | Session-key squatting (creating many keys to flood storage) | Low | Per-account session-key count | Hard limit (32 active session keys per account); spent storage refunded on revocation |
| T-AUTH-5 | `spent_so_far` overflow attack | Low | u128 arithmetic checks at authorization | Saturating addition + `max_spend ≤ u128::MAX / 2` registration check |
| T-AUTH-6 | Expired-key acceptance (clock skew at wave boundary) | Low | Authorization-time `expires_at` check | Wave is the authoritative clock; no off-chain time source enters the check |

### Social Layer

| ID | Threat | Severity | Detection | Mitigation |
|---|---|---|---|---|
| T-SOC-1 | Phishing of operators / multisig | High | Out-of-band | Operator training, HSM, multisig for high-value ops |
| T-SOC-2 | Misinformation during incident | Medium | Multiple channels | Foundation as authoritative source, clear comms protocol |
| T-SOC-3 | Insider threat (developer / foundation) | Medium | Code review, multisig | Multi-sig deployments, public PIP review |
| T-SOC-4 | Supply chain attack on dependencies | High | Cargo.lock audit | Reproducible builds, dependency review |

## 5. Mitigation Cross-Reference

| Mitigation | Specification |
|---|---|
| BFT 85/128 quorum + Mysticeti-style consensus | See WHITEPAPER §5 |
| Slashing | See SLASHING.md |
| Keyless commit-reveal private mempool + commit-before-reveal | See WHITEPAPER §5.2, §9 |
| Anti-Sybil (operator identity binding) | See VALIDATOR_LIFECYCLE.md |
| State sync verification (chain-of-trust) | See STATE_SYNC.md |
| Chain halt + recovery procedures | See CHAIN_HALT.md |
| Network defenses (DoS, eclipse) | See NETWORK_PROTOCOL.md |
| Performance harness validates resilience | See PERFORMANCE_HARNESS.md |
| Equal-power committee | See WHITEPAPER §5.5 |
| Honest throughput claims | See WHITEPAPER §11 |

## 6. Residual Risks (Acknowledged, Not Fully Mitigated)

These are risks Pyde cannot fully eliminate:

1. **Coordinated 85+ validator collusion**: out of BFT scope. If 85+ collude, safety can be violated. Mitigation: economic disincentives + stake distribution + operator identity cap.

2. **Quantum compute breaking PQ primitives in <10 years**: not currently feasible to defend; PQ choice is the best available.

3. **Smart contract bugs in user-deployed WASM contracts**: out of protocol scope. Mitigation: Pyde safety attributes (reentrancy off by default, checked arithmetic) preserved in the WASM era + recommended user audits.

4. **Single-validator key compromise**: validator loses ≤1 vote of influence. Mitigation: key rotation, HSM, multisig validator (v2 feature).

5. **Foundation multisig compromise**: 7+ of 12 hostile = emergency halt abuse. Mitigation: diverse multisig members, public visibility, slashable malicious unhalt.

6. **Network-level adversary (BGP, ISP)**: out of protocol scope. Mitigation: encourage geographic + provider diversity.

7. **Genesis trust**: initial committee, hardcoded seeds, hardcoded committee pubkeys all require founder trust. Unavoidable at chain launch.

## 7. Update Procedure

The threat model is a living document:

- **Update triggers:**
  - New threats discovered (research, incidents, audits)
  - Protocol changes (new features → new attack surfaces)
  - Quarterly review (mandatory)
- **Format for new threat entry:**
  ```
  - T-XXX-N: <name>
  - Severity: <Critical / High / Medium / Low>
  - Discovered: <date / source>
  - Detection: <how detected>
  - Mitigation: <how addressed or "residual risk">
  - Reference: <design doc section>
  ```
- Each major update increments the version number.

## 8. For Auditors

This document is the entry point for external security review. Auditors should:

1. Verify the threat catalog is complete (no missing categories)
2. Verify each mitigation is actually implemented (trace to code)
3. Verify residual risks are acceptable for the asset values
4. Verify trust assumptions are reasonable for production
5. Test selected scenarios (especially from FAILURE_SCENARIOS.md)

---

**Document version:** 0.1

**License:** See repository root
