/**
 * market-math.ts
 *
 * A wei-exact mirror of the cost, payout and refund arithmetic in Market.sol.
 *
 * HARD RULE: the number this file shows in the order ticket must equal the number
 * the contract charges, to the wei. If the preview and the contract ever disagree,
 * users stop trusting the product instantly. The parity test in market-math.test.ts
 * checks this against vectors generated from the contract itself.
 *
 * Everything is bigint. No floats anywhere near collateral.
 */

export const ONE = 10_000n
export const TICK_STEP = 500n
export const NUM_TICKS = 19
export const MIN_SHARES = 10n ** 15n // anti-dust, matches Market.MIN_SHARES
export const WAD = 10n ** 18n // 1.00 share / 1.00 collateral

export class BadTickError extends Error {
	constructor(tick: number) {
		super(`bad tick ${tick}: expected 0..${NUM_TICKS - 1}`)
		this.name = "BadTickError"
	}
}

/** Round UP. Mirrors MathUp.mulDivUp. Every collateral DEBIT uses this. */
export function mulDivUp(a: bigint, b: bigint, d: bigint): bigint {
	return (a * b + d - 1n) / d
}

/** Round DOWN. Mirrors MathUp.mulDivDown. Every collateral CREDIT uses this. */
export function mulDivDown(a: bigint, b: bigint, d: bigint): bigint {
	return (a * b) / d
}

export function assertTick(tick: number): void {
	if (!Number.isInteger(tick) || tick < 0 || tick >= NUM_TICKS) throw new BadTickError(tick)
}

/** YES price at a tick, in basis points. 500..9500. */
export function price(tick: number): bigint {
	assertTick(tick)
	return (BigInt(tick) + 1n) * TICK_STEP
}

/** Price of one leg. The two legs of a tick always sum to ONE. */
export function legPrice(tick: number, isYes: boolean): bigint {
	const p = price(tick)
	return isYes ? p : ONE - p
}

/** Exact collateral required for `shares` of one leg. Rounds UP, like the contract. */
export function cost(tick: number, shares: bigint, isYes: boolean): bigint {
	return mulDivUp(shares, legPrice(tick, isYes), ONE)
}

/** The tick whose YES price is closest to a probability in bps. */
export function tickForBps(bps: number | bigint): number {
	const b = Number(bps)
	const raw = Math.round(b / Number(TICK_STEP)) - 1
	return Math.min(NUM_TICKS - 1, Math.max(0, raw))
}

/** Fee taken on winnings. Rounds DOWN, like the contract. Void pays no fee. */
export function feeOn(gross: bigint, feeBps: number, isVoid = false): bigint {
	if (isVoid || feeBps <= 0) return 0n
	return mulDivDown(gross, BigInt(feeBps), ONE)
}

export type Outcome = "unresolved" | "yes" | "no" | "void"

/**
 * Gross payout for a settled position at one tick, before fees.
 * Mirrors the per-tick branch inside Market.claim.
 */
export function grossPayout(tick: number, yesShares: bigint, noShares: bigint, outcome: Outcome): bigint {
	switch (outcome) {
		case "yes":
			return yesShares
		case "no":
			return noShares
		case "void":
			return (
				mulDivDown(yesShares, legPrice(tick, true), ONE) + mulDivDown(noShares, legPrice(tick, false), ONE)
			)
		default:
			return 0n
	}
}

/** Net payout after the protocol fee. Mirrors Market.claim's return value. */
export function netPayout(
	tick: number,
	yesShares: bigint,
	noShares: bigint,
	outcome: Outcome,
	feeBps: number,
): { gross: bigint; fee: bigint; net: bigint } {
	const gross = grossPayout(tick, yesShares, noShares, outcome)
	const fee = feeOn(gross, feeBps, outcome === "void")
	return { gross, fee, net: gross - fee }
}

/**
 * Exact refund for the unfilled part of an order.
 * Mirrors Market.withdrawOrder: paid - mulDivUp(filled, legPrice).
 * Uses the stored `paid` rather than recomputing, so it is exact.
 */
