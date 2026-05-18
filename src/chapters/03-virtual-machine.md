# Chapter 3: Virtual Machine

The Pyde Virtual Machine (PVM) is a custom register-based execution
environment with a fixed 32-bit instruction encoding and a clean separation
between scalar and wide-integer work. It is small enough to specify in a
single chapter and fast enough to drive the protocol's TPS targets.

This chapter covers the architecture, the full instruction set with gas costs,
the memory model, traps, and the AOT compiler that produces native machine
code from PVM bytecode at deploy time.

---

## 3.1 Design Principles

1. **Register-based, fixed-width.** Sixteen 64-bit GP registers and eight
   256-bit wide registers. Every instruction is exactly 32 bits.
2. **Two register files, one ISA.** Wide registers handle 256-bit token
   amounts, hashes, and signature components without bloating GP arithmetic.
3. **Trap on overflow.** Arithmetic overflows trap by default. Wrapping is
   explicit (and rare in Otigen — the language emits overflow checks at
   compile time).
4. **Static memory map.** A 4 MB address space with fixed regions for null,
   code, heap, and stack. Page allocation is gas-metered.
5. **Host-callable from native code.** Storage, crypto, and event opcodes trap
   into the host; the AOT compiler stitches host calls inline.
6. **No JIT cache.** Contracts are immutable, so they are compiled once at
   deploy time and the native function is held forever.

---

## 3.2 Register Architecture

### General-purpose registers (`r0`–`r15`)

Sixteen 64-bit registers. `r0` is hardwired to zero — writes are silently
discarded, reads always return 0.

```
+---------+--------------------------------------------------+
|         |                  64 bits                          |
+---------+--------------------------------------------------+
|   r0    | hardwired zero                                    |
|   r1    | return value / scratch                            |
|   r2    | stack pointer (SP), starts at STACK_TOP = 0x400000|
|   r3    | frame pointer (FP)                                |
| r4..r7  | function arguments                                 |
| r8..r11 | caller-saved temporaries                           |
|r12..r13 | callee-saved                                       |
|   r14   | reserved (gas counter)                             |
|   r15   | return address (RA)                                |
+---------+--------------------------------------------------+
```

The 4-bit register field in the instruction encoding leaves 18 bits for the
immediate field — large enough to fold most struct-field offsets and small
constants into a single instruction.

### Wide registers (`w0`–`w7`)

Eight 256-bit registers for crypto operations, token amounts, and large
integers. Held in a separate file so 64-bit and 256-bit math can co-exist
without forcing every operand to be 256 bits wide.

```
+--------+--------------------------------------------------+
|        |                  256 bits                         |
+--------+--------------------------------------------------+
| w0..w3 | cryptographic scratch (hashes, signatures)        |
| w4..w5 | token amounts / large integers                     |
| w6..w7 | callee-saved wide                                  |
+--------+--------------------------------------------------+
```

Wide-register operations are roughly 2–3× more expensive in gas than their
64-bit counterparts; the dispatch path explicitly traps if a wide-mode
instruction encodes a register index `>= 8`.

---

## 3.3 Instruction Encoding

```
 31      26 25    22 21    18 17                              0
+---------+--------+--------+----------------------------------+
| opcode  |   rd   |  rs1   |        rs2 / immediate           |
| (6 bit) | (4 bit)| (4 bit)|            (18 bit)              |
+---------+--------+--------+----------------------------------+
```

| Field     | Bits  | Purpose                                        |
| --------- | ----- | ---------------------------------------------- |
| `opcode`  | 6     | Operation selector (62 of 64 slots assigned)   |
| `rd`      | 4     | Destination register (`r0`–`r15` or `w0`–`w7`) |
| `rs1`     | 4     | First source register                          |
| `rs2/imm` | 18    | Second source register OR 18-bit immediate     |

For load/store instructions, the lower 2 bits of the immediate encode the
access width (00=8 bit, 01=16, 10=32, 11=64) and the upper 16 bits encode a
signed offset. `sign_extend_18()` widens 18-bit immediates to signed `i32`,
giving an immediate range of `[-131072, 131071]`.

Decoding is a fixed bit-slice — there is no variable-length parsing.

---

## 3.4 Instruction Set (62 Opcodes)

