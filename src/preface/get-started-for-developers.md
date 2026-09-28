# Get Started: for Developers

You're here because you want to build on Pyde.

The current public development environment is Tier 3, Pyde's permissionless network. The developer surface is therefore centered on WASM smart contracts, accounts, state, the Host Function ABI, and the Otigen toolchain.

## What you can build

You can build permissionless applications and smart contracts that execute inside Pyde's deterministic WebAssembly environment.

Applications can include financial protocols, markets, games, asset systems, enterprise integrations, public registries, and other programmable economic systems.

Tier 1 and Tier 2 introduce additional execution and authorization rules around the same technical foundation. They are not separate developer products that replace the Tier 3 contract model.

## What to read

1. [Chapter 1: Introduction](../chapters/01-introduction.md) for the purpose of Pyde.
2. [Chapter 2: Architecture Overview](../chapters/02-architecture-overview.md) for the three tier model.
3. [Chapter 3: Execution Layer](../chapters/03-virtual-machine.md) for WebAssembly execution.
4. [Chapter 5: Otigen Toolchain](../chapters/05-otigen-toolchain.md) for the developer workflow.
5. [Host Function ABI](../companion/HOST_FN_ABI_SPEC.md) for the contract interface.
6. [Otigen Binary Spec](../companion/OTIGEN_BINARY_SPEC.md) for the command line surface.
7. [Otigen Test Spec](../companion/OTIGEN_TEST_SPEC.md) for contract testing.

Then read the account, state, gas, consensus, networking, and security chapters as needed.

## Languages

Pyde's public execution environment accepts WebAssembly modules.

Supported development examples include Rust, AssemblyScript, Go or TinyGo, and C or C++ where the toolchain and target produce compatible WebAssembly.

The chain sees the resulting WASM module and the declared protocol interface. It does not require developers to learn a proprietary smart contract language.

## Minimum development loop

```sh
# 1. Scaffold a project
otigen init my-app --lang rust

# 2. Build the WASM module
otigen build

# 3. Run contract tests
otigen test

# 4. Deploy to the current development environment
otigen deploy --network devnet
```

The exact commands and supported flags belong to the Otigen specifications.

## Tier aware development

The same technical foundation can appear in different Pyde network profiles.

A Tier 1 application operates under sovereign and institutional authorization. A Tier 2 settlement contract operates under the settlement and consensus rules of the interlinking network. A Tier 3 application is permissionless within the public protocol rules.

The developer should therefore distinguish:

- the contract logic;
- the protocol capability required by that logic;
- the network profile in which it is allowed to operate;
- the authorization required by that profile.
