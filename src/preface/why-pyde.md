# Why Pyde

Pyde is the chain you'd build if you started today, with proven consensus, a WebAssembly runtime that already runs at scale, and a handful of properties most chains can only add later. Nothing here is exotic. **The combination is.**

Most production chains had to pick which properties to ship first and migrate the rest later. Pyde was built greenfield to ship all of them at once, which is why this page is organized by the people who'll feel the difference, not by the layers of the stack.

- [For businesses](#for-businesses): settlement that holds through the next cryptographic generation, no invisible tax on customer trades, predictable fees, verifiable receipts.
- [For developers](#for-developers): familiar tools, real extensibility (build your own parachain), honest performance numbers, production-grade runtime.
- [For users](#for-users): no sandwich attacks, sub-second confirmations, see-what-you-sign wallets, self-custody kept yours.

If you want the technical depth behind any of the claims below, the chapters that follow are where the protocol-level evidence lives. The [Whitepaper](../companion/WHITEPAPER.md) is the single-document reference; the chapters break it apart at the granularity of a working engineer.

---

## For businesses

*The properties production needs, defaulted from day one, not retrofitted onto a chain already holding live value.*

**Fair ordering, without a trusted relayer.**
On many chains the answer to MEV is a third-party relayer you opt into and trust to behave. On Pyde, ordering is settled by a keyless commit-reveal mempool: a user commits to a transaction as a Blake3 hash, the DAG fixes its order *before* the content is revealed, and the revealed transactions execute in that committed order. No committee holds a decryption key, so there is no trusted party left to fail. Your users keep what they paid, and you don't owe anyone a trust assumption you can't check for yourself.

**Settlement in ~500 milliseconds.**
Mysticeti-style consensus reaches finality at roughly half a second in the median. Your customer's payment confirms before their hand leaves the mouse, so checkout abandonment drops, cash flow accelerates, and support tickets stop being about payments that seemed to vanish.

**Predictable fees under load.**
EIP-1559 base fee, no tips, and no MEV race driving gas competition during popular moments. Because that competition is structurally absent, cost stays predictable even under load. You can quote your operations team a number that's still true tomorrow.

**Cryptographic receipts your auditors can verify offline.**
Every committed transaction comes with a `HardFinalityCert`: a quorum certificate signed by at least 86 of 128 independent validators. Your compliance team doesn't trust the chain; they verify the math. The certificate is portable, so any external system that can check the signatures can verify a Pyde commitment, on or off chain.

**Security that outlives quantum computers.**
Most chains today secure accounts with cryptography that a quantum computer will eventually break, and retrofitting the standardized replacements into a chain already holding value is a hard, multi-year coordination problem. Pyde simply starts there: FALCON-512 signatures and Blake3 + Poseidon2 hashing on every consensus and account path from genesis, with Kyber-768 / ML-KEM securing transport-layer session keys. Long-lived records such as insurance policies, multi-year escrows, and legal registries are signed once and stay valid for the decades they are meant to last. There is nothing to migrate.

**Run your own validator on a normal machine.**
Some high-throughput chains have quietly turned validation into a premium hosting business, with production nodes that need many cores, hundreds of gigabytes of RAM, and a bill to match. A Pyde committee validator runs on 8 cores, 16 GB of RAM, and a 500 Mbps to 1 Gbps connection, so your business can verify Pyde independently without an infrastructure budget that defeats the purpose of running your own node.

---

## For developers

*Familiar tools. Honest performance. Real extensibility.*

**Write in any language that compiles to WebAssembly.**
Rust, AssemblyScript, Go (TinyGo), C, C++, Zig, or anything else that targets `wasm32`. No new smart-contract language to learn and no proprietary VM to internalize. Your team uses the stack they already know. The `otigen` developer toolchain handles scaffolding, build, ABI generation, and deployment regardless of source language.

**Build your own parachain: a chain inside the chain, and Pyde's bridge to everything outside it.**
This is what no other production Layer 1 offers without auctioned slots or central gatekeeping. A Pyde parachain is a small decentralized network you author: a deterministic WASM module plus your own relay backend, running as its own execution environment with its own staked validators and its own working state, attesting every result into Pyde's security as an ordinary ordered transaction. Want to ship an oracle network? An adapter that lets Pyde contracts drive actions on another chain through its light client? A price feed? A confidential-vote chain? A gaming-specific subchain with its own throughput profile? Build a parachain. Operators anywhere stake PYDE to run yours (no whitelist, no committee prerequisite) and earn the fees you set. Your parachain inherits Pyde's `HardFinalityCert`, cross-parachain messaging, security model, and keyless commit-reveal MEV protection for free.

This is how dev communities get built around real innovation: you bring the logic, Pyde brings the substrate. No auction. No bidding war. No "we'll consider your team in the next batch."

**Cross-parachain composability through one cryptographic primitive.**
Pyde's `HardFinalityCert` is portable. Any chain that can verify FALCON signatures can verify a Pyde commit. Your parachain talks to other parachains, to Pyde's main chain, and (post-mainnet) to external chains through a single signed certificate. No bridge multisig to trust. No oracle latency to budget for. No fragile relayer in the middle.

**Parallel execution by default.**
Pyde's execution layer is a uniform Block-STM scheduler: every transaction runs optimistically in parallel through an MVCC layer, conflicts are caught at validation, and losers re-execute. Wallets can attach an access list per tx as an optional prefetch hint, so the chain warms its cache (PIP-3 multiget) before workers start. The access list is a prefetch optimisation only, never used to partition the wave or affect correctness.

**Performance numbers you can defend in production.**
The v1 mainnet throughput target is established by a multi-region harness with real network latency before any number is published. We publish only what the harness measures under sustained, production-realistic conditions, never lab extrapolations or microbenchmark peaks. If we promise it, you can build on it.

**Runtime that already powers production at scale.**
wasmtime + Cranelift AOT: the same WebAssembly runtime Fastly serves edge functions on, Microsoft ships in Hyperlight, Shopify uses for app extensions, and the Bytecode Alliance maintains with 50+ corporate contributors. Not a homegrown VM with a 1.0 release ahead of it.

**Native session keys and programmable accounts are planned.**
v1 ships native multisig (up to 16 signers). v2 adds scoped session keys and programmable accounts at the protocol layer, designed in rather than retrofitted onto it. Your dApp gets bounded, revocable delegation as a first-class primitive: gaming sessions, AI-agent delegation, recurring payments, all without a wallet popup per action. v1 reserves the protocol surface so contracts written today survive the v2 upgrade unchanged.

**16 concurrent transactions per account.**
Most chains lock you to one in-flight transaction per account. If one stalls, your queue stalls. Pyde maintains a 16-slot nonce window: submit up to 16 transactions concurrently per account, out of order within the window. Wallet UX, exchange settlement, and high-frequency dApps all benefit.

---

## For users

*Your transactions. Your funds. Kept yours.*

**No more sandwich attacks.**
On most chains, bots watch the mempool and trade against your transaction, buying before your swap to push the price and selling after for profit. Pyde hides your transaction behind a Blake3 commitment in a keyless commit-reveal mempool, and its order is fixed before the content is ever revealed. No validator can read it while ordering it, and no committee holds a key that could. You keep the price you signed.

**Confirmations in half a second.**
About half a second to finality in the median. Your wallet shows the result right away, with no long spinner and no refresh-and-pray.

**Predictable fees.**
Your $5 swap costs $5 in fees. Not $5 plus $80 of MEV extraction. Not $50 because someone launched an NFT mint at the same moment.

**See exactly what you're signing, before you sign.**
Pyde wallets run your transaction locally first (deterministic wasmtime simulation) and show every state change (balances moved, contracts called, events emitted) before asking for your signature. No "approve this transaction" leap of faith. No surprise approval draining your wallet a week later.

**Lose a key, not your account.**
Account security is a protocol mode, not a contract you deploy yourself. Native multisig means a single leaked key can't move your funds on its own, and recovery is built into the protocol rather than bolted on afterward.

**Cross-chain by certificate, not by trusted bridge.**
Bridges built on trusted multisigs have a long history of painful failures. Pyde verifies cross-chain finality cryptographically, through validator signatures your wallet can check for itself, not a multisig you have to trust.

---

## Where to go from here

- **Read the [Whitepaper](../companion/WHITEPAPER.md)** for the single-document technical reference (downloadable PDF at [pyde.network/whitepaper.pdf](https://pyde.network/whitepaper.pdf)).
- **Read [How Pyde Works](how-pyde-works.md)** for the high-level visual explainer.
- **Start at [Chapter 1: Introduction](../chapters/01-introduction.md)** for the technical entry point into the chapters.
- **Browse the [Companion specs](../SUMMARY.md)** for the depth-first treatment of each subsystem.
