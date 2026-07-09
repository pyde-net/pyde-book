# Chapter 9: MEV Protection

Maximal Extractable Value is the single largest structural problem in
production blockchain design. On Ethereum it transfers somewhere between
$1B and $3B annually from ordinary users into the pockets of searchers,
builders, and validators. On Solana the Jito stack is a tip auction by
another name. Every "fix" attempted at the application layer ultimately
relies on someone who can see your transaction before it lands.

Pyde does not mitigate MEV. It removes the mechanism by which it is
expressible. This chapter walks through the four interlocking pieces that
make front-running, sandwich attacks, JIT liquidity sniping, and ordering
bribery infeasible at the protocol level — not in policy, in physics.

**Post-pivot context.** The earlier HotStuff design had a single proposer
per slot, which was both the source of and the brake on MEV. After the
2026 pivot to Mysticeti DAG consensus, there is **no single proposer**
to bribe or collude with — each round, every committee member produces a
vertex independently, and the canonical order is derived from a
deterministically-selected anchor + commit certificate. This makes the
MEV story even stronger, but a few details (ordering commitment,
mandatory inclusion) have moved from "proposer asserts" to "DAG
structurally enforces."

**Encryption is optional per-transaction.** Users who don't care about
front-running (e.g., simple transfers, public DAO votes) can submit
plaintext for lower fees and ~0.5-2× higher TPS. Users who do care
(swaps, liquidations, arbs) encrypt and pay the threshold-decryption
overhead. The protocol supports both.

---

## 9.1 The MEV Problem

### What MEV looks like

The simplest sandwich attack:

```
Without MEV protection (Ethereum, Solana):

  Mempool:
    Alice: Buy 10,000 TOKEN_X at market

  Searcher sees Alice's tx and bundles:
    Searcher: Buy 5,000 TOKEN_X    <- inserted BEFORE Alice
    Alice:    Buy 10,000 TOKEN_X   <- executes at higher price
    Searcher: Sell 5,000 TOKEN_X   <- inserted AFTER Alice, profits

  Result:
    Alice pays a worse price.
    Searcher pockets the slippage.
    Builder/validator extracts a cut via tip or block-bid.
```

Variants: front-running (just the "Buy before"), back-running (capture an
arb the victim's swap creates), JIT liquidity (provide liquidity right
before a large swap, withdraw immediately after), liquidation sniping
(race other liquidators for a discount).

### Why mitigation isn't enough

Every "mitigation" approach in production today shares one defect: at least
one party — a builder, a relay, a private-mempool operator — can see your
transaction before its position in the block is final.

| Approach            | Who still sees the tx                        |
| ------------------- | -------------------------------------------- |
| PBS / MEV-Boost     | Builders + relays                            |
| Fair ordering       | Network observers (latency-exploitable)      |
| Batch auctions      | Solver (and only fixes one tx type — swaps)  |
| Private mempool     | Builder still sees                           |
| Commit-reveal       | Adds latency; doesn't address validator games|

As long as anyone can read your transaction *before* deciding where it
goes, MEV extraction is possible.

Pyde's choice: make it information-theoretically impossible for anyone — the
proposer, validators, observers — to know what a transaction does until
after its position is irrevocably committed.

---

## 9.2 The Four Layers

```
Layer 1: OPTIONAL THRESHOLD-ENCRYPTED MEMPOOL
    - Tx payload encrypted with the committee's threshold pubkey (Kyber-768).
    - No single party can decrypt; 85 of 128 share-holders required.
    - Encryption is opt-in per tx — txs that don't need MEV protection
      can be submitted plaintext at lower cost.
    - Closes (for encrypted txs): front-running, sandwich, JIT,
      liquidation-sniping based on reading mempool contents.

Layer 2: COMMIT-BEFORE-REVEAL ORDERING
    - The DAG anchor at round R commits to a canonical subdag ordering
      of vertices (and therefore txs) BEFORE decryption shares for that
      wave are released.
    - The anchor is deterministic from epoch beacon + round; no single
      validator chooses it. Decryption shares are piggybacked on
      subsequent rounds' vertices and only combine once the subdag is
      committed.
    - Closes: post-decryption reordering. Because the order is fixed by
      the DAG structure before contents are readable, even a colluding
      85+ subset cannot rewrite the order after seeing contents.

Layer 3: STRUCTURAL INCLUSION (DAG)
    - Every vertex from round R includes references to >= 85 parent
      vertices from round R-1. A tx introduced into the DAG via any
      honest member's batch is committed once any committed anchor
      references the path containing it.
    - There is no "proposer" who can selectively omit. Censorship
      requires >= 44 validators (the equivocation threshold) to refuse
      to reference the tx — a structurally visible attack.
    - Closes: single-actor censorship of decryptable txs.

Layer 4: NO TIPS, NO PRIORITY FEES
    - The wire format has no field for a tip, priority fee, or out-of-band
      payment to any party.
    - The fee is exactly gas_used * base_fee.
    - Closes: bribery channels for ordering.
```

