# Lifecycle

Operating a deployed contract over time: upgrading the logic, pausing it under incident, killing it permanently.

All four operations are gated by the contract's owner key (the wallet that deployed it). Non-owners can't trigger them; the chain rejects the tx at ingress.

---

## 1. The state machine

```text
                 ┌─────────────────────────┐
                 │                         │
                 ▼                         │
   deploy → ACTIVE ────upgrade───→ ACTIVE  │  (version++ each upgrade)
              │                            │
              ├─pause───→ PAUSED ──unpause─┘
              │              │
              │              kill
              │              │
              └──kill────→ KILLED   (terminal — no transitions out)
```

| Transition | Tx type | Reversible? |
|---|---|---|
| `deploy` | `ContractDeploy` | n/a (initial state) |
| `upgrade` | `Standard` (LifecyclePayload::Upgrade) | yes — deploy a new version |
| `pause` | `Standard` (LifecyclePayload::Pause) | yes — `unpause` |
| `unpause` | `Standard` (LifecyclePayload::Unpause) | yes — `pause` again |
| `kill` | `Standard` (LifecyclePayload::Kill) | **NO** — terminal |

Per [`OTIGEN_BINARY_SPEC §8`](../companion/OTIGEN_BINARY_SPEC.md), all four lifecycle txs share a `LifecyclePayload` envelope with discriminants `0x00`-`0x03`.

---

## 2. `otigen upgrade`

Replace the deployed WASM with a new version, keeping the contract's address + storage.

```bash
# Bump version in otigen.toml + Cargo.toml (or equivalent)
# Edit source, rebuild
make build
otigen upgrade my-counter --network devnet --from deployer
```

```text
upgrading my-counter on devnet:
  current version:  1 (deployed wave 42)
  new version:      2 (this upgrade)
  bundle:           ./artifacts/my-counter.bundle (sha256:b5e7f9...)
  owner:            0x9b8c7d6e5f4a3b2c... (you)

  storage layout check:
    [state] schema unchanged ✓
    no slot collisions detected ✓

submitting → http://localhost:9933 ...
✓ contract "my-counter" upgraded to v2
  tx_hash:     0xcd34ef56ab12...
  block:       58
  gas_used:    1,089,234
```

What the chain does:

1. **Ingress check.** Tx sender must equal contract.owner. Otherwise rejected before any state change.
2. **Validate new bundle** — every validator from `otigen build` re-runs on the new bytes (well-formed, imports allowed, exports declared, etc.).
3. **Version bump.** New version row written; old version is **retained forever** for replay correctness (per [PARACHAIN_DESIGN.md §10](../companion/PARACHAIN_DESIGN.md), the same rule applies to contracts).
4. **Storage preserved.** The contract address stays the same; the JMT subtree under that address is untouched.
5. **Effective from next wave.** Calls in the current wave still hit v1; calls from the next wave onward hit v2.

### Storage layout discipline