The PVM uses 62 of the 64 possible 6-bit opcode slots. Gas costs reflect the
combined CPU and constraint cost; the AOT compiler emits inline machine code
for the cheap ops and host calls for the expensive ones.

### Scalar arithmetic and logic

| Opcode | Mnemonic | Semantics                          | Gas |
| ------ | -------- | ---------------------------------- | --- |
| 0x01   | `Add`    | `rd = rs1 + rs2` (trap on overflow)| 3   |
| 0x02   | `Sub`    | `rd = rs1 - rs2` (trap on underflow)| 3  |
| 0x03   | `Mul`    | `rd = rs1 * rs2` (trap on overflow)| 5   |
| 0x04   | `Div`    | `rd = rs1 / rs2` (trap on /0)      | 8   |
| 0x05   | `Mod`    | `rd = rs1 % rs2` (trap on /0)      | 8   |
| 0x06   | `And`    | bitwise AND                         | 3   |
| 0x07   | `Or`     | bitwise OR                          | 3   |
| 0x08   | `Xor`    | bitwise XOR                         | 3   |
| 0x0E   | `Addi`   | `rd = rs1 + sign_ext(imm18)`        | 3   |
| 0x0F   | `Not`    | `rd = ~rs1`                         | 3   |
| 0x14   | `Shl`    | `rd = rs1 << rs2`                   | 3   |
| 0x15   | `Shr`    | `rd = rs1 >> rs2` (logical)         | 3   |
| 0x16   | `Sar`    | `rd = rs1 >> rs2` (arithmetic)      | 3   |
| 0x17   | `Lt`     | `rd = (rs1 < rs2) ? 1 : 0`          | 3   |
| 0x33   | `Gt`     | `rd = (rs1 > rs2) ? 1 : 0`          | 3   |
| 0x34   | `Eq`     | `rd = (rs1 == rs2) ? 1 : 0`         | 3   |
| 0x35   | `Slt`    | signed less-than                    | 3   |
| 0x36   | `Sgt`    | signed greater-than                 | 3   |

### Wide (256-bit) arithmetic and logic

| Opcode | Mnemonic | Semantics                          | Gas |
| ------ | -------- | ---------------------------------- | --- |
| 0x09   | `Wadd`   | 256-bit add                         | 6   |
| 0x0A   | `Wsub`   | 256-bit sub                         | 6   |
| 0x0B   | `Wmul`   | 256-bit mul                         | 15  |
| 0x0C   | `Wdiv`   | 256-bit div                         | 15  |
| 0x0D   | `Wmod`   | 256-bit mod                         | 15  |
| 0x1F   | `Wnot`   | 256-bit bitwise NOT                 | 4   |
| 0x2D   | `Wand`   | 256-bit AND                         | 4   |
| 0x2E   | `Wor`    | 256-bit OR                          | 4   |
| 0x2F   | `Wxor`   | 256-bit XOR                         | 4   |
| 0x3A   | `Wshift` | 256-bit shift; amount from `gp[imm&0xF]`| 4   |
| 0x00   | `Weq`    | 256-bit equality, result -> GP      | 4   |
| 0x3F   | `Wlt`    | 256-bit less-than, result -> GP     | 4   |

### Memory

| Opcode | Mnemonic | Semantics                                                      | Gas |
| ------ | -------- | -------------------------------------------------------------- | --- |
| 0x10   | `Load`   | `rd = mem[rs1 + offset:width]` (width from imm low 2 bits)     | 5   |
| 0x11   | `Store`  | `mem[rs1 + offset:width] = rd`                                 | 5   |
| 0x12   | `Push`   | `SP -= 8; mem[SP] = rd`                                         | 5   |
| 0x13   | `Pop`    | `rd = mem[SP]; SP += 8`                                         | 5   |
| 0x37   | `Wload`  | `wd = mem256[rs1]`                                              | 8   |
| 0x3B   | `Wstore` | `mem256[rs1] = ws1`                                             | 8   |
| 0x3C   | `Wmov`   | `wd = ws1`                                                      | 3   |
| 0x3D   | `Narrow` | `rd = lower64(ws1)` (trap if ws1 > u64::MAX)                    | 3   |
| 0x3E   | `Widen`  | `wd = zero_extend(rs1)`                                         | 3   |
| 0x39   | `Memcpy` | copy `gp[imm&0xF]` bytes from `mem[gp[rs1]]` to `mem[gp[rd]]`   | 5 + 3/8B |