Each layer closes attacks the others alone could not. Removing any one
re-opens a class of MEV.

---

## 9.3 Layer 1: Threshold-Encrypted Mempool

### The wire shape

```
Plaintext (visible from submission):
  from         32 B    (Poseidon2 of the FALCON pubkey)
  nonce        u64
  gas_limit    u64     (>= 21,000, <= 1.6B gas ceiling)
  access_list  Vec     (state slots the tx will touch)
  deadline     u64?    (wave height after which the tx is invalid)
  chain_id     u64
  signature    ~666 B  (FALCON-512 over the canonical hash of all fields)

Encrypted (Kyber ciphertext + AES-256-GCM payload):
  to           32 B
  value        u128
  calldata     Vec<u8>
  fee_payer    Sender | GasTank | Paymaster(addr)
  tx_type      Standard | Deploy | Batch | Stake* | Vote*
```

The committee's threshold public key is a **Kyber-768** key whose secret
has been Shamir-split across the 128 active validators (see Chapter 8). Any
85 share-holders combine to decrypt; any 84 learn nothing.

### What's visible vs what's hidden

| Field        | Visible | Why                                                    |
| ------------ | ------- | ------------------------------------------------------ |
| `from`       | yes     | Needed for signature verification + nonce window check  |
| `nonce`      | yes     | Replay protection (must fit the bitmap window)          |
| `gas_limit`  | yes     | Block gas accounting at proposal time                   |
| `access_list`| yes     | Prefetch hint for cache warm-up (never affects correctness) |
| `deadline`   | yes     | Mempool eviction of expired txs                         |
| `chain_id`   | yes     | Cross-chain replay protection                           |
| `signature`  | yes     | Validates the whole tx                                  |
| `to`         | **no**  | Reveals counterparty                                    |
| `value`      | **no**  | Reveals transfer amount                                 |
| `calldata`   | **no**  | Reveals function call + arguments + intent              |

The access list reveals *which* state slots the transaction touches, but not
*what* it does to them. An observer can see "this tx touches the DEX
contract's reserve slots" but cannot tell whether it's a buy, a sell, a
liquidity add, or a fee claim.

### Access-list padding (optional)

If a contract's slot pattern is unusually distinctive (rare), the wallet
can pad the access list with read-only decoy slots. The decoys cost a small
amount of gas (one Sload per slot, ~100 gas each) but flatten the access
profile. Most contracts use overlapping slots for many operations, so
padding is not needed in practice.

### What MEV searchers see in the mempool

```
Pyde encrypted mempool (what an observer scrapes):

  tx_hash | sender   | gas_limit | access_list        | encrypted
  --------+----------+-----------+--------------------+-----------
  0xabc...| Alice    | 300,000   | [(DEX, [s7, s12])] | 0x8f3a...
  0xdef...| Bob      | 100,000   | [(NFT, [s1])]      | 0x2c7b...
  0x123...| Carol    | 500,000   | [(DEX, [s7, s12])] | 0x91de...
```

The observer learns access patterns. They cannot construct an attack
bundle because they don't know the swap direction, swap size, slippage
tolerance, or token pair.

### Anti-spam and per-sender rate limits

To stop a malicious user from flooding the mempool with garbage ciphertexts:

| Limit                                | Default       | Why                              |
| ------------------------------------ | ------------- | -------------------------------- |
| `DEFAULT_MAX_TX_PER_WINDOW_PER_SENDER`| 10 tx / 1 s  | Token-bucket burst limit         |
| `DEFAULT_MAX_CONCURRENT_PER_SENDER`  | 100 in pool   | Cap concurrent pending txs       |
| `RATE_WINDOW_MS`                     | 1000 ms       | Token-bucket window size         |

