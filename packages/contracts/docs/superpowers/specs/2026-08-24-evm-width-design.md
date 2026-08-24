# evm-width — measuring whether a contract is actually parallel

**Status:** design approved, not yet implemented
**Date:** 2026-08-24

## The problem

Parallel EVMs — Monad, Sei, MegaETH, Rise, and Block-STM forks of reth — schedule
optimistically: transactions run concurrently and re-execute when another
transaction invalidates their read set. Whether that helps is decided entirely by
the workload's **conflict graph**. Two transactions conflict when one writes a slot
the other reads or writes. Colour that graph and the number of colours is the
number of sequential **rounds**; **width = txs / rounds** is the ceiling on
concurrency any optimistic scheduler could extract.

Nobody can currently measure this. Foundry has no conflict analysis. So every
parallel-chain ecosystem sells throughput that depends on apps being width > 1,
while most deployed contracts are width 1.00× — a single global counter, a pool's
reserves, a hot treasury — and no one finds out until mainnet.

This project measures it.

The motivating evidence is in `docs/PARALLELISM.md`, all of it reproduced locally
for $0: `market.matchTick` colours into one round (19.00×) where `naive.place`
needs nineteen (1.00×); the same `place()` from a *single sender* is also 1.00×,
which means a one-key benchmark is structurally incapable of showing parallelism;
and FlashGrid's `settleTick` drops from 19.00× to 1.00× the moment one trader
quotes across the book, because it credits `balances[order.maker]` rather than a
tick-keyed slot.

## Non-goals

- **Predicting latency.** Width is a ceiling. It converts to wall-clock speedup
  only once execution, rather than block time or consensus, is the binding
  constraint — and our own multi-sender run never left the consensus-bound regime.
  The tool reports width and refuses to translate it into a speed number.
- **Static analysis of bytecode.** Mapping keys resolve at runtime;
  `balance[msg.sender]` versus `yesPos[tick][maker]` is exactly the distinction
  that matters and exactly what static analysis cannot see.
- **Optimal graph colouring.** NP-hard, and the wrong risk to take (see below).
- **Being a general profiler.** Storage conflicts only.

## Architecture

Three layers, each independently testable.

### 1. Core — pure, no I/O

```
colour(accesses: AccessSet[]) -> { rounds, width, roundOf }

// roundOf maps each tx id to its colour, so a caller can show WHICH
// transactions were forced apart rather than only how many rounds there were.

AccessSet = {
  tx:     string          // hash or synthetic id
  sender: string          // address, for the nonce constraint
  reads:  Set<SlotKey>
  writes: Set<SlotKey>
}

SlotKey = `${address}:${slot}`   // account-qualified, never bare slot
```

Slots are **account-qualified**. Colouring per-contract would make a shared token
or oracle vanish from the graph, which is the most likely way this tool would
quietly lie.

The conflict rule is the standard one: `i` and `j` conflict when
`writes(i) ∩ writes(j)`, `writes(i) ∩ reads(j)`, or `writes(j) ∩ reads(i)` is
non-empty. Shared *reads* are free — that is the entire basis of optimistic
concurrency, and getting it wrong would understate every well-designed contract.

This is a direct port of `packages/contracts/test/ConflictHarness.sol`, which stays
in the repo as the differential oracle.

### 2. Adapters — one interface, `() -> AccessSet[]`

**`trace` (primary).** Any RPC exposing `debug_traceTransaction` with
`prestateTracer`. Verified against anvil on 2026-08-24:

| call | returns |
| --- | --- |
| `diffMode: false` | every slot **touched** (reads ∪ writes) |
| `diffMode: true` | `post` = every slot **written** |

so **`reads = touched − writes`**, exactly the two sets the rule needs. Two trace
calls per transaction. Needs no source code and no test modification, and therefore
works on contracts we do not own — which is what makes the leaderboard possible at
all. Possible is not the same as built: the capability lands with this adapter, the
leaderboard itself is sequenced last because it is worthless before milestone 2.