The chain does **not** enforce storage-layout compatibility between versions. If v2 changes a field's slot derivation (e.g., renames `counter` to `count` — different name, different `Poseidon2` hash), v2 reads zero from `count`'s slot while v1's value is still sitting at `counter`'s slot. **Authors are responsible for migration logic** — see the [`upgradeable-proxy` example](https://github.com/pyde-net/otigen/tree/main/examples/upgradeable-proxy) for one pattern (a version-tagged migration function called on first invocation after upgrade).

In practice: keep `[state]` schema **append-only**. Don't rename fields, don't change types, don't change the order. Add new fields at the bottom. If a major schema change is needed, write an explicit migration function and call it once post-upgrade.

### --dry-run

Same as `deploy`:

```bash
otigen upgrade my-counter --network devnet --from deployer --dry-run
```

Builds the tx, prints it, exits without submitting. Useful for previewing the upgrade.

---

## 3. `otigen pause`

Halt all calls into the contract without losing state.

```bash
otigen pause my-counter --network devnet --from deployer
```

```text
pausing my-counter on devnet:
  current status:   active
  new status:       paused

submitting → http://localhost:9933 ...
✓ contract "my-counter" paused at wave 75
```

While paused:

- **New transactions targeting the contract are rejected at ingress** with `ERR_PAUSED`.
- **Existing in-flight transactions** (in the current wave's mempool) execute against the paused state on a best-effort basis; per [`PARACHAIN_DESIGN.md §11`](../companion/PARACHAIN_DESIGN.md), some chains drain the queue, others reject immediately. Pyde drains: in-flight transactions complete, future ones reject.
- **View calls (`pyde_call` / `otigen inspect`) still work**, since they're read-only and don't enter consensus.
- **Storage is preserved.** No state changes.

Use cases: incident response (a bug is found; pause while you investigate), governance pause (a proposal is being voted on), maintenance window.

---

## 4. `otigen unpause`

```bash
otigen unpause my-counter --network devnet --from deployer
```

```text
unpausing my-counter on devnet:
  current status:   paused
  new status:       active

submitting → http://localhost:9933 ...
✓ contract "my-counter" reactivated at wave 89
```

Resumes accepting transactions starting next wave. Storage unchanged. Same owner authority as pause.

---

## 5. `otigen kill`

Mark the contract terminal. **No transitions out — this is one-way.**

```bash
otigen kill my-counter --network devnet --from deployer
```

```text
⚠  about to KILL contract "my-counter"

This is PERMANENT. After kill:
  - All future transactions to this contract will be rejected.
  - View queries still work (storage retained for STATE_RETENTION_WAVES
    = ~1 year, then archive nodes prune).
  - The contract name is NOT freed — the registry slot stays taken to
    prevent name-squatting attacks via dead contracts.

Type the contract name to confirm: my-counter
```

After typing the contract name:

```text
killing my-counter on devnet:
  current status:   active
  new status:       killed (TERMINAL)

submitting → http://localhost:9933 ...
✓ contract "my-counter" killed at wave 102
```

The retype-the-name confirmation prompt is per `OTIGEN_BINARY_SPEC §3.5` — a deliberate friction point because the operation is irreversible. Add `--yes` to skip:

```bash
otigen kill my-counter --network devnet --from deployer --yes
```

When to use:

- Contract is deprecated; you want it explicitly gone, not just paused indefinitely.
- A vulnerability is exploitable but you can't fix it via upgrade (e.g., the upgrade path itself is the vulnerability). Kill prevents further damage.
- End-of-life for a contract that's served its purpose.

### Killed != deleted

A killed contract:

- Storage is **retained on-chain for `STATE_RETENTION_WAVES`** (default ~1 year, per [PARACHAIN_DESIGN.md §11](../companion/PARACHAIN_DESIGN.md)).
- After that retention period, archive nodes prune the storage. Full nodes may prune earlier per their config.
- The contract name **is not released**. The registry slot stays taken so no one can deploy a new "my-counter" that confuses historical references.
- View queries still work during retention. After pruning, queries return `ERR_NOT_FOUND`.

---

## 6. Owner key hygiene

The four operations above are all owner-gated. Lose the owner key, lose control. Best practices:

- **Don't use your dev keystore as the production owner.** Generate a separate `prod-owner` wallet for production contracts.
- **Consider a multisig for high-stakes contracts.** The [simple-multisig](https://github.com/pyde-net/otigen/tree/main/examples/simple-multisig) example shows a 2-of-3 pattern. Set the multisig as the contract owner; trigger lifecycle operations via multisig proposals.
- **Test the lifecycle path on devnet first.** `otigen upgrade` against a real contract on devnet is the canonical drill.

---

## What's next

You've now seen every step of the contract lifecycle, from scaffold to kill. The remaining chapter — [Debugging](./debugging.md) — catalogs the errors you'll hit along the way and how to recover. Read it before the first time things go wrong in production.