Each sender has a `SenderQuota` tracking timestamp deque + concurrent
count; an `add()` past the limit returns `MempoolError::RateLimited`.

### Ciphertext binding to FALCON pubkey

Each transaction's signature covers a hash that includes the **ciphertext
hash** (Poseidon2 of the encrypted blob). A relay-inflation spammer who
takes someone else's ciphertext and resubmits it under a different sender
fails signature verification because the legitimate sender's signature
binds the ciphertext to the original sender.

This is what makes per-sender rate limits work — every encrypted tx has
exactly one valid sender it can attribute to.

---

## 9.4 Layer 2: Commit-Before-Reveal Ordering (DAG)

In the post-pivot DAG architecture, ordering and decryption are
**structurally** separated by the protocol — no proposer "commits" to an
ordering, because there is no proposer. Instead:

1. **Round R:** every committee member produces one vertex with parent
   refs and batch refs. Encrypted transactions are referenced by batch
   hash; their plaintext is unknown to everyone (including the vertex
   producer, who cannot decrypt alone).

2. **Round R+1 to R+3:** later rounds reference round-R vertices as
   parents and accumulate Mysticeti's 3-stage support.

3. **Anchor commit at round R+3:** the deterministic anchor at round
   R+3 (selected by `Hash(beacon, round, prev_state_root) mod 128`)
   collects sufficient support, and a canonical subdag traversal emits
   a fixed ordered list of vertices, batches, and transactions.

4. **Decryption shares released:** committee members compute and
   broadcast decryption shares for the just-committed wave's encrypted
   transactions, piggybacked on round-R+4 vertices.

5. **85 shares combined:** any honest node assembles 85 shares per
   ciphertext, decrypts, and executes in the canonical order.

```
Round R    : vertices produced (encrypted txs referenced by batch hash;
                                 nobody can read contents yet)
Round R+1  : referencing vertices (still encrypted)
Round R+2  : 2-stage support accumulates
Round R+3  : anchor commit fires -> canonical order LOCKED
Round R+4  : decryption shares released -> contents revealed
```

The critical property: **between the moment the anchor commits and the
moment shares combine, the ordering is fixed by the DAG structure**.
There is no actor with both the ability to read contents AND the ability
to alter ordering — those capabilities exist in non-overlapping rounds.

### Why this is stronger than commit-then-broadcast

Under a single-proposer commit-then-broadcast scheme, you have to trust
that the proposer can't both compute shares early AND alter the
commitment. Under the DAG, you don't trust anyone: the order is a
deterministic function of vertices that were already in the DAG before
contents could be read. No commitment signature is needed, because the
commitment is the DAG itself.

### Implementation

The canonical subdag traversal and ordering emission live in
`crates/consensus/src/subdag.rs`. The deferred-decryption pipeline lives
in `crates/crypto/src/threshold.rs` and `crates/consensus/src/wave.rs`.

---

## 9.5 Layer 3: Structural Inclusion (DAG)

Under HotStuff, a single proposer could selectively omit txs, motivating
the local-view mandatory-inclusion check. Under Mysticeti DAG, there is
**no single proposer** — every committee member produces a vertex each
round, each vertex references batches from any worker the producer
gossiped with, and every committed wave traverses the entire subdag.

For a transaction to be censored, **a coalition of ≥ 44 validators**
(equivocation threshold = `n - 2f = 128 - 84 = 44`) must all refuse to
reference the batch containing it. Below that threshold, ≥ 85 honest
vertices reference it and it lands in some committed subdag.

```
A tx submitted to ANY honest worker is gossiped to all 128 validators.
Each validator's primary produces a vertex referencing batches from
workers it received from. As long as 85+ committee members eventually
reference the batch (directly or transitively via the parent links),
the tx is committed in the next wave.

Censoring requires 44+ validators to coordinate omission — a structurally
visible attack with multiple independent forks of evidence.
```

### Mempool-level mandatory inclusion (residual)

For tighter guarantees on a per-vertex basis, a validator can still skip
or down-weight a vertex that omits txs visible in its local mempool view
for >= grace_slots. This is **defensive**, not necessary for safety —
the DAG already guarantees inclusion at the wave level. The check
catches single-validator censorship attempts before they require coalition.

