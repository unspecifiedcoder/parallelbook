# LIVEMARKETS

**Sixty seconds. One question. Onchain.**

A prediction market that opens, fills and settles inside a minute, on Monad
testnet. Nineteen price levels, a real order book, and a livestream next to it.

---

## Run it

```bash
git clone https://github.com/unspecifiedcoder/parallelbook
cd parallelbook
npm i
npm run dev
```

**No environment variables required.** With an empty `.env` the app runs in watch
mode: it reads the public Monad testnet RPC, renders live books, and shows every
price and clock. Sign-in and the faucet hide themselves rather than throwing, so
a fresh clone is never a wall of red.

What you get with no config, and what each variable unlocks:

| Variable | Without it | With it |
| --- | --- | --- |
| `NEXT_PUBLIC_MONAD_RPC_URL` | public `testnet-rpc.monad.xyz` | your own RPC (recommended — the public one rate-limits) |
| `NEXT_PUBLIC_MONAD_EXPLORER` | `testnet.monadexplorer.com` | your explorer |
| `NEXT_PUBLIC_PRIVY_APP_ID` | watch mode: read everything, sign nothing | passkey / email / Google / wallet sign-in |
| `NEXT_PUBLIC_MULTICALL3` | reads go one at a time | batched reads |
| `FAUCET_PRIVATE_KEY` | `/api/faucet` returns 503 and the button hides | in-app testnet drip |
| `UPSTASH_REDIS_REST_URL` + `_TOKEN` | faucet guards fall back to in-process, waitlist is ephemeral | durable one-drip-per-address and daily caps |
| `IP_HASH_SALT` | IPs hashed with a default salt | your salt |
| `STREAMS_API_URL` | market rooms say “no live surface for this market” | livestream metadata per market |

Copy `.env.example` to `.env.local` and fill in only what you need.

> **One manual step for the visuals.** `apps/web/public/plates/` holds six
> AVIF/WebP background plates that are binary and cannot be pushed through the
> GitHub contents API. Copy them in from the release zip. Without them the hero
> renders with no background plate — the `<img>` is `alt=""` and `aria-hidden`,
> so it degrades cleanly rather than breaking.

---

## The idea

### A book sharded by price

A normal order book is one sorted list. One sorted list is one hot storage slot:
every fill rewrites the same head pointer, so transactions queue no matter how
parallel the chain is. The contention is in the data structure, not the chain.

So there is no shared list. Each of the nineteen ticks is its own struct with its
own resting size, matched total, fee accumulator and cursor:

```text
   one question            nineteen shards            one settlement

                    +-- 0.05 --+ openYes openNo matched +
                    |-- 0.10 --| openYes openNo matched |
 "Boundary in the --+-- 0.15 --| openYes openNo matched |
  next over?"       |    :     |    :       :      :    +--> yes / no / void
                    |-- 0.90 --| openYes openNo matched |
                    +-- 0.95 --+ openYes openNo matched +

                    |===== 19 concurrent matchTick() txs =====|
```

`matchTick(4)` and `matchTick(17)` share no storage, so Monad's scheduler runs
them in the same block. That is the entire design, and it is why a market can
open, fill across every level and settle inside sixty seconds.

### Why the clock is the authority, not the picture

Broadcast HLS runs 15–45 seconds behind. Low-latency Twitch is 3–5. Somebody in
the stadium is at zero, and a scoring API can be *ahead* of all of them. If the
market were about something already visible on one of those feeds, whoever has
the fastest one wins for free.

Three rules fall out of that, and they are enforced in code:

1. **Every market is about an interval that has not begun.** "Boundary in the
   next over", not "was that a boundary".
2. **The app clock is the only authority.** Two clocks — `ORDERS CLOSE` and
   `RESOLVES` — appear on the list card, the strip, the market header and the OG
   image.
3. **Nothing is tradeable once the resolving interval has started**, even if
   `openUntil` has not passed yet.

The stream is never larger than 38% of the market room, never autoplays with
sound, and carries a delay disclaimer under every embed.

---

## What is where

