/**
 * The price feed behind the always-on market.
 *
 * WHY AN ALWAYS-ON MARKET EXISTS AT ALL
 * Every live-events product dies in the gaps between events. A perpetual
 * 60-second price market runs 24/7, settles mechanically from an exchange print
 * rather than a human, gives the house maker something it can always quote, and
 * means somebody arriving at 4am sees a live book instead of an empty page. It is
 * the floor under the product, not the headline. The headline is still live
 * events.
 *
 * RULES
 *   - ONE source, named on screen. "Price feed" with no attribution is how a
 *     resolution argument starts.
 *   - Fetched SERVER-SIDE ONLY, through /api/feed, and cached. Never from the
 *     browser: a hundred viewers must not become a hundred exchange requests, and
 *     an exchange rate-limiting the app must not blank the tape.
 *   - The tape is a live surface, not the resolution oracle. The contract settles
 *     from whatever the resolver posts; this is what the viewer watches while the
 *     clock runs.
 */

export type Feed = {
	/** stable id, used in the URL and stored on the market's stream row */
	id: string
	/** shown to the user */
	label: string
	/** named on the tape so the reference is never ambiguous */
	exchange: string
	/** exchange-native symbol */
	symbol: string
	/** endpoint called from the server only */
	endpoint: string
	/** key holding the last price in the response body */
	priceKey: string
	/** decimals used when formatting the tape */
	dp: number
}

/**
 * The one feed. A public ticker endpoint: no key, no CORS games because we never
 * call it from a browser, and a symbol whose print anyone can check independently.
 *
 * Adding a feed means adding an entry here and nothing else. The tape, the API
 * route and the market metadata all key off `id`.
 */
export const FEEDS: Record<string, Feed> = {
	"eth-usdt": {
		id: "eth-usdt",
		label: "ETH / USDT",
		exchange: "Binance",
		symbol: "ETHUSDT",
		endpoint: "https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT",
		priceKey: "price",
		dp: 2,
	},
	"btc-usdt": {
		id: "btc-usdt",
		label: "BTC / USDT",
		exchange: "Binance",
		symbol: "BTCUSDT",
		endpoint: "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT",
		priceKey: "price",
		dp: 1,
	},
}

/** The feed the always-on market uses unless a market says otherwise. */
export const DEFAULT_FEED_ID = "eth-usdt"

/** How long a fetched print may be served before it is re-fetched. */
export const FEED_CACHE_MS = 1_000

/** How many samples the character sparkline holds. One per second, one minute. */
export const TAPE_SAMPLES = 60

export function feedFor(id?: string): Feed {
	// DEFAULT_FEED_ID is a key of FEEDS by construction, but an index signature
	// cannot say so. The non-null assertion is on the default only -- an unknown
	// id still falls back rather than throwing.
	return FEEDS[id ?? DEFAULT_FEED_ID] ?? FEEDS[DEFAULT_FEED_ID]!
}
