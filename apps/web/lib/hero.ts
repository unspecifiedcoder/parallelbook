import { readMarketList, totalMatched, type MarketSnapshot } from "./market-client"
import { OUTCOME, PHASE } from "./abi"
import { getStreamMeta } from "./stream-registry"

/**
 * What the landing hero shows.
 *
 * ONE implementation, used by both the server render (components/HeroMarket) and
 * the poll endpoint (app/api/hero). If the first paint and the refresh read the
 * chain through two different code paths, they will eventually disagree about a
 * price, and the disagreement will look like a bug in the book.
 *
 * §4.2: the hero is a REAL market. Not an illustration of one, not an ASCII
 * wordmark, not a screenshot. A visitor sees a question, two prices and two
 * clocks before they see a single word of positioning.
 */

/** bigints do not survive JSON, so the wire format is decimal strings. */
export type HeroLevel = { openYes: string; openNo: string; matched: string }

export type HeroMarket = {
	address: string
	question: string
	phase: number
	outcome: number
	openUntil: number
	resolveAfter: number
	impliedBps: string
	matchedWad: string
	levels: HeroLevel[]
	resolvingStartsAt?: number
	/** set only on the offline example, so a static card is never read as live */
	stamp?: string
	/** false for the example card, which must not link into the app */
	linkable: boolean
}

export type HeroPayload = {
	/** true when this came off the chain */
	live: boolean
	/** why it did not, shown quietly under the card rather than swallowed */
	reason?: string
	market: HeroMarket
}

function wire(s: MarketSnapshot, resolvingStartsAt?: number): HeroMarket {
	return {
		address: s.address,
		question: s.question,
		phase: s.phase,
		outcome: s.outcome,
		openUntil: s.openUntil,
		resolveAfter: s.resolveAfter,
		impliedBps: s.impliedBps.toString(),
		matchedWad: totalMatched(s.levels).toString(),
		levels: s.levels.map((l) => ({
			openYes: l.openYes.toString(),
			openNo: l.openNo.toString(),
			matched: l.matched.toString(),
		})),
		resolvingStartsAt,
		linkable: true,
	}
}

/**
 * The example card.
 *
 * §12 bans a simulated mode, and this is not one: it is stamped EXAMPLE, it does
 * not link into the app, and it only ever renders when the factory address is
 * unset or unreachable -- which is exactly the state a fresh `git clone` with no
 * env vars is in. The alternative is a landing page that renders an empty panel
 * to anyone who has not deployed the contracts yet, which is worse for an honest
 * reason: it looks broken rather than unconfigured.
 *
 * The numbers are the ones from the spec's own hero mock, so this card cannot be
 * mistaken for a plausible live book.
 */
function exampleMarket(): HeroMarket {
	const now = Math.floor(Date.now() / 1000)
	const wad = (n: number) => (BigInt(Math.round(n * 100)) * 10n ** 18n) / 100n

	// A believable 19-tick book peaked around 0.62.
	const shape = [0, 0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 55, 34, 13, 5, 2, 1, 0]
	const levels: HeroLevel[] = shape.map((v, i) => ({
		openYes: wad(i <= 11 ? v : v / 2).toString(),
		openNo: wad(i > 11 ? v : v / 2).toString(),
		matched: wad(v * 2).toString(),
	}))

	return {
		address: "0x0000000000000000000000000000000000000000",
		question: "Boundary in the next over?",
		phase: PHASE.Open,
		outcome: OUTCOME.Unresolved,
		openUntil: now + 14,
		resolveAfter: now + 59,
		impliedBps: "6200",
		matchedWad: wad(4240).toString(),
		levels,
		resolvingStartsAt: now + 15,
		stamp: "example",
		linkable: false,
	}
}

/**
 * Pick the market the landing page leads with.
 *
 * Preference order, and the reason for each:
 *   1. the newest OPEN market -- a visitor should land on something they can
 *      actually trade in the next sixty seconds.
 *   2. the most recent settled one -- proof the machine has run, with the next
 *      round's timer on it, which is far better than an empty state.
 *   3. the stamped example -- only when there is no factory to ask.
 *
 * SPEC-GAP: §4.2 says readMarketList(1). One market cannot serve both branch 1
 * and branch 2 -- if the single newest market is settled there is no open one to
 * find, and if it is open there is no settled one to fall back to. Reading a
 * small window costs one extra `recent` call and one batched round of snapshots,
 * which on 400ms blocks is not measurable.
 */
export async function readHero(): Promise<HeroPayload> {
	try {
		const markets = await readMarketList(8)
		if (markets.length === 0) {
			return { live: false, reason: "no rounds have been created yet", market: exampleMarket() }
		}

		const open = markets.find((m) => m.phase === PHASE.Open)
		const chosen = open ?? markets.find((m) => m.outcome !== OUTCOME.Unresolved) ?? markets[0]
		// The empty-list case returned above, so markets[0] exists; the index
		// signature just cannot prove it.
		if (!chosen) {
			return { live: false, reason: "no rounds have been created yet", market: exampleMarket() }
		}

		// The stream row carries resolvingStartsAt, which gates tradeability. Its
		// absence must not blank the hero, so this is best-effort.
		let resolvingStartsAt: number | undefined
		try {
			const meta = await getStreamMeta({
				address: chosen.address,
				question: chosen.question,
				openUntil: chosen.openUntil,
			})
			resolvingStartsAt = meta?.resolvingStartsAt
		} catch {
			resolvingStartsAt = undefined
		}

		return { live: true, market: wire(chosen, resolvingStartsAt) }
	} catch (err) {
		// Unset factory address, wrong chain id, RPC down. Say which.
		const reason = err instanceof Error ? err.message.split("\n")[0] : "could not reach the factory"
		return { live: false, reason, market: exampleMarket() }
	}
}
