import assert from "node:assert/strict"
import test from "node:test"

import { analyse, formatReport, LIMITATIONS } from "./report.ts"
import type { AccessSet } from "./types.ts"

function tx(id: string, sender: string, writes: string[]): AccessSet {
	return { tx: id, sender, reads: new Set(), writes: new Set(writes) }
}

test("a disjoint many-sender workload reports full width", () => {
	const txs = [tx("a", "0x1", ["c:1"]), tx("b", "0x2", ["c:2"]), tx("c", "0x3", ["c:3"])]
	const r = analyse(txs)
	assert.equal(r.txs, 3)
	assert.equal(r.stateWidth, 3)
	assert.equal(r.effectiveWidth, 3)
	assert.equal(r.realizedRounds, 1)
})

test("a single sender collapses effectiveWidth but not stateWidth", () => {
	const txs = [tx("a", "0xAA", ["c:1"]), tx("b", "0xAA", ["c:2"]), tx("c", "0xAA", ["c:3"])]
	const r = analyse(txs)
	assert.equal(r.stateWidth, 3, "storage really is disjoint")
	assert.equal(r.effectiveWidth, 1, "but one account's nonces serialise it anyway")
})

test("a shared slot is width one however you look at it", () => {
	const txs = [tx("a", "0x1", ["c:0"]), tx("b", "0x2", ["c:0"])]
	const r = analyse(txs)
	assert.equal(r.stateWidth, 1)
	assert.equal(r.effectiveWidth, 1)
	assert.equal(r.headroom, 1)
})

test("headroom is realized over reordered rounds", () => {
	const a = tx("a", "0x1", ["s:1"])
	const b = tx("b", "0x2", ["s:1", "s:2"])
	const c = tx("c", "0x3", ["s:2"])
	const r = analyse([a, b, c])
	assert.equal(r.realizedRounds, 3)
	assert.equal(r.reorderedRounds, 2)
	assert.equal(r.headroom, 1.5)
})

test("an empty block is reported without dividing by zero", () => {
	const r = analyse([])
	assert.equal(r.txs, 0)
	assert.equal(r.stateWidth, 0)
	assert.equal(r.headroom, 1)
})

test("headroom is never below 1.00x, even on a workload where reorder increases rounds", () => {
	// Same counterexample as reorder.test.ts: criticalPath(reorder(txs)) = 4 >
	// criticalPath(txs) = 3. Unclamped, headroom would print 0.75x -- a number
	// with no meaning ("reordering made it worse"). The original order is
	// always itself a valid nonce-preserving candidate, so report.ts clamps
	// reorderedRounds to never exceed realizedRounds.
	const txs = [
		tx("t0", "0x0", ["s:0", "s:1"]),
		tx("t1", "0x1", ["s:3", "s:0"]),
		tx("t2", "0x0", ["s:2", "s:4"]),
		tx("t3", "0x2", ["s:2"]),
		tx("t4", "0x0", ["s:1", "s:4"]),
		tx("t5", "0x0", ["s:2"]),
		tx("t6", "0x1", ["s:4"]),
	]
	const r = analyse(txs)
	assert.equal(r.realizedRounds, 3)
	assert.equal(r.reorderedRounds, 3, "clamped to realizedRounds, not the worse 4")
	assert.ok(r.headroom >= 1, `headroom went below 1.00x: ${r.headroom}`)
})

test("every report carries its limitations, and the output prints them", () => {
	const r = analyse([tx("a", "0x1", ["c:1"])])
	assert.ok(r.limitations.length >= 4)
	const text = formatReport(r)
	for (const line of LIMITATIONS) assert.ok(text.includes(line), `missing: ${line}`)
})