The audit logic lives in `crates/mempool/src/inclusion.rs`.

### Cryptographic mempool commitments (post-mainnet)

Cryptographically aggregated mempool commitments (every committee member
periodically gossips a hash-set of txs they've seen, then the DAG-level
inclusion check is against the union) make censorship coalition-bounded
even at the round level. This is tracked for post-mainnet hardening; not
needed for safety at launch.

---

## 9.6 Layer 4: No Tips, No Priority Fees

Pyde's gas model has no field anywhere in the wire format for a "priority
fee" or "tip." Every transaction pays exactly:

```
fee = gas_used * base_fee
```

Where `base_fee` is algorithmically determined by EIP-1559 (target 400M gas,
4× elastic ceiling, ±12.5% per block adjustment). The only sender-controlled
fee parameter is `gas_limit`, which is a cap (refunded if execution uses
less).

### Why this matters

Even if encryption + commitment + mandatory inclusion fully closed the
direct ordering attacks, a tip would re-open the bribery channel. A
searcher could pay a committee validator out-of-protocol to delay a tx,
to position their own tx first, or to censor a competitor's tx. Tips
create the economic incentive for all of those attacks; absent tips, no
validator gains anything from any of them.

### How ordering happens

Under the DAG, ordering is a deterministic function of the committed
subdag — not a proposer choice. The subdag traversal at each commit
emits transactions in a canonical order derived from vertex round, member
id, and batch sequence. No actor — proposer, validator, observer —
chooses positions.

For sequential nonce dependencies (a sender submitting txs `n`, `n+1`, `n+2`
in quick succession), the protocol uses the 16-slot bitmap nonce window
(see Chapter 11) — the txs can be included in any order within the window;
gaps are tolerated.

---

## 9.7 The End-to-End Walkthrough

A swap from Alice's wallet through the full pipeline:

```
Step 1 — WALLET (Alice)
  - Build tx: to=DEX, calldata=swap(USDC, PYDE, 1000, min_out=950)
  - Call pyde_estimateAccess(tx) -> returns gas + access_list
  - Encrypt (to, value, calldata, fee_payer, tx_type) with the committee's
    Kyber threshold pubkey: ciphertext + AES-256-GCM payload
  - Sign the canonical hash with Alice's FALCON-512 secret key
  - Submit via pyde_sendRawEncryptedTransaction

  Visible to anyone who scrapes the mempool:
    Alice sent a tx. It touches DEX slots [reserve_0, reserve_1, alice_bal].
    300,000 gas. 0xpyde1abc... signature.
  Hidden:
    Direction (buy or sell), size, target tokens, slippage tolerance.

Step 2 — INGRESS VALIDATION (any RPC node)
  - chain_id, FALCON sig, nonce window, gas-tank balance, gas ceiling,
    deadline, access-list dedup, tx size, calldata size -> all pass
  - Forward to a nearby worker; worker batches and gossips

Step 3 — DAG VERTEX PRODUCTION (round R)
  - Each committee primary produces ONE vertex this round, with:
      batch_refs: hashes of batches containing Alice's tx (and others)
      parent_vertex_refs: ≥ 85 prior-round vertex hashes
      state_root_sigs: attestations on recent commits
      decryption_shares: PARTIAL shares for previously-committed waves
      FALCON sig
  - Nobody can read Alice's tx contents yet — full ciphertext payload.

Step 4 — DAG ANCHOR COMMIT (round R+3, ~500 ms after submission)
  - Deterministic anchor at round R+3:
      anchor_member = Hash(beacon, R+3, prev_state_root) mod 128
  - Anchor collects Mysticeti 3-stage support -> commit fires
  - Canonical subdag traversal emits ordered tx list — including Alice's

Step 5 — THRESHOLD DECRYPTION (rounds R+4 to R+5)
  - Committee members compute decryption shares for txs in the just-
    committed wave, blinded with H(ct_hash || member_idx || elem_idx),
    and piggyback shares on their next vertices.
  - Any honest node collects ≥ 85 shares per ciphertext, interpolates,
    decrypts with AES-256-GCM. ~10-15 ms once 85th share arrives.

Step 6 — EXECUTION (Block-STM)
  - Prefetch the union of declared access lists in one batched
    state_cf.multi_get (PIP-3) into the dashmap (PIP-4). Lists are
    hints; they never partition the wave or affect correctness.
  - Run every decrypted tx in parallel via the Block-STM scheduler:
    optimistic execute through an MVCC layer + validate against
    canonical tx_index order + cascade-invalidate + re-incarnate on
    conflict + fixpoint. Full algorithm in
    companion/BLOCK_STM_EXECUTION.md.
  - Final state derived from the fixpoint: highest-tx_index's last
    write per slot. Execute against pre_state_root → new post_state_root.
  - Distribute fees: 70% burn, 20% to current epoch's reward pool, 10% treasury.
    (Layer 4: no tip is paid because no tip field exists in the wire format.)

Step 7 — STATE ROOT ATTESTATION
  - Each committee member FALCON-signs (wave_id, blake3_state_root, poseidon2_state_root).
  - Sigs piggyback on subsequent vertices.
  - ≥ 85 sigs -> finality. Typically ~500 ms median end-to-end.

Step 8 — RECEIPT
  - Receipt available via pyde_getTransactionReceipt:
      success, gas_used, logs, fee_paid, fee_payer, wave_id
```

