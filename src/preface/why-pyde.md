# Why Pyde

Pyde is the chain you'd build if you started today — with the post-quantum cryptography NIST standardized in 2024, the Mysticeti consensus Mysten Labs proved in production in 2024, and the WebAssembly runtime Fastly and Microsoft ship at scale. Nothing here is exotic. **The combination is.**

Most production chains had to pick which properties to ship first and migrate the rest later. Pyde was built greenfield to ship all of them at once — which is why this page is organized by the people who'll feel the difference, not by the layers of the stack.

- [For businesses](#for-businesses) — settlement that holds through the next cryptographic generation, no invisible tax on customer trades, predictable fees, verifiable receipts.
- [For developers](#for-developers) — familiar tools, real extensibility (build your own parachain), honest performance numbers, production-grade runtime.
- [For users](#for-users) — no sandwich attacks, sub-second confirmations, see-what-you-sign wallets, quantum-proof funds.

If you want the technical depth behind any of the claims below, the chapters that follow are where the protocol-level evidence lives. The [Whitepaper](../companion/WHITEPAPER.md) is the single-document reference; the chapters break it apart at the granularity of a working engineer.

---

## For businesses

*The properties production needs, defaulted from day one — not retrofitted to a chain holding live value.*

**Quantum-proof from genesis.**
Every other production Layer 1 — Bitcoin, Ethereum, Solana, Cardano, Sui, Aptos — secures account paths with classical cryptography that breaks the day a cryptographically-relevant quantum computer exists. NIST standardized the post-quantum replacements in 2024, but retrofitting them into a chain holding trillions in value is a multi-year coordination problem none have solved. Pyde uses FALCON-512 signatures, Kyber-768 encryption, and Poseidon2 hashing from block zero. Long-tail contracts — insurance policies, multi-year escrows, intellectual-property registries, legal records — remain cryptographically valid into the quantum era, with no migration to budget for.

**MEV protection at the protocol layer, not via a trusted relayer.**
Other chains' answer to MEV is a third-party relayer — Flashbots on Ethereum, Jito on Solana — a service businesses must opt into and trust to behave. On Pyde, MEV-sensitive transactions are encrypted under a threshold key held jointly by 128 validators. The committee commits to a canonical order *before* any decryption share is released. The information asymmetry MEV needs to exist on simply doesn't. Your users keep what they paid; you don't owe anyone a trust assumption you can't independently verify.

**Settlement in ~500 milliseconds.**
Mysticeti-style consensus reaches finality at roughly half a second median. Your customer's payment confirms before their hand leaves the mouse. On Ethereum that's 12 seconds — long enough for users to refresh, retry, or abandon. Checkout abandonment drops. Cash flow accelerates. Customer-support tickets stop being about "I paid but it didn't go through."

**Predictable fees under load.**
EIP-1559 base fee. No tips. No MEV race driving gas competition during popular drops. When an NFT mints on Ethereum, gas can 10x in 30 seconds and your unit economics break. Pyde's structural absence of MEV competition combined with the no-tip fee model keeps cost predictable. You can quote your operations team a number that's true tomorrow.

**Cryptographic receipts your auditors can verify offline.**
Every committed transaction comes with a `HardFinalityCert` — a FALCON quorum certificate signed by 85 of 128 independent validators. Your compliance team doesn't trust the chain; they verify the math. The certificate is portable: any external system that can verify FALCON signatures can verify a Pyde commitment, on or off chain.

**Run your own validator on a normal machine.**
Most high-throughput chains have made validation a premium-hosting business — Solana production validators run on 12+ cores and 256+ GB RAM, costing $20K+/month. A Pyde committee validator runs on 8 cores, 16 GB RAM, and a 500 Mbps – 1 Gbps connection. Your enterprise can verify Pyde independently without an infrastructure budget that defeats the purpose of running your own node.

---

## For developers

*Familiar tools. Honest performance. Real extensibility.*

**Write in any language that compiles to WebAssembly.**
Rust, AssemblyScript, Go (TinyGo), C, C++, Zig — anything that targets `wasm32`. No Solidity to learn. No Move. No Cairo. No proprietary VM to internalize. Your team uses the stack they already know. The `otigen` developer toolchain handles scaffolding, build, ABI generation, and deployment regardless of source language.

**Build your own parachain — a chain inside the chain.**
This is what no other production Layer 1 offers without auctioned slots or central gatekeeping. Pyde's parachain framework lets you author a WASM module that runs as its own execution environment with its own state, validated by Pyde's committee. Want to ship a privacy-first application chain? A custom VM optimized for your domain? A confidential-vote chain? An oracle network? A gaming-specific subchain with its own throughput profile? Build a parachain. Pyde validators stake PYDE to run yours; they earn the fees you set. Your parachain inherits Pyde's `HardFinalityCert`, cross-parachain messaging, security model, and threshold-encryption infrastructure for free.

This is how dev communities get built around real innovation — you bring the logic, Pyde brings the substrate. No auction. No bidding war. No "we'll consider your team in the next batch."

**Cross-parachain composability through one cryptographic primitive.**
Pyde's `HardFinalityCert` is portable. Any chain that can verify FALCON signatures can verify a Pyde commit. Your parachain talks to other parachains, to Pyde's main chain, and (post-mainnet) to external chains through a single signed certificate. No bridge multisig to trust. No oracle latency to budget for. No fragile relayer in the middle.

**Hybrid parallel execution.**
Pyde's execution layer is a uniform Block-STM scheduler: every transaction runs optimistically in parallel through an MVCC layer, conflicts are caught at validation, and losers re-execute. Wallets can attach an access list per tx as an optional prefetch hint — the chain warms its cache (PIP-3 multiget) before workers start. The hybrid Solana-+-Aptos framing was the older intermediate proposal; v1 ships uniform Block-STM with access lists as a prefetch optimisation only.

**Performance numbers you can defend in production.**
The v1 mainnet throughput target is established by a multi-region harness with real network latency before any number is published. We publish only what the harness measures under sustained, production-realistic conditions — never lab extrapolations or microbenchmark peaks. If we promise it, you can build on it.

**Runtime that already powers production at scale.**
wasmtime + Cranelift AOT — the same WebAssembly runtime Fastly serves edge functions on, Microsoft ships in Hyperlight, Shopify uses for app extensions, and the Bytecode Alliance maintains with 50+ corporate contributors. Not a homegrown VM with a 1.0 release ahead of it.

**Native session keys and programmable accounts are planned.**
v1 ships native multisig (up to 16 signers). v2 ships scoped session keys and programmable accounts at the protocol layer — not retrofitted like Ethereum's ERC-4337. Your dApp gets bounded, revocable delegation as a first-class primitive: gaming sessions, AI-agent delegation, recurring payments, all without a wallet popup per action. v1 reserves the protocol surface so contracts written today survive the v2 upgrade unchanged.

**16 concurrent transactions per account.**
Most chains lock you to one in-flight transaction per account. If one stalls, your queue stalls. Pyde maintains a 16-slot nonce window — submit up to 16 transactions concurrently per account, out of order within the window. Wallet UX, exchange settlement, and high-frequency dApps all benefit.

---

## For users

*Your transactions. Your funds. Kept yours.*

**No more sandwich attacks.**
On most chains, bots watch the mempool and trade against your transaction — buying before your swap to push the price, selling after for profit. You lose 1-5% of trade value to actors you don't know exist. Pyde encrypts your transaction's content under a threshold key held jointly by 128 validators. The order is committed before any decryption share is released. The information asymmetry MEV needs cannot structurally exist. You keep the price you signed.

**Confirmations in half a second.**
~500ms to finality at the median. Your wallet shows the result immediately. No "12 seconds and counting" spinner. No refresh-and-pray.

**Predictable fees.**
Your $5 swap costs $5 in fees. Not $5 plus $80 of MEV extraction. Not $50 because someone launched an NFT mint at the same moment.

**See exactly what you're signing — before you sign.**
Pyde wallets run your transaction locally first (deterministic wasmtime simulation) and show every state change — balances moved, contracts called, events emitted — before asking for your signature. No "approve this transaction" leap of faith. No surprise approval draining your wallet a week later.

**Quantum-proof funds.**
Your funds stay yours even when quantum hardware can break the cryptography securing Bitcoin and Ethereum. Built in from genesis, not a retrofit you have to wait for.

**Cross-chain by certificate, not by trusted bridge.**
Custodial bridge multisigs have lost over $3B since 2021. Pyde's cross-chain finality is verified cryptographically by 85+ validator signatures — math your wallet checks, not a multisig you have to trust.

---

## Where to go from here

- **Read the [Whitepaper](../companion/WHITEPAPER.md)** for the single-document technical reference (downloadable PDF at [pyde.network/whitepaper.pdf](https://pyde.network/whitepaper.pdf)).
- **Read [How Pyde Works](how-pyde-works.md)** for the high-level visual explainer.
- **Start at [Chapter 1 — Introduction](../chapters/01-introduction.md)** for the technical entry point into the chapters.
- **Browse the [Companion specs](../SUMMARY.md)** for the depth-first treatment of each subsystem.