```text
apps/web/
  app/
    page.tsx                     landing — opens on a real live market
    app/page.tsx                 /app — opens on a live market, not a menu
    app/rounds/page.tsx          every round, grouped by what you can DO
    app/portfolio/page.tsx       what you hold, what you can claim
    app/leaderboard/page.tsx     who won, from settlement logs
    app/m/[address]/page.tsx     the market room: stream + book + ticket
    r/[address]/page.tsx         a result you can paste into a chat
    admin/page.tsx               resolver console
    api/
      stream/[address]/route.ts  SSE — one poll loop per market
      health/route.ts            poll loops, viewers, RPC calls/min
      feed/[address]/route.ts    cached snapshot (SSE fallback)
      faucet/route.ts            guarded testnet drip
      og/[address]/route.tsx     market share card
      og/result/[address]        result share card
  lib/
    market-math.ts               wei-exact mirror of the contract's arithmetic
    settlement.ts                one answer to "what did this address get"
    watcher.ts                   shared per-market poll loop
    live.ts                      client SSE hook with polling fallback
    orders.ts                    your resting orders, without 38 calls/sec
    leaderboard.ts               aggregates Claimed / CrankRewardPaid logs
    market-client.ts             viem reads
packages/contracts/src/
  Market.sol                     the sharded book
  MarketFactory.sol              deployment + discovery
  Series.sol                     perpetual rounds
```

---

## Numbers that must agree

`lib/market-math.ts` is a **wei-exact mirror** of the cost, payout and refund
arithmetic in `Market.sol`. The rule it exists to enforce:

> The number in the order ticket must equal the number the contract charges, to
> the wei.

It is all `bigint`, no floats anywhere near collateral, and every debit rounds
**up** while every credit rounds **down** — the same direction as the contract.
`lib/market-math.test.ts` checks it against vectors generated from the contract
itself:

```bash
cd apps/web && npm test
```

`lib/settlement.ts` is the single place that answers *what did this address get
out of this market*. The share card, the result page and the portfolio all fold
through it, because three surfaces quoting three slightly different numbers for
the same position is how a product loses the benefit of the doubt on money. The
fee is applied **per tick**, not once on a total, because `Market.claim` branches
per tick and rounds each fee down.

### The dust, and why there is no sweep

Rounding up on debits and down on credits leaves a residue of roughly **32 wei**
per fully-cycled market. That is intentional and it is documented rather than
collected. A sweep function is a privileged transfer path — more attack surface,
more audit burden, one more thing that can be pointed at the wrong address —
bought for a value that will never exceed a rounding error. It stays.

---

## One poll loop per market, not one per viewer

The first version of `/api/stream` polled the chain once per connected visitor.
Ten people watching one market meant ten identical `eth_call` loops: about
**300 RPC calls a minute** to learn the same thing ten times.

`lib/watcher.ts` now keeps one loop per *market* and fans out to subscribers. Ten
viewers cost the same as one. Per-connected-trader polling for your own resting
orders is separate and much cheaper, because `lib/orders.ts` does one sweep of
the nineteen ticks and then watches only the ticks you actually have something
at, instead of re-reading all thirty-eight legs on a timer.

You can watch this working:

```bash
curl -s localhost:3000/api/health | jq
```

```json
{
  "ok": true,
  "pollLoops": 1,
  "viewers": 7,
  "viewersPerPollLoop": 7,
  "pollIntervalMs": 500,
  "rpcCallsPerMinute": 120
}
```

If `viewersPerPollLoop` is ever `1` with several viewers on one market, the
sharing is broken.

---

## The leaderboard is not a counter

`/app/leaderboard` reads `Claimed` and `CrankRewardPaid` **logs**. The shortcut
would be to POST "I won" to a KV counter when a claim succeeds — which produces a
board anyone can forge with `curl`. That is worse than having no board, because
it invites people to trust a number that is not true.

Two honest limits, both stated on the page itself:

- It is labelled **winnings, not profit.** Ranking by net claimed rewards volume
  as much as skill. True P&L needs the cost basis of every fill, which means
  replaying `Matched` against per-order prices — an indexer's job.
- It covers a **window**, not all time. It asks for ~20,000 blocks (about two
  hours at 400ms) and halves the range if the RPC refuses, then reports the
  window it actually got.

---

## Contracts

```bash
cd packages/contracts
forge build
forge test
```

`lib/forge-std` is vendored as committed files, not a submodule, so a fresh clone
builds without `git submodule update`.

Deploy and register a series:

```bash
forge script script/Deploy.s.sol \
  --rpc-url $MONAD_RPC_URL \
  --private-key $DEPLOYER_KEY \
  --broadcast
```

Addresses are read from `packages/contracts/deployments/10143.json`, and
`config/contracts.ts` throws on a chain-id mismatch rather than silently pointing
the UI at the wrong network.