At no point in this flow does any party know transaction contents AND have
the ability to influence ordering. That conjunction is what MEV requires;
the protocol structurally denies it.

---

## 9.8 What Each Attack Vector Requires (And Why It Fails)

```
Front-running Alice's swap requires:
  1. Know Alice's intent              <- blocked by encryption (Layer 1)
  2. Insert before Alice in this block <- blocked by ordering commitment (Layer 2)
  3. Get into the block at all         <- blocked by mandatory inclusion + sealed block
  4. Have economic motive              <- blocked by no-tip rule (Layer 4)

Sandwich attack requires:
  1. Know the swap direction          <- (1) above
  2. Insert before AND after          <- (2) and the sealed-block invariant
  3. Bribe for specific positioning   <- (4) above

Censoring a competitor's tx requires:
  - Selectively omitting it           <- blocked by mandatory inclusion (Layer 3)

Bribing a committee validator for ordering requires:
  - A protocol mechanism to pay them   <- doesn't exist (Layer 4)
```

Each attack requires a conjunction of capabilities. Pyde structurally
denies at least one element of every conjunction.

---

## 9.9 Edge Cases

### Insufficient decryption shares

If fewer than 85 valid shares arrive within ~2 rounds (~300 ms) of a
commit, decryption fails for that wave. The DAG continues — subsequent
waves are unaffected — but the affected txs remain encrypted and stuck
in mempool until either enough shares arrive late OR the user resubmits.
Non-responsive committee members are tracked toward the liveness
slashing threshold (see Chapter 6).

Liveness assumption: as long as 85+ of 128 validators are honest and
online, decryption succeeds. This is the same `f < n/3` assumption that
secures consensus.

### Invalid decryption shares

A malicious validator could broadcast a fabricated share. The combiner
verifies each share's blinding and the recovery's MAC; an invalid share
doesn't poison the recovery (Lagrange interpolation over a sufficient
honest subset still works). Detected bad shares are tracked toward
slashing for "decryption withholding" (2% per offense).

### Garbage ciphertexts

A user could submit a ciphertext that decodes but contains junk. After
decryption, the AES-GCM authentication tag fails, the tx is invalid, and
gas is consumed (sender pays). The mempool's per-sender rate limit (10
tx/s, 100 concurrent) caps the throughput an attacker can sustain.

### Epoch boundary transitions

PSS resharing happens at every epoch boundary. The threshold public key is
unchanged across boundaries — wallets continue encrypting against the same
key. The 5-round aggregation delay
(`RESHARE_AGGREGATION_DELAY_ROUNDS`) ensures every new committee member
agrees on the same canonical contribution set before the new shares
become live.

### Committee-member compromise

If a coalition of 85+ validators colluded, they could decrypt early. Even
then, the ordering commitment forces them to commit to ordering before
decryption — they can't exploit the early read for sandwiching. They could
in principle censor (omit txs from blocks they propose), but that fails
the mandatory inclusion check on every honest validator's view. The cost of
85+ collusion is 850,000 PYDE at risk plus the slashing exposure of every
participant; the gain is sharply bounded by the structural protections.

---

## 9.10 Performance Cost