`Memcpy` is the bulk-copy primitive; without it, contracts would emit long
chains of 64-bit `Store`s for every buffer copy.

### Control flow

| Opcode | Mnemonic | Semantics                                   | Gas |
| ------ | -------- | ------------------------------------------- | --- |
| 0x18   | `Jmp`    | `PC = imm` (absolute)                       | 3   |
| 0x19   | `Beq`    | branch if `rs1 == rs2`                      | 3   |
| 0x1A   | `Bne`    | branch if `rs1 != rs2`                      | 3   |
| 0x1B   | `Blt`    | branch if `rs1 < rs2`                       | 3   |
| 0x1C   | `Bge`    | branch if `rs1 >= rs2`                      | 3   |
| 0x1D   | `Call`   | push `PC+4` to RA; `PC = imm`               | 50  |
| 0x1E   | `Ret`    | `PC = RA`; restore frame                    | 5   |

`Call` carries a higher gas cost because the AOT compiler emits a frame setup
(saved registers, FP/SP adjustment) at each call site.

### Blockchain syscalls

| Opcode | Mnemonic       | Semantics                                       | Gas      |
| ------ | -------------- | ----------------------------------------------- | -------- |
| 0x20   | `Sload`        | `rd = storage[rs1]` (warm)                       | 100      |
| 0x21   | `Sstore`       | `storage[rs1] = rd` (warm)                       | 200      |
| 0x22   | `Sdelete`      | delete `storage[rs1]`                            | 200      |
| 0x23   | `Caller`       | `rd = msg.sender`                                | 5        |
| 0x24   | `Callvalue`    | `wd = msg.value` (256-bit)                        | 5        |
| 0x25   | `Blockhash`    | `wd = block_hash[rs1]`                            | 20       |
| 0x26   | `CallExt`      | call external contract                            | 2,500    |
| 0x27   | `Delegate`     | delegatecall                                      | 2,500    |
| 0x28   | `Create`       | deploy contract; `rd = new_address`               | 32,000   |
| 0x29   | `Selfdestruct` | destroy contract, send balance to `rd`            | 5,000    |
| 0x2A   | `Log`          | emit event (topic in `rs1`, data ptr in `rs2`)    | 375 + 8/B|
| 0x2B   | `Revert`       | abort with returndata `[rs1..rs1+rs2]`            | 3        |
| 0x2C   | `Halt`         | successful execution stop                         | 3        |

### Crypto syscalls

| Opcode | Mnemonic        | Semantics                                       | Gas      |
| ------ | --------------- | ----------------------------------------------- | -------- |
| 0x30   | `Poseidon`      | `wd = poseidon2_hash(mem[rs1..rs1+rs2])`         | 1,000 + 6 / 32B |
| 0x31   | `VerifySig`     | `rd = falcon_verify(msg, sig, pubkey)`           | 20,000   |
| 0x32   | `MerkleVerify`  | `rd = merkle_verify(root, leaf, path)`           | 5,000    |

`VerifySig` at 20,000 gas reflects the cost of one FALCON-512 signature
verification; `Poseidon` at 1,000 base gas plus 6 per additional 32-byte
chunk reflects the sponge structure of Poseidon2 over the Goldilocks field.

### Misc

| Opcode | Mnemonic | Semantics                                       | Gas |
| ------ | -------- | ----------------------------------------------- | --- |
| 0x38   | `Assert` | trap if `rs1 == 0` (used for compiler-emitted checks) | 3   |

Two opcode slots remain reserved for future extensions.

---

## 3.5 Memory Model

Each transaction execution gets a 4 MB address space, divided into four
regions:

```
0x000000 - 0x000FFF  (4 KB)    null page         traps on any access
0x001000 - 0x00FFFF  (60 KB)   code              read-only, loaded at boot
0x010000 - ...       (varies)  heap              grows upward
                  ...
       ... - 0x3FFFFF (varies) stack             grows downward from STACK_TOP
```

Constants (in `crates/pvm/src/memory.rs`):

