/**
 * The live layer, as a type.
 *
 * A product called LiveMarkets has to be attached to something you can watch.
 * V1 had zero references to a stream anywhere -- not in the frontend, not in the
 * indexer schema, not in market metadata -- which is the single biggest gap this
 * file closes.
 *
 * WHY THIS IS OFF CHAIN
 * A stream URL is a URL: it rots, it gets region-blocked, it gets taken down, the
 * platform changes its embed path. Market bytecode must not depend on YouTube. So
 * the chain knows about the question and the money, and this record -- keyed by
 * market address -- knows about the picture. It lives in the indexer.
 *
 * HARD: every market has exactly one stream row. A market created without one is
 * invalid and /admin rejects it. "Optional stream" is what produced V1.
 */

export type StreamKind =
	| "youtube"
	| "twitch"
	| "kick"
	| "x"
	| "hls"
	| "external"
	/** the always-on price market: no video, a live price tape instead */
	| "tape"

/**
 * How the live surface renders. A product decision per market, not a capability
 * check, which is why it is stored rather than derived.
 *
 *   embed  16:9 player in the left panel, book beside it.
 *   link   platform mark, title, and "watch on <platform>" opening a new tab,
 *          with the book at full width beneath. This is the CORRECT mode for most
 *          real sports rights, not a degraded fallback, and it must look chosen.
 *   tape   last price, a 60-second character sparkline, reference exchange named.
 */
export type StreamMode = "embed" | "link" | "tape"

export type StreamMeta = {
	marketAddress: `0x${string}`
	kind: StreamKind
	/** canonical watch URL, always present except for kind "tape" */
	url?: string
	/** platform video or channel id, when the kind supports embedding */
	ref?: string
	/** shown above the player */
	title: string
	mode: StreamMode
	/** for kind "tape" -- the feed id whose price is the live surface */
	symbol?: string

	/**
	 * THE DELAY FIX. Unix seconds at which the interval this market is about
	 * begins.
	 *
	 * Every viewer's feed is behind by a different amount: broadcast HLS runs
	 * 15-45s late, low-latency Twitch 3-5s, somebody in the stadium is at zero,
	 * and a scoring API is often ahead of every broadcast. If a market can be
	 * settled by something a viewer may already have seen, whoever has the fastest
	 * feed is trading against a known outcome, and the book drains until only
	 * fast-feed operators are left.
	 *
	 * So a market is always about an interval that has NOT BEGUN YET -- "boundary
	 * in the next over", never "this over" -- and orders must close before that
	 * interval starts. The app clock is the only authority.
	 */
	resolvingStartsAt: number

	/** rough one-way latency of this feed in seconds, for the disclaimer copy */
	estimatedDelaySec?: number
	/** who or what settles it, shown on the market page */
	resolutionSource?: string
}

/** Printed under every embed. The clock wins, not the picture. */
export const DELAY_DISCLAIMER = "stream may be delayed · the clock above is authoritative"

export const PLATFORM_LABEL: Record<StreamKind, string> = {
	youtube: "YouTube",
	twitch: "Twitch",
	kick: "Kick",
	x: "X",
	hls: "Live feed",
	external: "External",
	tape: "Price tape",
}

/**
 * Trading must be shut BEFORE the resolving interval starts, even if openUntil
 * has not passed yet. Both gates, and the stricter one wins.
 *
 * This is a correctness feature, not polish: if it returns true when it should
 * not, the market is a free option for whoever has the fastest feed.
 */
export function isTradeable(args: {
	phase: number
	openUntil: number
	resolvingStartsAt?: number
	nowSec: number
}): boolean {
	if (args.phase !== 0) return false
	if (args.nowSec >= args.openUntil) return false
	if (args.resolvingStartsAt !== undefined && args.nowSec >= args.resolvingStartsAt) return false
	return true
}

/** Seconds until orders close, floored at zero. */
export function secondsToClose(openUntil: number, nowSec: number): number {
	return Math.max(0, openUntil - nowSec)
}

/** Seconds until the outcome can be posted, floored at zero. */
export function secondsToResolve(resolveAfter: number, nowSec: number): number {
	return Math.max(0, resolveAfter - nowSec)
}

/**
 * A frameable player URL, or null when the platform will not be framed.
 *
 * Returning null is not a failure: it is the signal to render link mode, which is
 * a designed state. HARD: never send a viewer to an external page for the MARKET.
 * External is fine for the STREAM -- that is what link mode is for.
 */
