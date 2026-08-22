import { AppNav } from "../../../components/AppNav"
import { brand } from "../../../config/brand"
import { explorerAddress } from "../../../config/chains"
import { getLeaderboard } from "../../../lib/leaderboard"
import { formatWad } from "../../../lib/market-math"

// Wallet state is per-visitor and only exists in the browser, so there is
// nothing correct to prerender: wagmi's hooks throw at build time because
// no WagmiProvider exists on the server. Every other wallet-facing page in
// this app already opts out the same way.
export const dynamic = "force-dynamic"

/**
 * The board.
 *
 * Cached for 30 seconds by the framework rather than by a hand-rolled KV entry:
 * two getLogs calls are too expensive to run per visitor and far too cheap to
 * justify a cache with its own invalidation bugs. Every other /app route is
 * force-dynamic because it shows a live book; this one is a rolling aggregate,
 * where being half a minute stale is invisible.
 */
export const revalidate = 30

export const metadata = {
	title: `leaderboard \u00b7 ${brand.wordmark.toLowerCase()}`,
	description: brand.tagline,
}

function short(a: string) {
	return `${a.slice(0, 6)}\u2026${a.slice(-4)}`
}

export default async function LeaderboardPage() {
	const board = await getLeaderboard({ limit: 25 })
	const blocks = board.toBlock > board.fromBlock ? board.toBlock - board.fromBlock : 0n

	return (
		<div className="theme-ink">
			<AppNav />
			<main className="wrap" style={{ paddingTop: "var(--s5)", paddingBottom: "var(--s8)" }}>
				<h1 className="display" style={{ fontSize: "var(--t-h2)", margin: 0 }}>
					leaderboard
				</h1>
				{/*
				  "winnings", not "profit". Ranking by net claimed rewards volume as much
				  as skill, and true P&L needs the cost basis of every fill. Naming the
				  number for what it is beats implying a stronger claim.
				*/}
				<p className="label" style={{ marginTop: "var(--s2)", lineHeight: 1.6 }}>
					claimed winnings from settlement events, read straight off the chain. this is volume-weighted, not
					profit \u2014 cost basis needs an indexer.
				</p>

				{board.rows.length === 0 ? (
					<div className="panel" style={{ marginTop: "var(--s5)" }}>
						<div className="panel-head">
							<span className="label">nothing claimed yet</span>
						</div>
						<div className="panel-body">
							<p className="label" style={{ margin: 0, lineHeight: 1.6 }}>
								no market in the window has been settled and claimed. the board fills itself the first time
								somebody collects.
							</p>
						</div>
					</div>
				) : (
					<div className="panel" style={{ marginTop: "var(--s5)" }}>
						<div className="panel-body">
							<table className="table">
								<thead>
									<tr>
										<th>#</th>
										<th>address</th>
										<th className="r">won</th>
										<th className="r">claims</th>
										<th className="r">fees paid</th>
										<th className="r">cranked</th>
									</tr>
								</thead>
								<tbody>
									{board.rows.map((r, i) => (
										<tr key={r.address}>
											<td className="num muted">{i + 1}</td>
											<td className="num">
												<a
													href={explorerAddress(r.address)}
													target="_blank"
													rel="noreferrer"
													style={{ color: "inherit" }}
												>
													{short(r.address)}
												</a>
											</td>
											<td className="r num yes">{formatWad(r.netWei)}</td>
											<td className="r num">{r.claims}</td>
											<td className="r num muted">{formatWad(r.feeWei)}</td>
											{/* The crank column exists to make visible that matching is
											    permissionless and paid. A blank here is normal. */}
											<td className="r num">
												{r.cranks > 0 ? `${formatWad(r.crankWei)} \u00b7 ${r.cranks}\u00d7` : "\u00b7"}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</div>
				)}

				{/* State the window rather than implying all-time coverage. */}
				<p className="label" style={{ marginTop: "var(--s4)", lineHeight: 1.6 }}>
					last {blocks.toString()} blocks across {board.markets} markets
					{board.partial ? " \u00b7 window narrowed to satisfy the rpc" : ""} \u00b7 refreshed every 30s
				</p>
			</main>
		</div>
	)
}
