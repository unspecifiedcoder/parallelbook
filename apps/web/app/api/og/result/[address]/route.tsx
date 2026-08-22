import { ImageResponse } from "next/og"
import { isAddress, type Address } from "viem"

import { brand } from "../../../../../config/brand"
import { protocol } from "../../../../../config/contracts"
import { readSnapshot } from "../../../../../lib/market-client"
import { formatBps, formatWad } from "../../../../../lib/market-math"
import { settlementOf } from "../../../../../lib/settlement"

/**
 * GET /api/og/result/0xMARKET?who=0xTRADER — the result card.
 *
 * /api/og/[address] renders the MARKET. This renders a RESULT: what one address
 * actually walked away with. That is the thing somebody wants to paste into a
 * group chat, and it is the reason to build it as a URL rather than a share
 * button -- a link renders itself everywhere, a button only works where it is.
 *
 * Same constraints as the market card: system fonts only, no remote fetches, so
 * it renders in tens of milliseconds and cannot fail because a CDN was slow.
 */

export const runtime = "edge"
const size = { width: 1200, height: 630 }

const PAPER = "#F2EFE6"
const INK = "#0B0B0C"
const ULTRA = "#1B3FD1"
const RISO = "#D6452B"
const MUTED = "#7A776E"

export async function GET(req: Request, ctx: { params: Promise<{ address: string }> }) {
	const { address } = await ctx.params
	const whoParam = new URL(req.url).searchParams.get("who")
	const who = whoParam && isAddress(whoParam) ? (whoParam as Address) : null

	let question: string = brand.headline
	let headline = "\u2014"
	let caption: string = brand.tagline
	let badge = "RESULT"
	let accent = ULTRA
	let footer: string = brand.tagline

	if (isAddress(address)) {
		try {
			// Passing `who` is what makes this a result rather than a price. With no
			// address the snapshot still returns the book, so the card degrades into
			// an outcome card instead of failing.
			const snap = who
				? await readSnapshot(address as Address, who)
				: await readSnapshot(address as Address)
			question = snap.question

			const s = settlementOf({
				outcome: snap.outcome,
				phase: snap.phase,
				yesPositions: snap.yesPositions,
				noPositions: snap.noPositions,
				feeBps: protocol.feeBps,
			})

			const label =
				s.outcome === "yes" ? "YES" : s.outcome === "no" ? "NO" : s.outcome === "void" ? "VOID" : "OPEN"
			accent = s.outcome === "no" ? RISO : ULTRA

			if (!s.settled) {
				// Never imply a result that has not happened.
				badge = "STILL OPEN"
				headline = formatBps(snap.impliedBps)
				caption = "implied probability of yes"
				footer = s.ticksHeld > 0 ? `${formatWad(s.stakedWei)} MON at risk` : brand.tagline
			} else if (!who || s.ticksHeld === 0) {
				// Settled, but nobody's position to show: an outcome card.
				badge = `SETTLED ${label}`
				headline = label
				caption = "final outcome"
				footer = brand.tagline
			} else if (s.pnlWei > 0n) {
				badge = `SETTLED ${label}`
				headline = `+${formatWad(s.pnlWei)}`
				caption = "MON profit"
				footer = `${formatWad(s.netWei)} claimed on ${formatWad(s.stakedWei)} staked \u00b7 ${formatWad(s.feeWei)} fee`
			} else {
				// A product that can only show wins is a product nobody believes. A
				// loss gets the same typography as a win.
				badge = `SETTLED ${label}`
				headline = formatWad(s.pnlWei)
				caption = "MON"
				footer = `${formatWad(s.stakedWei)} staked \u00b7 ${formatWad(s.netWei)} returned`
				accent = RISO
			}
		} catch {
			// A card that renders the brand beats a broken image in a timeline.
		}
	}

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
					<span style={{ color: accent }}>{badge}</span>
				</div>

				<div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
					<div style={{ fontSize: question.length > 70 ? 44 : 54, lineHeight: 1.15, maxWidth: 1000 }}>{question}</div>
					<div style={{ display: "flex", alignItems: "flex-end", gap: 28 }}>
						<span style={{ fontSize: headline.length > 7 ? 120 : 156, lineHeight: 1, color: accent }}>{headline}</span>
						<span style={{ fontSize: 30, color: MUTED, paddingBottom: 18 }}>{caption}</span>
					</div>
				</div>

				<div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
					<div style={{ fontSize: 26, color: MUTED }}>{footer}</div>
					<div style={{ fontSize: 22, color: MUTED }}>{brand.environmentLabel}</div>
				</div>
			</div>
		),
		{
			...size,
			headers: {
				// A settled market never changes again, so its card is immutable. An
				// open one must not be cached into looking stale.
				"cache-control": badge.startsWith("SETTLED")
					? "public, max-age=31536000, immutable"
					: "public, max-age=5",
			},
		},
	)
}
