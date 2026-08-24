# Does parallel execution actually help?

Everything here is measured. Nothing is quoted from a landing page, including our own.

## How to reproduce, for free

```bash
# the mechanism -- no chain, no money, deterministic
cd packages/contracts
forge test --mc ConflictTest  -vv    # our design
forge test --mc CrossBenchTest -vv   # gas parity + FlashGrid, same instrument

# the end-to-end harness, against a local anvil -- still free
./scripts/local-bench.sh
```

`vm.record()` / `vm.accesses()` report the exact storage slots a call read and
wrote. Two transactions conflict when one writes a slot the other reads or writes.
Greedily colouring that conflict graph gives the number of sequential **rounds** an
optimistic scheduler needs; **width = txs / rounds** is the ceiling on concurrency
any parallel EVM could extract. No RPC, no funds, no flakiness.

## Result 1 — the sharding mechanism is real

19 transactions in every row.

| workload | rounds | width |
| --- | --- | --- |
| `market.matchTick`, 19 ticks | 1 | **19.00×** |
| `naive.place` (shared globals) | 19 | 1.00× |
| `place()`, 19 senders | 1 | 19.00× |
| `place()`, **1 sender** | 19 | **1.00×** |

The last row is the one that matters. Placing from a single account is *perfectly
serial* — every call writes `balance[msg.sender]` — and EVM account nonces serialise
one account's transactions at the protocol level regardless. **Any benchmark that
sends from one key is structurally incapable of showing parallelism.** Ours did,
until `scripts/multi-sender-bench.ts`.

Contention sweep, 19 transactions held constant, only the spread varying:

| distinct ticks | 19 | 10 | 5 | 2 | 1 |
| --- | --- | --- | --- | --- | --- |
| width | 19.00× | 9.50× | 4.75× | 1.90× | 1.00× |

## Result 2 — width is a ceiling, not a speedup

A wider road only helps once traffic, rather than the traffic light, is the
constraint. At 19 cheap transactions against a ~400 ms block time, **execution is
never the bottleneck — consensus is.** So the honest position is:

- proven: the state topology is genuinely disjoint
- unproven: that it converts to wall-clock latency at this workload size
- expected: it does not, until execution time per block approaches the block budget

No measurement here supports a latency claim, and `apps/web/config/bench.ts` still
carries `measured: false` rather than a number nobody took.

## Result 3 — the local run is a negative control

`./scripts/local-bench.sh`, 19 senders × 3 runs, anvil:

```
spread     median  98ms   blocks(med) 10
contended  median 104ms   blocks(med)  7
A vs B: 1.06x
```

Anvil executes **sequentially**, so arms A and B are identical there by
construction. 1.06× is the correct answer, and getting it is the point: a harness
that reported 3× on a sequential executor would be measuring an artefact. Debug
locally, measure on a parallel node.

## Result 4 — is FlashGrid's contract better? No, and it is measurable

Average gas per order placement, warm slots:

| project | parallel side | sequential baseline | baseline / parallel |
| --- | --- | --- | --- |
| **ours** | `Market.place` 73,578 | `NaiveBook.place` 72,247 | **98%** |
| flashgrid | `FlashGrid.placeOrder` 50,242 | `ParallelBenchmark.placeOrder` 25,266 | **50%** |

A parallel-vs-sequential benchmark is only meaningful if both arms do the same work.
`NaiveBook` was written to match `Market.place` — same price maths, same rounding,
same balance debit, same struct push, same event — and lands within 2%.
`ParallelBenchmark` does a counter increment and a `uint256` push, with **no balance
ledger and no pricing at all**, so half of any gap it shows is a gap in workload
rather than in scheduling. That is why we did not adopt it.

Their *sharding*, measured with the same instrument, is real — but conditionally:

| workload | rounds | width |
| --- | --- | --- |
| `flashgrid.settleTick`, disjoint makers | 1 | 19.00× |
| `flashgrid.settleTick`, **one shared maker** | 19 | **1.00×** |
| `market.matchTick`, one shared maker | 1 | 19.00× |

`settleTick` credits `balances[order.maker]`, keyed by maker only, so two ticks
settle concurrently only if no trader appears in both — and a market maker quoting
across the book collapses it to fully serial. `matchTick` credits
`yesPos[tick][maker]`, keyed by tick *and* maker, so it stays disjoint. Same idea,
one key wider. That is the whole difference, and it is the reason to keep ours.

## The general finding

Most deployed contracts are width 1.00×: a pool's reserves, a token's hot treasury,
any global counter. They serialise exactly like `NaiveBook`, so a parallel chain
gives them nothing. The chains went parallel; the contracts did not. That is a
criticism of contract design, not of parallel execution.

## Still open

- No wall-clock measurement on a parallel node. Needs a private RPC — the public
  Monad endpoint 429s well before 57 transactions per run finish.
- The workload may simply be too small to leave the consensus-bound regime.
