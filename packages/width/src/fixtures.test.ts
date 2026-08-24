import assert from "node:assert/strict"
import test from "node:test"

import { analyse } from "./report.ts"
import type { AccessSet } from "./types.ts"

const MARKET = "0xmarket"
const NAIVE = "0xnaive"
const FLASHGRID = "0xflashgrid"
const TICKS = 19

function set(sender: string, id: string, reads: string[], writes: string[]): AccessSet {
	return { tx: id, sender, reads: new Set(reads), writes: new Set(writes) }
}

/** matchTick(t) touches only tick t's own shards. Mirrors Market.sol. */
function matchTick(t: number, sender: string): AccessSet {
	return set(sender, `match-${t}`, [`${MARKET}:tick-${t}-book`], [
		`${MARKET}:tick-${t}-open`,
		`${MARKET}:tick-${t}-matched`,
		`${MARKET}:pos-${t}-maker`,
	])
}

/** NaiveBook.place writes orders.length, the open totals, and orderCount -- all
 *  shared -- plus the caller's balance. Mirrors bench/NaiveBook.sol. */
function naivePlace(i: number, sender: string): AccessSet {
	return set(sender, `naive-${i}`, [`${NAIVE}:bal-${sender}`], [
		`${NAIVE}:orders-length`,
		`${NAIVE}:total-open`,
		`${NAIVE}:order-count`,
		`${NAIVE}:bal-${sender}`,
	])
}

/** Market.place writes the tick's shard plus balance[msg.sender]. */
function marketPlace(t: number, sender: string): AccessSet {
	return set(sender, `place-${t}-${sender}`, [`${MARKET}:tick-${t}-book`], [
		`${MARKET}:tick-${t}-open`,
		`${MARKET}:bal-${sender}`,
	])
}

/** Result 4 (docs/PARALLELISM.md): market.matchTick keeps positions keyed by
 *  tick AND maker -- yesPos[tick][maker] -- so a single maker quoting across
 *  every tick still writes a DIFFERENT slot per tick, and ticks stay disjoint.
 *  This is the whole contrast against flashgrid.settleTick below, which keys
 *  its balance write by maker alone. */
function matchTickByMaker(t: number, cranker: string, maker: string): AccessSet {
	return set(cranker, `match-mk-${t}`, [`${MARKET}:tick-${t}-book`], [
		`${MARKET}:tick-${t}-open`,
		`${MARKET}:tick-${t}-matched`,
		`${MARKET}:pos-${t}-${maker}`,
	])
}

/** Result 4 (docs/PARALLELISM.md): flashgrid.settleTick writes the tick's own
 *  shard plus balances[order.maker], keyed by maker ONLY -- not by tick. Two
 *  ticks can settle concurrently only if no trader appears as maker in both,
 *  so a single market maker quoting across the book collapses every tick's
 *  settlement to fully serial. */
function settleTick(t: number, keeper: string, maker: string): AccessSet {
	return set(keeper, `settle-${t}`, [], [
		`${FLASHGRID}:tick-${t}-settled`,
		`${FLASHGRID}:balances-${maker}`,
	])
}

test("PARALLELISM.md: market.matchTick over 19 ticks is width 19.00x", () => {
	const txs = Array.from({ length: TICKS }, (_, t) => matchTick(t, `0xcranker${t}`))
	const r = analyse(txs)
	assert.equal(r.stateWidth, 19)
	assert.equal(r.realizedRounds, 1)
})

test("PARALLELISM.md: matchTick stays 19.00x under ONE shared maker", () => {
	// Positions are keyed by tick AND maker, so a single cranker does not
	// reserialise it. This is the property FlashGrid lacks.
	const txs = Array.from({ length: TICKS }, (_, t) => matchTick(t, "0xsamecranker"))
	assert.equal(analyse(txs).stateWidth, 19)
})

test("PARALLELISM.md: naive.place is width 1.00x -- the shared counter", () => {
	const txs = Array.from({ length: TICKS }, (_, i) => naivePlace(i, `0xtrader${i}`))
	const r = analyse(txs)
	assert.equal(r.stateWidth, 1)
	assert.equal(r.realizedRounds, 19)
})

test("PARALLELISM.md: place() from 19 senders is width 19.00x", () => {
	const txs = Array.from({ length: TICKS }, (_, t) => marketPlace(t, `0xtrader${t}`))
	assert.equal(analyse(txs).stateWidth, 19)
})

test("PARALLELISM.md: place() from ONE sender is width 1.00x", () => {
	// Every call writes balance[msg.sender]. This is the finding that invalidated
	// the original single-key benchmark, and the tool must reproduce it.
	const txs = Array.from({ length: TICKS }, (_, t) => marketPlace(t, "0xonetrader"))
	const r = analyse(txs)
	assert.equal(r.stateWidth, 1)
	assert.equal(r.effectiveWidth, 1)
})

test("PARALLELISM.md: contention curve, 19 txs over a shrinking spread", () => {
	const expected: Record<number, number> = { 19: 1, 10: 2, 5: 4, 2: 10, 1: 19 }
	for (const [spreadStr, rounds] of Object.entries(expected)) {
		const spread = Number(spreadStr)
		const txs = Array.from({ length: TICKS }, (_, i) => matchTick(i % spread, `0xcranker${i}`))
		assert.equal(analyse(txs).realizedRounds, rounds, `spread ${spread}`)
	}
})

// Result 4 -- these are the ONLY rows that exercise the discriminating property
// the project's argument rests on: sharding that survives a shared counterparty
// versus sharding that does not. DO NOT edit docs/PARALLELISM.md; it is the oracle.

test("PARALLELISM.md: flashgrid.settleTick with disjoint makers is width 19.00x", () => {
	const txs = Array.from({ length: TICKS }, (_, t) => settleTick(t, `0xkeeper${t}`, `0xmaker${t}`))
	const r = analyse(txs)
	assert.equal(r.stateWidth, 19)
	assert.equal(r.realizedRounds, 1)
})

test("PARALLELISM.md: flashgrid.settleTick with ONE shared maker collapses to width 1.00x", () => {
	// balances[maker] is keyed by maker alone, so a trader quoting across the
	// book reserialises every tick's settlement -- exactly the property that
	// makes FlashGrid's sharding conditional rather than real.
	const txs = Array.from({ length: TICKS }, (_, t) => settleTick(t, `0xkeeper${t}`, "0xsharedmaker"))
	const r = analyse(txs)
	assert.equal(r.stateWidth, 1)
	assert.equal(r.realizedRounds, 19)
})

test("PARALLELISM.md: market.matchTick with one shared maker stays width 19.00x", () => {
	// positions are keyed by tick AND maker, so they stay disjoint even under a
	// single shared maker -- the contrast with settleTick above is the whole
	// reason to keep this design over FlashGrid's.
	const txs = Array.from({ length: TICKS }, (_, t) => matchTickByMaker(t, `0xcranker${t}`, "0xsharedmaker"))
	const r = analyse(txs)
	assert.equal(r.stateWidth, 19)
	assert.equal(r.realizedRounds, 1)
})

test("effectiveWidth catches a disjoint workload sent from one key", () => {
	const txs = Array.from({ length: TICKS }, (_, t) => matchTick(t, "0xonekey"))
	const r = analyse(txs)
	assert.equal(r.stateWidth, 19, "storage is genuinely disjoint")
	assert.equal(r.effectiveWidth, 1, "but one account's nonces serialise it anyway")
})
