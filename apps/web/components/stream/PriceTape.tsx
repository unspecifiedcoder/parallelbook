"use client"

import { useEffect, useRef, useState } from "react"

import { TAPE_SAMPLES, type Feed } from "../../config/feeds"

/**
 * The price tape. The live surface for the always-on market, which has no video.
 *
 * `tape` is NOT a degraded fallback. It is the correct mode for a price market
 * and it has to look as deliberate as a player does: last print, a 60-second
 * sparkline drawn in characters, the direction of the last tick, and the
 * reference exchange named so nobody has to guess what settled it.
 *
 * ASCII ONLY. The block-glyph sparkline this would obviously want falls out to a
 * substitute font at a different advance on several platforms, which shears the
 * row. Seven ASCII levels read fine and are guaranteed to be one cell each.
 */

// low to high. Every one of these is in every mono font ever shipped.
const RAMP = "_.-=+*#"

type Sample = { t: number; p: number }

export type PriceTapeProps = {
	feed: Feed
	/** poll cadence; the route is cached so this costs the exchange nothing extra */
	intervalMs?: number
}

export function PriceTape({ feed, intervalMs = 1_000 }: PriceTapeProps) {
	const [samples, setSamples] = useState<Sample[]>([])
	const [error, setError] = useState<string | null>(null)
	const live = useRef(true)

	useEffect(() => {
		live.current = true
		let timer: ReturnType<typeof setInterval> | null = null

		const poll = async () => {
			try {
				const res = await fetch(`/api/feed/${feed.id}`, { cache: "no-store" })
				if (!res.ok) throw new Error(`feed ${res.status}`)
				const body = (await res.json()) as { price?: number; at?: number; stale?: boolean }
				if (!live.current || typeof body.price !== "number") return
				setError(body.stale ? "upstream stale" : null)
				setSamples((prev) => {
					const next = [...prev, { t: body.at ?? Date.now(), p: body.price as number }]
					return next.length > TAPE_SAMPLES ? next.slice(next.length - TAPE_SAMPLES) : next
				})
			} catch (err) {
				if (!live.current) return
				// Say the feed is stale rather than freezing on a number and implying it
				// is current. A stale price on a 60-second market is a lie.
				setError(err instanceof Error ? err.message : "feed unreachable")
			}
		}

		void poll()
		const start = () => {
			if (!timer) timer = setInterval(() => void poll(), intervalMs)
		}
		const stop = () => {
			if (timer) clearInterval(timer)
			timer = null
		}
		const onVis = () => (document.hidden ? stop() : (void poll(), start()))
		document.addEventListener("visibilitychange", onVis)
		if (!document.hidden) start()

		return () => {
			live.current = false
			stop()
			document.removeEventListener("visibilitychange", onVis)
		}
	}, [feed.id, intervalMs])

	// The length checks already prove these are present; ?? null satisfies
	// noUncheckedIndexedAccess without changing behaviour.
	const last = samples[samples.length - 1]?.p ?? null
	const prev = samples.length > 1 ? (samples[samples.length - 2]?.p ?? null) : null
	const dir = last !== null && prev !== null ? Math.sign(last - prev) : 0
	const first = samples[0]?.p ?? null
	const change = last !== null && first !== null && first !== 0 ? ((last - first) / first) * 100 : null

	return (
		<div className="panel">
			<div className="panel-head">
				<span className="label">price tape · {feed.label}</span>
				<span className="label">{feed.exchange}</span>
			</div>

			<div className="panel-body" style={ { display: "grid", gap: "var(--s4)" } }>
				<div style={ { display: "flex", alignItems: "baseline", gap: "var(--s4)", flexWrap: "wrap" } }>
					<span
						className="num"
						style={ {
							fontSize: "var(--t-h2)",
							lineHeight: 1,
							color: dir > 0 ? "var(--yes)" : dir < 0 ? "var(--no)" : "var(--fg)",
						} }
					>
						{last === null ? "\u2014" : last.toFixed(feed.dp)}
					</span>
					<span className="label">{dir > 0 ? "up" : dir < 0 ? "down" : "flat"} on the last print</span>
					{change !== null ? (
						<span className="label num" style={ { marginLeft: "auto" } }>
							{change >= 0 ? "+" : ""}
							{change.toFixed(3)}% over {samples.length}s
						</span>
					) : null}
				</div>

				<div className="ascii-scroll">
					<pre className="ascii" aria-hidden="true">
						{spark(samples.map((s) => s.p))}
					</pre>
				</div>

				<p className="label" style={ { margin: 0, lineHeight: 1.5 } }>
					{error
						? `feed stale — ${error}. the clock above is still authoritative.`
						: `last ${samples.length}s of ${feed.symbol} on ${feed.exchange}. this market settles from the print at the resolve time, not from this tape.`}
				</p>
			</div>
		</div>
	)
}

/**
 * A character sparkline over a fixed width, scaled to the window's own min and
 * max so a two-dollar move on a four-thousand-dollar asset is still visible.
 */
function spark(values: readonly number[], width = TAPE_SAMPLES): string {
	if (values.length === 0) return ".".repeat(width)
	const lo = Math.min(...values)
	const hi = Math.max(...values)
	const span = hi - lo
	const body = values
		.map((v) => {
			if (span === 0) return RAMP[Math.floor(RAMP.length / 2)]
			const step = Math.round(((v - lo) / span) * (RAMP.length - 1))
			return RAMP[Math.max(0, Math.min(RAMP.length - 1, step))]
		})
		.join("")
	// left-pad so the newest print is always at the right edge and the tape does
	// not slide sideways as it fills
	return body.padStart(width, " ")
}