export function embedUrlFor(meta: StreamMeta, origin?: string): string | null {
	let parent = ""
	if (origin) {
		try {
			parent = "&parent=" + encodeURIComponent(new URL(origin).hostname)
		} catch {
			parent = ""
		}
	}

	switch (meta.kind) {
		case "youtube": {
			const id = meta.ref ?? youtubeId(meta.url)
			if (!id) return null
			// muted and inline are enforced by the player parameters, not requested
			// politely of the user.
			return (
				"https://www.youtube-nocookie.com/embed/" +
				encodeURIComponent(id) +
				"?autoplay=1&mute=1&playsinline=1&rel=0&modestbranding=1"
			)
		}
		case "twitch": {
			const channel = meta.ref ?? twitchChannel(meta.url)
			if (!channel) return null
			// Twitch refuses to frame without a parent matching the embedding host.
			if (!parent) return null
			return (
				"https://player.twitch.tv/?channel=" +
				encodeURIComponent(channel) +
				"&muted=true&autoplay=true" +
				parent
			)
		}
		case "kick": {
			const channel = meta.ref ?? lastPathSegment(meta.url)
			if (!channel) return null
			return "https://player.kick.com/" + encodeURIComponent(channel) + "?muted=true&autoplay=true"
		}
		case "hls":
			// handed to a <video>, not an iframe
			return meta.url ?? null
		case "x":
		case "external":
		case "tape":
			return null
	}
}

/**
 * The mode a piece of metadata should actually render in.
 *
 * Stored mode wins, but a market marked embed whose URL cannot produce a player
 * degrades to link rather than rendering an empty 16:9 hole.
 */
export function effectiveMode(meta: StreamMeta, origin?: string): StreamMode {
	if (meta.kind === "tape") return "tape"
	if (meta.mode === "embed" && embedUrlFor(meta, origin) === null) return "link"
	return meta.mode
}

/**
 * Validation, shared by /admin and the indexer writer so the two cannot disagree.
 * Returns human-readable problems; empty means valid.
 */
export function validateStreamMeta(meta: Partial<StreamMeta>, openUntil?: number): string[] {
	const problems: string[] = []

	if (!meta.marketAddress || !/^0x[0-9a-fA-F]{40}$/.test(meta.marketAddress)) {
		problems.push("marketAddress must be a 20-byte hex address")
	}
	if (!meta.kind) problems.push("kind is required")
	if (!meta.mode) problems.push("mode is required")
	if (!meta.title || meta.title.trim().length < 2) problems.push("title is required")

	if (meta.kind === "tape") {
		if (!meta.symbol) problems.push('kind "tape" needs a feed symbol')
	} else if (!meta.url) {
		problems.push('kind "' + String(meta.kind) + '" needs a watch url')
	}

	if (typeof meta.resolvingStartsAt !== "number" || !Number.isFinite(meta.resolvingStartsAt)) {
		problems.push("resolvingStartsAt is required: a market must be about an interval that has not begun")
	} else if (openUntil !== undefined && meta.resolvingStartsAt <= openUntil) {
		// The delay bug, caught at authoring time instead of in the book.
		problems.push(
			"orders close at " +
				openUntil +
				" but the resolving interval starts at " +
				meta.resolvingStartsAt +
				": the window must end before the interval begins, or the fastest feed trades against a known outcome",
		)
	}

	return problems
}

/* ------------------------------------------------------------------ parsing */

function lastPathSegment(url?: string): string | null {
	if (!url) return null
	try {
		const parts = new URL(url).pathname.split("/").filter(Boolean)
		return parts[parts.length - 1] ?? null
	} catch {
		return null
	}
}

export function youtubeId(url?: string): string | null {
	if (!url) return null
	try {
		const u = new URL(url)
		if (u.hostname === "youtu.be") return lastPathSegment(url)
		const v = u.searchParams.get("v")
		if (v) return v
		const m = u.pathname.match(/\/(?:live|embed|shorts)\/([A-Za-z0-9_-]{6,})/)
		return m?.[1] ?? null
	} catch {
		return null
	}
}

export function twitchChannel(url?: string): string | null {
	if (!url) return null
	try {
		const parts = new URL(url).pathname.split("/").filter(Boolean)
		return parts[0] ?? null
	} catch {
		return null
	}
}

/** Guess a kind from a pasted URL, so /admin is one paste instead of a form. */
export function kindFromUrl(url: string): StreamKind {
	let host = ""
	try {
		host = new URL(url).hostname.replace(/^www\./, "")
	} catch {
		return "external"
	}
	if (host.endsWith("youtube.com") || host === "youtu.be") return "youtube"
	if (host.endsWith("twitch.tv")) return "twitch"
	if (host.endsWith("kick.com")) return "kick"
	if (host === "x.com" || host.endsWith("twitter.com")) return "x"
	if (/\.m3u8($|\?)/.test(url)) return "hls"
	return "external"
}