export function refundFor(order: {
	tick: number
	isYes: boolean
	shares: bigint
	filled: bigint
	paid: bigint
	withdrawn?: boolean
}): bigint {
	if (order.withdrawn) return 0n
	if (order.filled >= order.shares) return 0n
	const usedForFilled = mulDivUp(order.filled, legPrice(order.tick, order.isYes), ONE)
	return order.paid - usedForFilled
}

export type TickLevel = {
	openYes: bigint
	openNo: bigint
	matched: bigint
}

/**
 * Volume-weighted implied probability in bps. 5000 on an empty book.
 * Mirrors Market.impliedBps exactly, including the integer division.
 */
export function impliedBps(book: readonly TickLevel[]): bigint {
	let num = 0n
	let den = 0n
	for (let i = 0; i < book.length && i < NUM_TICKS; i++) {
		const t = book[i]
		if (!t) continue
		const w = t.matched * 2n + t.openYes + t.openNo
		num += w * price(i)
		den += w
	}
	return den === 0n ? ONE / 2n : num / den
}

/**
 * Everything the order ticket needs to show, in one call.
 * `maxPayout` is what the position pays if this side wins: 1.00 per share, less fee.
 */
export function quote(args: {
	tick: number
	shares: bigint
	isYes: boolean
	feeBps: number
}): {
	cost: bigint
	legPriceBps: bigint
	maxPayout: bigint
	maxProfit: bigint
	/** payout multiple on cost, scaled by 1e18 */
	payoutMultipleWad: bigint
	/** implied probability you need to break even, in bps */
	breakEvenBps: bigint
	tooSmall: boolean
} {
	const { tick, shares, isYes, feeBps } = args
	const c = cost(tick, shares, isYes)
	const gross = shares // 1.00 per winning share
	const fee = feeOn(gross, feeBps)
	const maxPayout = gross - fee
	const lp = legPrice(tick, isYes)
	return {
		cost: c,
		legPriceBps: lp,
		maxPayout,
		maxProfit: maxPayout - c,
		payoutMultipleWad: c === 0n ? 0n : (maxPayout * WAD) / c,
		// you need P(win) >= cost / payout to be better than not betting
		breakEvenBps: maxPayout === 0n ? 0n : (c * ONE) / maxPayout,
		tooSmall: shares < MIN_SHARES,
	}
}

// ------------------------------------------------------------------ formatting
// Display only. Never feed these back into collateral arithmetic.

/** 6500n -> "0.65" */
export function formatBps(bps: bigint | number): string {
	const b = BigInt(bps)
	const whole = b / ONE
	const frac = (b % ONE).toString().padStart(4, "0").slice(0, 2)
	return `${whole}.${frac}`
}

/** 6500n -> "65%" */
export function formatBpsPercent(bps: bigint | number): string {
	const b = Number(bps) / 100
	return `${b % 1 === 0 ? b.toFixed(0) : b.toFixed(1)}%`
}

/** 1500000000000000000n -> "1.50" */
export function formatWad(v: bigint, decimals = 2): string {
	const neg = v < 0n
	const abs = neg ? -v : v
	const whole = abs / WAD
	const frac = (abs % WAD).toString().padStart(18, "0").slice(0, decimals)
	const s = decimals > 0 ? `${whole}.${frac}` : whole.toString()
	return neg ? `-${s}` : s
}

/** "1.5" -> 1500000000000000000n. Throws on anything that is not a plain decimal. */
export function parseWad(input: string): bigint {
	const s = input.trim()
	if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return 0n
	const [w, f = ""] = s.split(".")
	const frac = f.padEnd(18, "0").slice(0, 18)
	return BigInt(w || "0") * WAD + BigInt(frac || "0")
}

/** 1.54x style payout multiple from a wad multiple. */
export function formatMultiple(wad: bigint): string {
	return `${formatWad(wad, 2)}x`
}

/** All 19 ticks as {tick, bps, label}. Handy for ladders and selects. */
export function ladder(): Array<{ tick: number; bps: bigint; label: string }> {
	return Array.from({ length: NUM_TICKS }, (_, i) => ({
		tick: i,
		bps: price(i),
		label: formatBps(price(i)),
	}))
}