**`foundry` (secondary).** The existing `vm.record()` harness, for the
*design-time* question: what would width be if I shipped this? Answers before any
traffic exists. Deliberately secondary: it requires source and authored workloads,
so it will never be the surface most people touch.

### 3. Surfaces

| order | surface | purpose |
| --- | --- | --- |
| 1 | `width block <n>` / `width range <a>..<b>` | replay real blocks, report width |
| 2 | `width check --min <x>` | CI gate; non-zero exit on regression |
| 3 | leaderboard | score deployed contracts by width |

The CI gate is where recurring value lives: width is invisible until mainnet, which
is precisely what makes it worth a regression test.

## Correctness decisions

**Greedy colouring, and it is a lower bound.** Optimal colouring is NP-hard. Greedy
may use *more* rounds than necessary, so reported width is **conservative** — it
under-claims. For a tool whose entire pitch is that other people's benchmarks
over-claim, erring toward under-claiming is the only defensible direction. The
output says so.

**Width is reported twice.** EVM account nonces strictly serialise one account's
transactions regardless of contract design. So every report carries:

- `stateWidth` — from storage conflicts alone
- `effectiveWidth` — after additionally conflicting any two transactions from the
  same sender

Reporting only the first would repeat, in a tool, the exact error caught in our own
benchmark: a single-sender workload scoring 19×.

**Reverted transactions are included, flagged.** A revert still consumed a slot in
the scheduler and still forced re-execution. Excluding them would flatter the
number.

## Stated limitations

Printed in the tool's own output, not buried in a README:

1. Width is a ceiling, not a speedup. It says what a scheduler *could* extract.
2. Measured traffic is not possible traffic. A quiet week scores as parallel even
   for a contract that would collapse under load.
3. Greedy colouring under-reports.

## Testing

- **Core:** unit tests over hand-built graphs, including colourings where greedy is
  known to be suboptimal, so the lower-bound claim is tested rather than asserted.
- **Differential:** the TypeScript core and `ConflictHarness.sol` must agree on the
  same workload. They share no code, which makes this a genuinely strong check.
- **Adapter:** anvil fixtures, free and deterministic, via `scripts/local-bench.sh`.
- **Regression fixtures with known answers**, taken from `docs/PARALLELISM.md`:
  `matchTick` 19.00×, `naive.place` 1.00×, single-sender `place` 1.00×,
  FlashGrid `settleTick` 19.00× disjoint / 1.00× shared-maker.

That last set matters: the tool must independently reproduce findings we already
established by another method. If it cannot, the tool is wrong.

## Layout

`packages/width` in this monorepo. The regression fixtures, the Solidity oracle and
the anvil harness already live here, and splitting the repo before the tool has a
user would cost more than it buys. Published as `evm-width`, CLI binary `width`.
Extractable later; nothing in the design depends on staying.

## Milestones

The implementation plan that follows this spec covers **milestone 1 only**. The
later milestones are recorded here so the boundaries are deliberate, and each gets
its own plan when it is reached.

1. **Core + trace adapter + `width block`.** Reproduces every fixture above against
   local anvil. This is the milestone that proves the thesis.
2. **Real chain.** Point at Monad. Needs a trace-enabled endpoint — the public one
   rate-limits well before a block range finishes.
3. **CI gate.** `width check`, plus a GitHub Action.
4. **Leaderboard.** Only after 2, since it is entirely downstream of trace access.

## Risks

- **Trace availability.** `debug_traceTransaction` is often disabled on public
  endpoints. Milestone 2 is gated on access we do not yet have. Milestone 1 is not,
  which is why it comes first.
- **Trace cost at range scale.** Two calls per transaction over a block range is
  heavy. Mitigation is caching by tx hash; if that proves insufficient the range
  command gets a sampling mode that reports what it sampled.
- **Adoption.** A measurement nobody is required to look at gets looked at by
  nobody. The CI gate is the answer, which is why it is milestone 3 rather than a
  later nice-to-have.
- **The finding may be unwelcome.** If most contracts on a chain score 1.00×, that
  is a true result about that chain. Publishing it is the point.
