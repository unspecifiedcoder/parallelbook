import assert from "node:assert/strict"
import test from "node:test"

import { criticalPath } from "./critical-path.ts"
import { noncePreserved, reorder } from "./reorder.ts"
import type { AccessSet } from "./types.ts"

function tx(id: string, sender: string, writes: string[]): AccessSet {
	return { tx: id, sender, reads: new Set(), writes: new Set(writes) }
}

test("reordering an empty block yields an empty block", () => {
	assert.deepEqual(reorder([]), [])
})

test("every transaction survives, exactly once", () => {
	const txs = [tx("a", "0x1", ["s:1"]), tx("b", "0x2", ["s:1"]), tx("c", "0x3", ["s:2"])]
	const out = reorder(txs)
	assert.deepEqual(
		out.map((t) => t.tx).sort(),
		["a", "b", "c"],
	)
})

test("reordering cuts rounds on the case where order demonstrably matters", () => {
	const a = tx("a", "0x1", ["s:1"])
	const b = tx("b", "0x2", ["s:1", "s:2"])
	const c = tx("c", "0x3", ["s:2"])
	const before = criticalPath([a, b, c]).rounds
	const after = criticalPath(reorder([a, b, c])).rounds
	assert.equal(before, 3)
	assert.equal(after, 2)
})

test("one sender's transactions keep their relative order", () => {
	// Same sender throughout: nonces forbid ANY permutation.
	const txs = [tx("a", "0xAA", ["s:9"]), tx("b", "0xAA", ["s:1"]), tx("c", "0xAA", ["s:2"])]
	const out = reorder(txs)
	assert.deepEqual(
		out.map((t) => t.tx),
		["a", "b", "c"],
	)
	assert.equal(noncePreserved(txs, out), true)
})

test("nonce order is preserved even when other senders are interleaved", () => {
	const txs = [
		tx("a1", "0xAA", ["s:1"]),
		tx("b1", "0xBB", ["s:1"]),
		tx("a2", "0xAA", ["s:2"]),
		tx("b2", "0xBB", ["s:2"]),
	]
	const out = reorder(txs)
	assert.equal(noncePreserved(txs, out), true)
})

test("noncePreserved catches a permutation that violates a sender's order", () => {
	const txs = [tx("a", "0xAA", ["s:1"]), tx("b", "0xAA", ["s:2"])]
	assert.equal(noncePreserved(txs, [txs[1]!, txs[0]!]), false)
})

test("reordering does not increase the round count on this workload (not a general guarantee)", () => {
	// The per-sender layer floor can push a transaction past a layer it did not
	// need, and 200,000-case property testing found real counterexamples where
	// criticalPath(reorder(txs)) > criticalPath(txs). This workload happens not
	// to trigger that, but the property does not hold in general -- report.ts
	// is what clamps reorderedRounds so a report can never claim negative
	// headroom from it (see report.test.ts).
	const txs = [
		tx("a", "0x1", ["s:0"]),
		tx("b", "0x2", ["s:1"]),
		tx("c", "0x3", ["s:0"]),
		tx("d", "0x4", ["s:2"]),
		tx("e", "0x5", ["s:0"]),
	]
	const before = criticalPath(txs).rounds
	const after = criticalPath(reorder(txs)).rounds
	assert.ok(after <= before, `reorder made it worse: ${before} -> ${after}`)
})

test("a real counterexample: reorder's per-sender floor CAN increase the round count", () => {
	// Found by brute-force search over criticalPath(reorder(txs)) vs criticalPath(txs).
	// This is exactly the phenomenon I3 clamps in report.ts -- reorder.ts itself
	// makes no promise that headroom is never negative.
	const txs = [
		tx("t0", "0x0", ["s:0", "s:1"]),
		tx("t1", "0x1", ["s:3", "s:0"]),
		tx("t2", "0x0", ["s:2", "s:4"]),
		tx("t3", "0x2", ["s:2"]),
		tx("t4", "0x0", ["s:1", "s:4"]),
		tx("t5", "0x0", ["s:2"]),
		tx("t6", "0x1", ["s:4"]),
	]
	const before = criticalPath(txs).rounds
	const after = criticalPath(reorder(txs)).rounds
	assert.equal(before, 3)
	assert.equal(after, 4)
	assert.ok(after > before, "this case is supposed to demonstrate the increase")
})