| Name              | Value            | Meaning                              |
| ----------------- | ---------------- | ------------------------------------ |
| Total size        | 0x400000 (4 MB)  | hard ceiling for the address space   |
| Page size         | 4 KB             | allocation granularity               |
| `PAGE_ALLOC_GAS`  | 200              | charged on first touch of a new page |
| `NULL_PAGE_END`   | 0x1000           | reads/writes below this trap         |
| `CODE_START`      | 0x1000           | bytecode load base                   |
| `CODE_END`        | 0x10000          | maximum 60 KB of code                |
| `HEAP_START`      | 0x10000          | initial heap base                    |
| `STACK_TOP`       | 0x400000         | initial stack top (exclusive)        |

The stack and heap grow toward each other; if they collide, execution traps
with `MemoryFault`. Per-page allocation gas means small contracts don't pay
for memory they never touch.

### Memory layout for dynamic types

Otigen lays out dynamic types using a **header on stack, data on heap**
pattern:

- `Vec<T>` is a 24-byte stack header `(ptr, len, capacity)` with elements on
  the heap. `push` past capacity allocates a new heap block of `2 * capacity`
  slots, copies the elements, and abandons the old block (no GC; the
  transaction's bump allocator clears at the end).
- `String` is `Vec<u8>` plus a UTF-8 invariant (validated at construction).
- `Map<K,V>` is **storage-only** — it doesn't live in linear memory. Reads
  and writes lower to `Sload`/`Sstore` against
  `Poseidon2(contract_addr, Poseidon2(slot, key))`.

---

## 3.6 Trap Conditions

A trap immediately reverts the current execution context. Pyde defines these
trap kinds:

| Trap                    | When it fires                                       |
| ----------------------- | --------------------------------------------------- |
| `Overflow`              | arithmetic overflow on `Add`/`Sub`/`Mul`/`Wadd`/... |
| `Underflow`             | arithmetic underflow                                |
| `DivisionByZero`        | division or modulo by zero                          |
| `InvalidOpcode`         | unrecognized opcode bits OR wide register `>= 8`    |
| `NarrowOverflow`        | `Narrow` instruction with value `> u64::MAX`        |
| `MemoryFault`           | null page, OOB, code-write, heap/stack collision    |
| `StackOverflow`         | call stack depth exceeded                           |
| `StackUnderflow`        | `Ret` without matching `Call`                        |
| `OutOfGas`              | gas exhausted mid-execution                         |
| `StaticModeViolation`   | state mutation in a static-call context             |
| `Reentrancy`            | reentrancy guard fired                              |
| `AccessListViolation`   | storage slot accessed outside the access list       |

Note the post-audit hardening on wide-register decode: `read_wide_checked()`
and `write_wide_checked()` trap on indices `>= 8` instead of silently masking
them, so a malicious encoded instruction can't smuggle aliased writes through
the dispatcher.

`AccessListViolation` is what drives one half of Pyde's hybrid parallel
execution model. The scheduler builds the conflict graph from
compile-time-inferred access lists for functions whose access pattern is
statically known (Solana-style); a transaction that touches an undeclared
slot traps cleanly, so parallel execution stays correct.

For functions with dynamic access patterns (e.g. cross-contract calls into
unknown callees), the scheduler falls back to **Block-STM speculation**
(Aptos-style): transactions execute optimistically in parallel, conflicts
are detected via read/write sets, and conflicting txs are re-executed.

Most contracts hit the static path. The fallback exists because forcing
every contract to predeclare exhaustive access lists would either reject
useful patterns or balloon access-list size. See `docs/DESIGN.md` for the
full scheduler specification.

---

## 3.7 AOT Compiler (Cranelift)

Contracts are deployed as PVM bytecode. The AOT compiler translates that
bytecode into native x86-64 (or ARM64) machine code at deploy time using
Cranelift. The compiled function is held in memory for the lifetime of the
process — no warm-up, no runtime recompilation.

### Pipeline

```
PVM bytecode
    |
    v
+-------------------+      +-------------------+      +--------------+
| Analyze            |  ->  | Codegen            |  ->  | Native func  |
| (basic blocks +    |      | (Cranelift IR ->   |      | (x86-64 /    |
|  control-flow)     |      |  machine code)     |      |  ARM64)      |
+-------------------+      +-------------------+      +--------------+
                                |
                                v
                          opt_level = "speed"
                          gas accounting inlined
                          host calls registered as JIT symbols
```

The compiled main entry has the signature:

```
fn(regs: *mut u64, gas_limit: u64, vm_ctx: *mut Vm) -> u64
```

The return value packs `(gas_used << 2) | status_code`:

| Status code        | Meaning                |
| ------------------ | ---------------------- |
| `0x0`              | Success                |
| `0x1`              | Revert (returndata)    |
| `0x2`              | Out-of-gas             |
| `u64::MAX`         | Hard trap              |

### What's compiled vs. what trampolines to host

Cheap, side-effect-free opcodes are compiled inline:

- All scalar and wide ALU ops, branches, `Call`/`Ret` (frame setup), and
  memory ops (`Load`, `Store`, `Push`, `Pop`, `Wload`, `Wstore`).

State, crypto, and event opcodes call out to host functions registered with
the JIT module:

- Storage: `host_sload`, `host_sstore`, `host_sdelete`, plus GP/wide variants.
- Crypto: `host_poseidon`, `host_verify_sig`, `host_merkle_verify`.
- Events: `host_log`.
- Environment: `host_caller`, `host_callvalue`, `host_blockhash`.
- Cross-contract: `CallExt`, `Delegate`, `Create` fall back to the
  interpreter through `host_exec_opcode` (these involve nested VM
  invocations whose lifetime crosses the JITed function boundary).

Host functions return `0` on success and `1` on a recoverable error
(memory fault, invalid register, storage failure); the JITed code branches to
its trap handler when a host call returns non-zero. A post-audit fix in
`host_push` propagates the underlying store error instead of silently
swallowing it — a stack push that hit a memory fault now traps cleanly.

### Why no JIT cache?

Contracts are immutable after deployment. There is no warm-up tier, no
"hot path" inlining, no inline-cache invalidation. Compile once at deploy,
hold the function pointer forever. This makes execution behavior fully
deterministic across nodes (every validator runs the same machine code,
because Cranelift's output is deterministic for a given input bytecode and
target).

---

## 3.8 Why This VM, Not the EVM or RISC-V

The PVM is small, fixed-width, and tuned for the workload Pyde actually has:
parallel execution of typed smart-contract calls touching declared storage
slots.

| Dimension              | PVM                       | EVM                       | RISC-V (RV64GC)         |
| ---------------------- | ------------------------- | ------------------------- | ----------------------- |
| Architecture           | register                  | stack                     | register                |
| Instruction count      | 62                        | 140+                      | 200+                    |
| Instruction width      | fixed 32-bit              | variable 1–33 bytes       | variable 16/32-bit      |
| Native hash            | Poseidon2                 | Keccak                    | (none, library)         |
| Word size              | 64-bit + separate 256-bit | 256-bit only              | 64-bit only             |
| Memory model           | Linear, gas-metered pages | Word-addressed expanding  | Linear, OS-style        |
| Reentrancy             | Guard at language level   | Caller's responsibility   | N/A (general purpose)   |

The dual register file matters: keeping a 64-bit loop counter in a 64-bit
register avoids inflating every counter increment to 256-bit math. Wide
registers exist precisely for the operations that genuinely need 256 bits
(token amounts, hash outputs, signature components).

---

## Summary

| Property                  | Value                                          |
| ------------------------- | ---------------------------------------------- |
| Register files            | 16 × 64-bit GP, 8 × 256-bit wide               |
| Instruction width         | Fixed 32-bit                                   |
| Opcodes assigned          | 62 of 64                                       |
| Address space             | 4 MB (null / code / heap / stack)              |
| Page size / alloc gas     | 4 KB / 200 gas per first-touch page            |
| Max code size             | 60 KB (CODE_START to CODE_END)                 |
| Native hash               | Poseidon2 (Goldilocks field)                   |
| Trap kinds                | 12 (overflow, fault, OOG, reentrancy, ...)     |
| Execution backends        | Interpreter (canonical) + Cranelift AOT (prod) |
| AOT recompilation         | None — compile-once at deploy                  |

The next chapter covers the state model: the JMT (Jellyfish Merkle Tree) that
holds every account, the witness format that drives parallel execution, and
how Poseidon2 ties it all together.
