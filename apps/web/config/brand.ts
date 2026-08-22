/**
 * Every user-visible name, domain and handle lives here and nowhere else.
 * Renaming the product should be a one-file diff.
 */
export const brand = {
	name: "LiveMarkets",
	wordmark: "LIVEMARKETS",
	domain: "livemarkets.app",
	url: "https://livemarkets.app",
	tagline: "sixty seconds. one question. onchain.",
	headline: "markets that live for a minute",
	description:
		"An onchain prediction market for things happening right now. Every market opens, matches and settles inside 60 seconds.",
	handles: {
		x: "@livemarkets",
		xUrl: "https://x.com/livemarkets",
		github: "https://github.com/unspecifiedcoder/parallelbook",
		farcaster: "@livemarkets",
	},
	// Shown in the header. Do not dress test money up as real money.
	environmentLabel: "beta · monad testnet · test funds only",
	attribution: {
		artCredit: "Background plates: public-domain engravings, CC BY 4.0 treatment.",
		licence: "MIT",
	},
} as const

export type Brand = typeof brand
