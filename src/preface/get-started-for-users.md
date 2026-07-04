# Get Started — for Users

You're not here to write contracts. You want to *use* Pyde — hold
PYDE, send a transaction, run a node, or follow the project's path to
mainnet. This page is your map.

---

## What's different about Pyde

Three things, in plain language:

### 1. It survives the quantum era

Every signature on Pyde uses **FALCON-512**, a NIST-standardised
post-quantum signature scheme. Every encryption uses **Kyber-768
(ML-KEM)**, NIST's post-quantum key-encapsulation scheme.

Translation: when a quantum computer powerful enough to break Bitcoin
+ Ethereum signatures shows up, Pyde keeps working. There is no
migration window because there's no ECDSA legacy to migrate away from.

Read more: [Chapter 8 — Cryptography](../chapters/08-cryptography.md).

### 2. Front-running is structurally impossible

On most chains, the order of transactions inside a block is decided
by whoever proposes the block — and that ordering is profitable. MEV
bots pay validators to insert their trade in front of yours, drain
your slippage, and move on.

Pyde encrypts transactions in the mempool with a key only the
committee collectively holds. The committee commits to an order
**before** any decryption share is released. By the time anyone can
read what's inside a transaction, the ordering is already final.
There is no profitable front-run because there's no information to
front-run on.

Read more: [Chapter 9 — MEV Protection](../chapters/09-mev-protection.md).

### 3. Your account doesn't die when one key leaks

Native multisig is a protocol feature, not a contract every wallet
re-implements. Lose a key, the rest of the keys still control the
account. Coming post-mainnet: programmable accounts with spend
limits, time locks, social recovery, and per-app session keys that
can be revoked at any time.

Read more: [Chapter 11 — Account Model](../chapters/11-account-model.md).

---

## Honest status (today)

Pyde is **pre-mainnet**. That means:

| What | When |
|---|---|
| Read the spec | ✅ Now (this book) |
| Open a wallet / acquire PYDE | ❌ Mainnet |
| Send a transaction | ❌ Mainnet (testnet earlier) |
| Run a validator | ❌ Mainnet |
| Run a full node | ❌ Mainnet (devnet earlier) |
| Follow the project | ✅ Now |

The sections below track the path from "pre-mainnet engineering" to
"mainnet live".

---

## What you can do right now

1. **Read the [whitepaper](../companion/WHITEPAPER.md).** 30 minutes;
   covers everything at a digestible depth.
2. **Follow the [launch plan](../chapters/19-launch-strategy.md).**
   Phased to mainnet — no calendar dates; each phase ships when its
   bar is met.
3. **Join [Telegram](https://t.me/pydenet)** for project chat.
4. **Follow [@pydenet on X](https://x.com/pydenet)** for milestone
   announcements.
5. **Watch the [GitHub org](https://github.com/pyde-net)** if you want
   to see the work as it lands.

---

## When mainnet ships

You'll do the things you'd do on any L1, with two structural
differences:

- **Your address is 32 bytes** (`0x` + 64 hex chars). Pyde doesn't
  truncate addresses the way Ethereum does. You'll see this in any
  Pyde-native wallet.
- **Your account survives single-key compromise** if you set up
  native multisig at registration. The wallet UX will surface this
  as the default for non-trivial balances.

Gas works like Ethereum's EIP-1559 (no priority fees on Pyde —
inclusion order isn't biddable), and the chain commits a wave every
~500 ms. Transactions land fast and final.

---

## Where to follow along

- **[Launch Strategy](../chapters/19-launch-strategy.md)** — the phased path to mainnet.
- **[GitHub org](https://github.com/pyde-net)** — every repo, every commit.
- **[Telegram](https://t.me/pydenet)** — community chat.
- **[X (@pydenet)](https://x.com/pydenet)** — milestone announcements.
- **`info@pyde.network`** — formal contact.

Welcome to the pre-mainnet phase. It's the most honest place to be.
