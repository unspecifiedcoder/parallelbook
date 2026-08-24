import assert from "node:assert/strict"
import test from "node:test"

import { criticalPath } from "./critical-path.ts"
import type { AccessSet } from "./types.ts"

function tx(id: string, sender: string, writes: string[]): AccessSet {
	return { tx: id, sender, reads: new Set(), writes: new Set(writes) }
}

test("an empty block takes no rounds", () => {
	assert.deepEqual(criticalPath([]), { rounds: 0, roundOf: [] })
})

test("disjoint transactions all land in round one", () => {
	const txs = [tx("a", "0x1", ["c:1"]), tx("b", "0x2", ["c:2"])]
	const r = criticalPath(txs)
	assert.equal(r.rounds, 1)
	assert.deepEqual(r.roundOf, [1, 1])
})

test("a chain of conflicts costs one round per link", () => {
	const txs = [tx("a", "0x1", ["c:0"]), tx("b", "0x2", ["c:0"]), tx("c", "0x3", ["c:0"])]
	assert.deepEqual(criticalPath(txs).roundOf, [1, 2, 3])
})

test("ORDER MATTERS: the same conflicts cost different rounds", () => {
	// A-B conflict, B-C conflict, A-C independent.
	const a = tx("a", "0x1", ["s:1"])
	const b = tx("b", "0x2", ["s:1", "s:2"])
	const c = tx("c", "0x3", ["s:2"])

	// [A,B,C]: A=1, B=2 (after A), C=3 (after B)
	assert.equal(criticalPath([a, b, c]).rounds, 3)

	// [A,C,B]: A=1, C=1 (independent of A), B=2 (after both)
	assert.equal(criticalPath([a, c, b]).rounds, 2)
})

test("colouring cannot produce this number, which is why both exist", () => {
	// Documented by construction: the pair above has 2 colours in BOTH orders,
	// but the chain executing [A,B,C] genuinely spends 3 rounds.
	const a = tx("a", "0x1", ["s:1"])
	const b = tx("b", "0x2", ["s:1", "s:2"])
	const c = tx("c", "0x3", ["s:2"])
	assert.equal(criticalPath([a, b, c]).rounds, 3)
})
