# Submission — Monad hackathon

## Say these four out loud (Basic, 100 pts)

1. **Repo** — https://github.com/unspecifiedcoder/parallelbook
2. **Contract** — `0xBa9876Fd1c8cb6bB53a91D594B2FD6E1fdbeB74A` (MarketFactory)
3. **Live** — https://parallelbook-ravi-shankars-projects-cf50f2c9.vercel.app
4. **Deployment** — Monad Testnet, chain `10143`, 5 contracts live

| Contract | Address |
| --- | --- |
| MarketFactory | `0xBa9876Fd1c8cb6bB53a91D594B2FD6E1fdbeB74A` |
| NaiveBook (baseline) | `0x65f5f4b3743feebFAfa4ED007266B0cB6FBC91E9` |
| Series 1 | `0xf08dEbb649398Ecd2D4D808b172e2B26C09378EE` |
| Series 2 | `0xF88a19D58C4470692e760D39238d61BB3A979eDE` |
| Series 3 | `0xc0B429F4054f61B5e6AB8Cb648Dcd0E80fd1cB72` |

## 30-second pitch

> A prediction market where every market lives sixty seconds.
>
> The interesting part is the contract. Most order books are one queue behind
> one lock — every trade waits for the one in front. Ours is nineteen
> independent shards, one per price level. No state-changing function touches
> more than one shard plus your own balance. No global counter, nothing written
> on a hot path, because one shared slot would serialise the whole book.
>
> So two trades at different prices share no storage, and Monad's parallel
> executor runs them at once instead of single-filing them.
>
> We deployed the naive sequential book beside it, same chain, same gas price —
> so it's a measurement, not a claim.
>
> Repo is public, contracts are on Monad testnet at 0xBa9876Fd, it's live, and
> I'll place a trade on chain right now.

## Demo order

1. Open the live URL — a market is running, clock counting down
2. Connect (passkey/email via Privy), faucet if needed
3. **Place an order — this is the live on-chain transaction**
4. Show it confirm, book update, explorer link
5. `/app/rounds` — rounds rolling every 60s

Have the page open and wallet connected BEFORE presenting.

## X post

> Built at the Monad hackathon: sixty-second onchain prediction markets.
>
> Most order books are one queue behind one lock — every trade waits.
>
> Ours is 19 independent price shards. Nothing global on a hot path, so trades
> at different prices never contend and @monad's parallel executor runs them at
> once.
>
> We deployed the naive sequential book beside it as a baseline — same chain,
> same gas price — so the number is a measurement, not a claim.
>
> 51/51 contract tests. Invariants at 256 runs × 128 depth.
>
> Live: https://parallelbook-ravi-shankars-projects-cf50f2c9.vercel.app
> Code: github.com/unspecifiedcoder/parallelbook
>
> @monad_dev @geeky_kartikey

## LinkedIn post

> **Sixty seconds. One question. Onchain.**
>
> At the Monad hackathon we built a prediction market where each market opens,
> fills and settles inside a minute.
>
> The engineering bet is in the contract. A conventional order book serialises:
> one shared book behind one lock, so throughput is capped by the slowest trade
> in the queue. We sharded by price — nineteen levels, each its own independent
> storage. No global counter, no aggregate total, nothing on a hot path that
> every order would queue behind.
>
> Two trades at different prices touch no common storage, so Monad's parallel
> executor runs them concurrently rather than in sequence.
>
> To stay honest we deployed the naive sequential book alongside it, same chain,
> same gas price — so the comparison measures two contracts rather than asserting
> a benefit.
>
> Verified, not claimed: 51/51 contract tests, solvency invariants at 256 runs ×
> 128 depth, and a Python reference model agreeing across 400 simulated markets.
>
> Live: https://parallelbook-ravi-shankars-projects-cf50f2c9.vercel.app
> Code: https://github.com/unspecifiedcoder/parallelbook
>
> @monad @monad_dev @geeky_kartikey

## Ad video — 25s

- `00:00` Black. **"Most order books make you wait in line."**
- `00:04` One column, orders stacking, each waiting. Clock: 60.
- `00:09` **"We deleted the line."**
- `00:11` Nineteen columns light up, all filling at once.
- `00:18` **"19 price levels. All matching at the same time."**
- `00:22` Logo + URL + "Live on Monad testnet."

Screen-record the real ladder mid-round — real fills sell it better than motion
graphics.

## If views fall short

Rubric accepts instead of 5K views: **25+ waitlist signups** (already built —
screenshot the count) or **10+ outside users on the day**. Waitlist is easier:
drop the link in the venue chat.
