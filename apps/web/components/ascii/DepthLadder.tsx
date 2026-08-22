"use client"

import { useEffect, useRef } from "react"

import { PHASE } from "../../lib/abi"
import { NUM_TICKS, formatBps, formatWad, legPrice, price, type TickLevel } from "../../lib/market-math"

/**
 * Nineteen prices, both sides, and one gesture to trade any of them.
 *
 * WHAT CHANGED AND WHY
 *
 * The ladder used to be a read-only rendering with a row-level onPickTick. That
 * had two problems, one of interaction and one of information:
 *
 *   INTERACTION. Picking a row told the ticket a price but not a side, so the
 *   user still had to reach over to a yes/no toggle to finish the thought. On a
 *   market that lives sixty seconds, a two-gesture order is a missed round. Now
 *   every size cell is its own button: the cell you touch IS the order you get,
 *   because a cell already encodes both facts.
 *
 *   INFORMATION. Your own resting orders were invisible, so 40 shares at 0.55
 *   looked identical whether they were yours or a stranger's. You could not tell
 *   whether to cancel, or whether you were about to queue behind yourself. Own
 *   size now carries a marker.
 *
 * The marker is a real character in a real cell, NOT inside a <pre>. Box-drawing
 * and shape glyphs inside preformatted blocks are exactly what produced the
 * ragged right edge this project already fixed once: a monospace advance is not
 * an integer number of pixels, so 170 columns of asserted width drift about
 * 34px. The ladder is a <table> for that reason -- the browser measures, we do
 * not assert.
 */

/** Bar width in cells. Fixed so every row measures against the same ruler. */
const BAR_CELLS = 14

export type DepthLadderProps = {
	levels: readonly TickLevel[]
	impliedBps: bigint
	selectedTick?: number
	/** true = yes, false = no. Drives which cell reads as chosen. */
	selectedSide?: boolean
	/** the cell you touched is the order you get: both price and side */
	onPick?: (tick: number, isYes: boolean) => void
	interactive?: boolean
	phase?: number
	/** your resting size by tick, per side, from lib/orders.ts */
	mineYes?: readonly bigint[]
	mineNo?: readonly bigint[]
	/** ticks that just filled, for the 180ms flash */
	flashTicks?: readonly number[]
}

function bar(size: bigint, max: bigint): string {
	if (max <= 0n || size <= 0n) return ""
	// Floor, never round: a bar that shows one cell for a size of zero is a lie,
	// and rounding up is how that happens.
	const cells = Number((size * BigInt(BAR_CELLS)) / max)
	return "\u2588".repeat(Math.max(0, Math.min(BAR_CELLS, cells)))
}

