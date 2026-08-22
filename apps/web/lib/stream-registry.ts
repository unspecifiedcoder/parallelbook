import { metaFromTemplate, templateFor } from "../config/streams"
import type { StreamMeta } from "./stream"

/**
 * Resolve the live surface for a market, server-side.
 *
 * Two sources, in priority order:
 *
 *   1. The indexer's `streams` table, written by /admin at market-creation time.
 *      This is authoritative: it is per-address, a human chose it, and it can
 *      carry a URL nobody could have predicted from the question text.
 *   2. The committed series template in config/streams.ts, for the series that
 *      mint a fresh market every sixty seconds. Re-authoring a row per minute is
 *      not operable.
 *
 * If neither produces a row, that is reported as null rather than papered over.
 * §3.2 says a market without a live surface should not have been created, so the
 * market page shows that state honestly instead of rendering an empty player.
 */

type Row = {
	marketAddress: string
	kind: string
	mode: string
	url: string | null
	ref: string | null
	title: string
	symbol: string | null
	resolvingStartsAt: number
	estimatedDelaySec: number | null
	resolutionSource: string | null
}

/**
 * Where the indexer exposes its stream rows. Unset in a fresh clone, which is
 * fine: templates cover the seeded series.
 */
const STREAMS_URL = process.env.STREAMS_API_URL

/** Short-lived cache: a stream row changes once, at market creation. */
const cache = new Map<string, { meta: StreamMeta | null; at: number }>()
const TTL_MS = 30_000

function fromRow(row: Row): StreamMeta {
	return {
		marketAddress: row.marketAddress as `0x${string}`,
		kind: row.kind as StreamMeta["kind"],
		mode: row.mode as StreamMeta["mode"],
		url: row.url ?? undefined,
		ref: row.ref ?? undefined,
		title: row.title,
		symbol: row.symbol ?? undefined,
		resolvingStartsAt: row.resolvingStartsAt,
		estimatedDelaySec: row.estimatedDelaySec ?? undefined,
		resolutionSource: row.resolutionSource ?? undefined,
	}
}

export async function getStreamMeta(args: {
	address: `0x${string}`
	question: string
	openUntil: number
}): Promise<StreamMeta | null> {
	const key = args.address.toLowerCase()
	const hit = cache.get(key)
	if (hit && Date.now() - hit.at < TTL_MS) return hit.meta

	let meta: StreamMeta | null = null

	if (STREAMS_URL) {
		try {
			const res = await fetch(`${STREAMS_URL}/${args.address}`, {
				cache: "no-store",
				signal: AbortSignal.timeout(2_000),
			})
			if (res.ok) {
				const row = (await res.json()) as Row | null
				if (row?.title) meta = fromRow(row)
			}
		} catch {
			// The indexer being down must never blank a market page. Fall through to
			// the committed template.
		}
	}

	if (!meta) {
		const t = templateFor(args.question)
		if (t) meta = metaFromTemplate(t, args.address, args.openUntil)
	}

	cache.set(key, { meta, at: Date.now() })
	return meta
}

/**
 * Bulk lookup for the list and the strip. One pass, no waterfall.
 */
export async function getStreamMetas(
	markets: Array<{ address: `0x${string}`; question: string; openUntil: number }>,
): Promise<Map<string, StreamMeta>> {
	const out = new Map<string, StreamMeta>()
	const settled = await Promise.allSettled(markets.map((m) => getStreamMeta(m)))
	settled.forEach((s, i) => {
		// allSettled preserves order and length, so markets[i] is always present --
		// but noUncheckedIndexedAccess cannot know that, so narrow it explicitly.
		const m = markets[i]
		if (!m) return
		if (s.status === "fulfilled" && s.value) out.set(m.address.toLowerCase(), s.value)
	})
	return out
}
