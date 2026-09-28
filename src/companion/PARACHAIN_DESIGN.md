# Pyde Tier 3 Extension Design: Parachains

**Version 0.3**

This is the design specification for Pyde's parachain extension within Tier 3.

Parachains are not a separate economic tier. They are an optional Tier 3 execution and coordination mechanism for workloads that the deterministic public network cannot perform directly, including foreign chain interaction, external data feeds, real world inputs, and off chain computation.

This document defines the architecture, security model, execution surface, validator participation, lifecycle, and attestation model for that extension.

**Status: future Tier 3 implementation.** The core Tier 3 network does not depend on parachains for ordinary smart contract execution or public applications. The parachain surface is designed to be introduced as an extension when the relevant use cases and security requirements are ready for deployment.

The current design locks in the `type = "parachain"` manifest schema and its validation in Otigen, the gated parachain host function namespace, the callback model that `parachain_call` extends, and the `HardFinalityCert` primitive adapters build proofs from. Sections marked **open** identify unresolved design questions rather than presenting them as solved.

> Revision note (0.2 to 0.3): parachains no longer stand up their own consensus or produce their own waves. A parachain's validators stake PYDE and attest into Pyde's security: results carry the parachain's per member aggregated FALCON attestation and post to Pyde as ordinary transactions of a dedicated result type, ordered in the DAG and dispatched deterministically. Callbacks are pull first. Outbound signing splits into three keys. This supersedes earlier revisions where they disagree.
