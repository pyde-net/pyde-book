# Pyde Documentation

This directory contains repository level documentation for the Pyde project.

The canonical technical reference is the [Pyde Book](../src/SUMMARY.md), which defines the current three tier architecture and links to the detailed protocol specifications.

## Current architecture

Pyde is distributed ledger infrastructure for a connected global economy.

| Tier   | Role                          |
| ------ | ----------------------------- |
| Tier 1 | Sovereign economic networks   |
| Tier 2 | Open interlinking settlement  |
| Tier 3 | Permissionless public network |

The current public development environment is Tier 3. Tier 1 and Tier 2 are architectural systems that require additional engineering, security review, institutional integration, and deployment specific work.

## Technical references

| Document                                                           | Purpose                                          |
| ------------------------------------------------------------------ | ------------------------------------------------ |
| [Whitepaper](../src/companion/WHITEPAPER.md)                       | Current economic and protocol architecture       |
| [Architecture Design](../src/companion/DESIGN.md)                  | Detailed technical design                        |
| [Threat Model](../src/companion/THREAT_MODEL.md)                   | Security assumptions and mitigations             |
| [Failure Scenarios](../src/companion/FAILURE_SCENARIOS.md)         | Failure analysis and recovery scenarios          |
| [Validator Lifecycle](../src/companion/VALIDATOR_LIFECYCLE.md)     | Validator state and operations                   |
| [Parachain Extension Design](../src/companion/PARACHAIN_DESIGN.md) | Optional Tier 3 external capability architecture |

## Deployment documentation

Deployment specific and operational material is maintained under the [validator documentation](../src/validator/) and repository deployment notes.

This directory should not be treated as a second source of truth for the protocol architecture. The Pyde Book and its companion specifications define the technical documentation set.