Verify:

```bash
forge verify-contract <address> src/MarketFactory.sol:MarketFactory \
  --chain-id 10143 --verifier sourcify --watch
```

### Three bugs that are fixed and must stay fixed

There are regression tests for each of these. If you refactor `Market.sol`, keep
them passing:

1. **Matching after resolution reverts.** It used to silently no-op, which meant a
   cranker could burn gas for nothing after settlement.
2. **The fee accumulator is per tick, not one global slot.** A single global fee
   slot re-introduces exactly the write contention the sharding exists to remove.
3. **`Series` schedules from the previous scheduled slot**, not from `block.timestamp`.
   Scheduling from "now" makes rounds drift a little later every time.

There is also a Python reference model and a fuzz harness in
`packages/contracts/sim` — the model is the arbiter when Solidity and TypeScript
disagree about a number.

---

## Benchmark

The landing page has a latency table that is **empty until someone runs it**:

```bash
npx tsx scripts/bench.ts
```

It fires nineteen `matchTick` transactions at a deployed market two ways — one at
a time, then all at once with pre-computed nonces — and against `NaiveBook.sol`,
the same market built on one shared list. It checks *work parity* first, so a
fast run that matched less volume is reported as a failure rather than a win, and
it writes its own results into `apps/web/config/bench.ts`. The page can therefore
only ever show a real measurement.

Publishing a number nobody measured is how benchmarks stop meaning anything.

---

## What you are trusting

One key decides every outcome. `trust.stage` in `config/contracts.ts` is `"v1"`
and the label is `"single resolver"`, and the UI is not allowed to imply anything
stronger than whatever that config says. The resolver is a constructor argument
rather than a hardcoded address, so replacing it does not need a new protocol.

This is testnet. `brand.environmentLabel` — *beta · monad testnet · test funds
only* — is rendered in the nav on every route, not in a modal somebody dismisses
once.

---

## Verification status

Being specific about this rather than implying a green build.

| Area | State | How to reproduce |
| --- | --- | --- |
| Contracts compile | **verified** | `forge build` |
| Contract test suite | **verified — 51/51** | `forge test` |
| Solvency invariants | **verified — 6/6, 256 runs × 128 depth** | `forge test --match-path test/Invariant.t.sol` |
| Cost / payout / refund parity | **verified** against contract-generated vectors | `npm run vectors && forge test` |
| Python reference model | **verified — 400 markets × 300 actions** | `npm run test:model` |
| TypeScript across the web app | **not verified** | `npm run typecheck` |
| `next build` | **not verified** | `npm run build` |
| Parallel-vs-sequential latency | **unmeasured** | `npx tsx scripts/bench.ts` |

Two things are worth stating plainly, because an earlier version of this file
implied the opposite.

**The contracts did not merely go unrecompiled — they did not compile.**
`_matchTick` overflowed the EVM stack with `via_ir = false`, so no version of
this test suite had ever run. It runs now, and everything above marked verified
was verified after that fix, not before it. Three independent checks agree that
a matched pair is never undercollateralised: the invariant suite, the fuzz test
in `Vectors.t.sol`, and the Python model, which reports directly that
`mulDivUp` keeps 1-wei pairs solvent at all nineteen ticks and `mulDivDown`
does not.

**The web app's types are not checked.** The rows above say `not verified`
rather than `failing` on purpose: `npm install` has not completed successfully
in this environment, so the last `tsc` run could not resolve `next` or `viem`
and its output was mostly module-resolution noise. The genuine type errors
visible through that noise are fixed; whether more remain behind it is unknown
until the install succeeds. Do not read `not verified` as `probably fine`.

---

## Not built, on purpose

Saying no is part of the design:

- **No simulated, demo or offline mode.** If the chain is unreachable the UI says
  so. A fake book that looks real is a worse bug than an error message.
- **No parimutuel pool.** This is a nineteen-tick CLOB. You pick a price.
- **No token, no leverage, no multi-outcome markets, more than nineteen ticks.**
- **No dust sweep.** See above.
- **No stream URL on chain.** Stream metadata is off-chain in the registry;
  putting a URL in storage would make a broken link a permanent one.
- **No external faucet link.** Sending a new user to a third-party site to solve
  a captcha before they have seen a single price is the worst possible first step.
  `/api/faucet` drips instead, guarded four ways: zero-balance only, one drip per
  address ever, a per-IP rate limit, and a daily cap.

---

## Licence

MIT.
