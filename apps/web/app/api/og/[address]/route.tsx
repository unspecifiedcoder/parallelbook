import { ImageResponse } from "next/og"
import { isAddress, type Address } from "viem"

import { brand } from "../../../../config/brand"
import { readSnapshot } from "../../../../lib/market-client"
import { formatBps, formatWad, type TickLevel } from "../../../../lib/market-math"

/**
 * GET /api/og/0x... — the share card.
 *
 * A prediction market is only interesting if the price travels, so the card leads
 * with the number and draws the actual book underneath it in ASCII. Same visual
 * language as the app: paper, ink, one accent, monospace.
 *
 * Everything is drawn with layout primitives and system fonts — no remote font
 * fetch, no image fetch — so the card renders in tens of milliseconds and cannot
 * fail because a CDN was slow.
 */

export const runtime = "edge"
export const alt = "Live market"
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

const PAPER = "#F2EFE6"
const INK = "#0B0B0C"
const ULTRA = "#1B3FD1"
const RISO = "#D6452B"
const MUTED = "#7A776E"

const SPARK = " \u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588"

function sparkline(levels: readonly TickLevel[]): string {
	const weights = levels.map((l) => l.openYes + l.openNo + l.matched * 2n)
	const peak = weights.reduce((a, b) => (b > a ? b : a), 0n)
	if (peak === 0n) return "\u00b7".repeat(levels.length || 19)
	const top = BigInt(SPARK.length - 1)
	return weights
		.map((w) => (w === 0n ? "\u00b7" : SPARK[Number((w * top) / peak < 1n ? 1n : (w * top) / peak)]))
		.join("")
}

export async function GET(_req: Request, ctx: { params: Promise<{ address: string }> }) {
	const { address } = await ctx.params

	let question: string = brand.headline
	let implied = "0.50"
	let spark = "\u00b7".repeat(19)
	let volume = "0"
	let state = "live"

	if (isAddress(address)) {
		try {
			const snap = await readSnapshot(address as Address)
			question = snap.question
			implied = formatBps(snap.impliedBps)
			spark = sparkline(snap.levels)
			volume = formatWad(snap.levels.reduce((a, l) => a + l.matched, 0n))
			state = snap.phase === 2 ? ["", "settled yes", "settled no", "void"][snap.outcome] || "settled" : snap.phase === 1 ? "locked" : "live"
		} catch {
			// A card that renders the brand beats a broken image in a timeline.
		}
	}

	const accent = state.includes("no") ? RISO : ULTRA

	return new ImageResponse(
		(
			<div
				style={{
					width: "100%",
					height: "100%",
					display: "flex",
					flexDirection: "column",
					justifyContent: "space-between",
					background: PAPER,
					color: INK,
					padding: "64px",
					fontFamily: "monospace",
				}}
			>
				<div style={{ display: "flex", alignItems: "center", gap: 24, fontSize: 26, letterSpacing: 6, color: MUTED }}>
					<span>{brand.wordmark}</span>
					<span style={{ color: accent }}>{state.toUpperCase()}</span>
				</div>

				<div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
					<div style={{ fontSize: question.length > 70 ? 52 : 64, lineHeight: 1.15, maxWidth: 1000 }}>{question}</div>
					<div style={{ display: "flex", alignItems: "flex-end", gap: 28 }}>
						<span style={{ fontSize: 150, lineHeight: 1, color: accent }}>{implied}</span>
						<span style={{ fontSize: 30, color: MUTED, paddingBottom: 18 }}>implied probability of yes</span>
					</div>
				</div>

				<div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
					<div style={{ fontSize: 46, letterSpacing: 10, color: accent }}>{spark}</div>
					<div style={{ display: "flex", justifyContent: "space-between", fontSize: 24, color: MUTED }}>
						<span>0.05</span>
						<span>{volume} MON matched</span>
						<span>0.95</span>
					</div>
					<div style={{ fontSize: 24, color: MUTED, marginTop: 12 }}>{brand.tagline}</div>
				</div>
			</div>
		),
		{
			...size,
			headers: {
				// A live price should not be cached for long, but a settled market never
				// changes again.
				"cache-control": state === "live" ? "public, max-age=5" : "public, max-age=31536000, immutable",
			},
		},
	)
}