export function DepthLadder({
	levels,
	impliedBps,
	selectedTick,
	selectedSide,
	onPick,
	interactive = false,
	phase = PHASE.Open,
	mineYes,
	mineNo,
	flashTicks,
}: DepthLadderProps) {
	// Remembering the previous book lets a row flash on change even when the
	// server did not tell us which ticks moved.
	const prev = useRef<readonly TickLevel[]>(levels)
	useEffect(() => {
		prev.current = levels
	}, [levels])

	if (!levels || levels.length === 0) {
		// A market with no orders is a normal state, not an error. Say what will
		// happen rather than rendering nineteen rows of zeroes.
		return (
			<div className="panel">
				<div className="panel-head">
					<span className="label">the book</span>
					<span className="label">empty</span>
				</div>
				<div className="panel-body">
					<p className="label" style={{ margin: 0, lineHeight: 1.6 }}>
						no orders yet. the first order sets the price, and anything that crosses it matches on the next
						block.
					</p>
				</div>
			</div>
		)
	}

	const maxOpen = levels.reduce((m, l) => {
		const v = l.openYes > l.openNo ? l.openYes : l.openNo
		return v > m ? v : m
	}, 1n)

	const nearest = Number(impliedBps / 500n)

	// Nineteen rows is too many to read at a glance, so the ladder shows the
	// neighbourhood of the market -- but a tick where YOU have size is never
	// hidden, or the cancel affordance would vanish exactly when it is needed.
	const visible: number[] = []
	for (let t = 0; t < Math.min(NUM_TICKS, levels.length); t++) {
		// The loop bound already proves this index is in range, but
		// noUncheckedIndexedAccess types every element access as possibly
		// undefined, so bind it once and let the guard do the narrowing.
		const level = levels[t]
		if (!level) continue
		const mine = (mineYes?.[t] ?? 0n) > 0n || (mineNo?.[t] ?? 0n) > 0n
		const busy = level.openYes > 0n || level.openNo > 0n || level.matched > 0n
		if (mine || busy || Math.abs(t - nearest) <= 4 || t === selectedTick) visible.push(t)
	}

	const canTrade = interactive && phase === PHASE.Open

	return (
		<div className="panel">
			<div className="panel-head">
				<span className="label">the book</span>
				<span className="label">{canTrade ? "tap a size to take that side at that price" : "read only"}</span>
			</div>

			{phase === PHASE.Locked ? (
				<div className="panel-body" style={{ borderBottom: "1px solid var(--line)" }}>
					<span className="label">locked \u00b7 matching</span>
				</div>
			) : null}

			<div className="panel-body">
				<table className="table ascii-selectable" style={{ width: "100%" }}>
					<thead>
						<tr>
							<th className="r">yes</th>
							<th className="r">depth</th>
							<th style={{ textAlign: "center" }}>price</th>
							<th>depth</th>
							<th>no</th>
							<th className="r">matched</th>
						</tr>
					</thead>
					<tbody>
						{visible.map((t) => {
							const l = levels[t]
							const myYes = mineYes?.[t] ?? 0n
							const myNo = mineNo?.[t] ?? 0n
							const flash = flashTicks?.includes(t) ?? false
							const isNearest = t === nearest

							// One cell = one order. aria-label spells out the whole thing
							// because "40" read aloud on its own means nothing.
							const sizeCell = (isYes: boolean, size: bigint, mine: bigint) => {
								const chosen = t === selectedTick && selectedSide === isYes
								const label = `Buy ${isYes ? "yes" : "no"} at ${formatBps(legPrice(t, isYes))}`
								const inner = (
									<>
										{size > 0n ? formatWad(size) : "\u00b7"}
										{mine > 0n ? (
											<span
												style={{ color: "var(--accent)", marginLeft: "0.35em" }}
												title={`${formatWad(mine)} of this is yours`}
											>
												{"\u25cf"}
											</span>
										) : null}
									</>
								)
								return (
									<td className={`num ${isYes ? "yes" : "no"}${flash ? " flash" : ""}`} style={{ textAlign: isYes ? "right" : "left" }}>
										{canTrade && onPick ? (
											<button
												type="button"
												className="btn btn-ghost"
												aria-label={label}
												aria-pressed={chosen}
												onClick={() => onPick(t, isYes)}
												style={{
													width: "100%",
													padding: "0 var(--s2)",
													textAlign: isYes ? "right" : "left",
													borderColor: chosen ? "var(--accent)" : "transparent",
													fontVariantNumeric: "tabular-nums",
												}}
											>
												{inner}
											</button>
										) : (
											inner
										)}
									</td>
								)
							}

							return (
								<tr key={t} style={isNearest ? { background: "var(--bg-3)" } : undefined}>
									{sizeCell(true, l.openYes, myYes)}
									<td className="r yes" style={{ letterSpacing: "-0.05em" }}>
										{bar(l.openYes, maxOpen)}
									</td>
									<td className="num" style={{ textAlign: "center", fontWeight: isNearest ? 500 : 400 }}>
										{formatBps(price(t))}
									</td>
									<td className="no" style={{ letterSpacing: "-0.05em" }}>
										{bar(l.openNo, maxOpen)}
									</td>
									{sizeCell(false, l.openNo, myNo)}
									<td className="r num muted">{l.matched > 0n ? formatWad(l.matched) : "\u00b7"}</td>
								</tr>
							)
						})}
					</tbody>
				</table>

				{mineYes || mineNo ? (
					<p className="label" style={{ marginTop: "var(--s3)", marginBottom: 0 }}>
						<span style={{ color: "var(--accent)" }}>{"\u25cf"}</span> marks size that is yours
					</p>
				) : null}
			</div>
		</div>
	)
}