The MEV protection adds latency primarily in the deferred-decryption path:

| Step                        | Time (typical)     | Where it lives                     |
| --------------------------- | ------------------ | ---------------------------------- |
| DAG anchor commit (waves)   | ~500 ms median     | `crates/consensus/src/wave.rs`     |
| Threshold share computation | ~5 ms per tx (parallel) | `crates/crypto/src/threshold.rs` |
| Share gossip + 85-of-N collect | ~50-100 ms       | piggybacked on next vertices       |
| Recovery + AES decrypt      | ~5 ms per tx       | `crates/crypto/src/threshold.rs`   |

Encrypted txs reach finality + execution ~600-800 ms median (vs ~500 ms
for plaintext). Plaintext-only chains pay zero of this overhead.

**Throughput impact.** Encrypted txs are ~3-5× slower end-to-end than
plaintext because the decryption pipeline serializes (shares must be
gathered before the wave can execute). Both the plaintext and encrypted v1
throughput targets are to be established by the multi-region performance
harness; the encrypted regime lands well below the plaintext one because of
this serialization.

The bandwidth cost is per-share data piggybacked on consensus vertices
(~250 KB/validator/wave), well within the 500 Mbps committee NIC budget.

---

## 9.11 What's Visible vs Hidden: Recap

```
+-----------------------------+------+------+
| Field                       | Plain| Enc. |
+-----------------------------+------+------+
| sender                      |  Y   |      |
| nonce                       |  Y   |      |
| gas_limit                   |  Y   |      |
| access_list                 |  Y   |      |
| deadline                    |  Y   |      |
| chain_id                    |  Y   |      |
| signature                   |  Y   |      |
| to                          |      |  Y   |
| value                       |      |  Y   |
| calldata                    |      |  Y   |
| fee_payer                   |      |  Y   |
| tx_type                     |      |  Y   |
+-----------------------------+------+------+
```

You see *who* sends, *how much gas* they're willing to pay, *which slots*
they touch. You don't see *what* they're doing.

---

## 9.12 What This Doesn't Solve

Honest about the limits:

- **Information leakage from access lists.** A sufficiently distinctive
  access pattern can leak operation type. The mitigation is at the
  contract-design level (DEXes already share the same slots for buys,
  sells, and liquidity ops in well-designed code) and the wallet level
  (optional access-list padding).

- **Out-of-protocol coordination.** If a user signs an off-chain message
  saying "I will swap soon," anyone with that information can act on it. The
  protocol can't prevent users from leaking their own intent.

- **Long-run statistical profiling.** A persistent attacker who watches
  Alice's access patterns over many transactions could infer her behavior.
  This is a privacy concern, not an MEV one — Alice's individual
  transactions are still safe from front-running.

- **Searcher-on-searcher games at the DEX/contract level.** If a contract
  has a built-in tip mechanism (priority gas auctions inside the contract
  itself), Pyde's protocol-level MEV protection doesn't reach into it.

For mainnet, the in-scope guarantees are: no front-running by any
committee member, no sandwich attacks composable through the mempool, no
censorship of decryptable txs, and no bribery channel for ordering.

---

## Summary

Pyde's MEV protection is not a feature bolted on to an otherwise standard
chain. It is a structural property of the protocol arising from the
interaction of four mechanisms:

| Layer                        | Closes                                          | Lives in                          |
| ---------------------------- | ----------------------------------------------- | --------------------------------- |
| Optional threshold encryption| Reading tx contents pre-inclusion (opt-in)      | `crates/crypto/src/threshold.rs`  |
| Commit-before-reveal (DAG)   | Reordering after decryption                     | `crates/consensus/src/wave.rs`    |
| Structural inclusion (DAG)   | Single-actor censorship                         | `crates/consensus/src/dag.rs`     |
| No tips / priority fees      | Bribery for ordering                            | `crates/tx/src/fee.rs`            |

Each layer addresses an attack the others alone cannot stop. Together, MEV
extraction is not "discouraged" — it is unexpressible in the protocol.

**v1 scope.** Local-view mandatory inclusion is implemented and safe (a
defensive backstop on top of structural DAG inclusion). Cryptographically
aggregated mempool commitments + on-chain censorship slashing are tracked
as post-mainnet hardening.

The next chapter covers the gas and fee model that the no-tip rule sits on
top of.
