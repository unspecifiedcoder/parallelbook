import assert from "node:assert/strict"
import test from "node:test"

import { colour, width } from "./colour.ts"
import { conflictsWithNonce } from "./graph.ts"
import type { AccessSet } from "./types.ts"

function tx(id: string, sender: string, writes: string[]): AccessSet {
	return { tx: id, sender, reads: new Set(), writes: new Set(writes) }
}

test("an empty workload has no rounds", () => {
	assert.deepEqual(colour([]), { rounds: 0, colourOf: [] })
})

test("fully disjoint writes colour into a single round", () => {
	const txs = [tx("a", "0x1", ["c:1"]), tx("b", "0x2", ["c:2"]), tx("c", "0x3", ["c:3"])]
	assert.equal(colour(txs).rounds, 1)
	assert.equal(width(3, 1), 3)
})

test("a shared slot forces one round per transaction", () => {
	const txs = [tx("a", "0x1", ["c:0"]), tx("b", "0x2", ["c:0"]), tx("c", "0x3", ["c:0"])]
	assert.equal(colour(txs).rounds, 3)
	assert.equal(width(3, 3), 1)
})

test("the nonce predicate serialises one sender despite disjoint storage", () => {
	const txs = [tx("a", "0x1", ["c:1"]), tx("b", "0x1", ["c:2"]), tx("c", "0x1", ["c:3"])]
	assert.equal(colour(txs).rounds, 1)
	assert.equal(colour(txs, conflictsWithNonce).rounds, 3)
})

test("greedy may use more rounds than optimal, and that under-reports", () => {
	// A-B and B-C conflict; A-C do not. Optimal is 2 colours, and greedy in this
	// index order also finds 2. The point of the assertion is the DIRECTION of the
	// guarantee: rounds are never fewer than the true optimum.
	const a = tx("a", "0x1", ["c:1"])
	const b = tx("b", "0x2", ["c:1", "c:2"])
	const c = tx("c", "0x3", ["c:2"])
	const r = colour([a, b, c]).rounds
	assert.ok(r >= 2, "must never claim fewer rounds than the clique requires")
	assert.equal(r, 2)
})

test("width is txs over rounds, and zero rounds is zero width", () => {
	assert.equal(width(19, 1), 19)
	assert.equal(width(19, 19), 1)
	assert.equal(width(0, 0), 0)
})
