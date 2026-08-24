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

test("every report carries its limitations, and the output prints them", () => {
	const r = analyse([tx("a", "0x1", ["c:1"])])
	assert.ok(r.limitations.length >= 4)
	const text = formatReport(r)
	for (const line of LIMITATIONS) assert.ok(text.includes(line), `missing: ${line}`)
})
