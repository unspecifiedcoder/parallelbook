import { isAddress } from "viem"
import { notFound } from "next/navigation"

import { AppNav } from "../../../../components/AppNav"
import { MarketRoom } from "../../../../components/MarketRoom"
import { ToastProvider } from "../../../../components/ascii/Toast"
import { brand } from "../../../../config/brand"
import { readSnapshot } from "../../../../lib/market-client"
import { formatBps } from "../../../../lib/market-math"
import { getStreamMeta } from "../../../../lib/stream-registry"

/**
 * One market, server-rendered before hydration.
 *
 * The question, both prices and both countdowns are in the HTML, so the page is
 * readable and shareable before any JavaScript runs. On a sixty-second market a
 * client-side fetch waterfall would mean the round is a third over by the time
 * the first price appears.
 */
export const dynamic = "force-dynamic"
export const revalidate = 0

type Params = { params: Promise<{ address: string }> }

export async function generateMetadata({ params }: Params) {
	const { address } = await params
	if (!isAddress(address)) return { title: `not found \u00b7 ${brand.name}` }
	try {
		const snap = await readSnapshot(address as `0x${string}`)
		const title = `${snap.question} \u00b7 ${formatBps(snap.impliedBps)}`
		return {
			title,
			description: brand.tagline,
			// The card carries the price and both clocks, so a link pasted into a
			// group chat is itself an advert for a market that is open right now.
			openGraph: { title, images: [{ url: `/api/og/${address}`, width: 1200, height: 630 }] },
			twitter: { card: "summary_large_image", title },
		}
	} catch {
		return { title: brand.name }
	}
}

export default async function MarketPage({ params }: Params) {
	const { address } = await params
	if (!isAddress(address)) notFound()

	let snap
	try {
		snap = await readSnapshot(address as `0x${string}`)
	} catch {
		// An address that is well-formed but is not one of our markets is a 404,
		// not a crash.
		notFound()
	}
	// notFound() never returns, so this line is unreachable whenever the read
	// failed. It exists so the compiler knows that too: tsc can only see
	// notFound()'s `never` return once next/navigation resolves, and a throw
	// narrows regardless.
	if (!snap) throw new Error("unreachable: notFound() does not return")

	let streamMeta = null
	try {
		streamMeta = await getStreamMeta({
			address: address as `0x${string}`,
			question: snap.question,
			openUntil: snap.openUntil,
		})
	} catch {
		// The stream registry is off-chain and optional. A market with no live
		// surface is still perfectly tradeable, so this must never 500 the page.
		streamMeta = null
	}

	return (
		<div className="theme-ink">
			<AppNav />
			<ToastProvider>
				<MarketRoom
					address={address as `0x${string}`}
					initialQuestion={snap.question}
					initialPhase={snap.phase}
					initialOpenUntil={snap.openUntil}
					initialResolveAfter={snap.resolveAfter}
					initialImpliedBps={snap.impliedBps.toString()}
					initialLevels={snap.levels.map((l) => ({
						openYes: l.openYes.toString(),
						openNo: l.openNo.toString(),
						matched: l.matched.toString(),
					}))}
					/* The server's clock, so the tradeability gate cannot be moved by a
					   device with a wrong one. */
					serverNow={Date.now()}
					streamMeta={streamMeta}
					chrome={false}
				/>
			</ToastProvider>
		</div>
	)
}
