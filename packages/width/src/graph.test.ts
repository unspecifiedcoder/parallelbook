import assert from "node:assert/strict"
import test from "node:test"

import { conflicts, conflictsWithNonce, sameSender, slotKey } from "./graph.ts"
import type { AccessSet } from "./types.ts"

function tx(id: string, sender: string, reads: string[], writes: string[]): AccessSet {
	return { tx: id, sender, reads: new Set(reads), writes: new Set(writes) }
}

test("slot keys are account-qualified and lowercased", () => {
	assert.equal(slotKey("0xAbC", "0xDEF"), "0xabc:0xdef")
})

test("two transactions writing the same slot conflict", () => {
	assert.equal(conflicts(tx("a", "0x1", [], ["c:1"]), tx("b", "0x2", [], ["c:1"])), true)
})

test("a write against a read conflicts, in both directions", () => {
	assert.equal(conflicts(tx("a", "0x1", [], ["c:1"]), tx("b", "0x2", ["c:1"], [])), true)
	assert.equal(conflicts(tx("a", "0x1", ["c:1"], []), tx("b", "0x2", [], ["c:1"])), true)
})

test("shared reads are free -- that is the basis of optimistic concurrency", () => {
	assert.equal(conflicts(tx("a", "0x1", ["c:1"], []), tx("b", "0x2", ["c:1"], [])), false)
})

test("the same slot number on different accounts does not conflict", () => {
	assert.equal(conflicts(tx("a", "0x1", [], ["c1:0"]), tx("b", "0x2", [], ["c2:0"])), false)
})

test("disjoint slots do not conflict", () => {
	assert.equal(conflicts(tx("a", "0x1", [], ["c:1"]), tx("b", "0x2", [], ["c:2"])), false)
})

test("same sender is detected case-insensitively", () => {
	assert.equal(sameSender(tx("a", "0xAB", [], []), tx("b", "0xab", [], [])), true)
	assert.equal(sameSender(tx("a", "0xAB", [], []), tx("b", "0xcd", [], [])), false)
})

test("account nonces serialise one sender even with disjoint storage", () => {
	const a = tx("a", "0xAB", [], ["c:1"])
	const b = tx("b", "0xab", [], ["c:2"])
	assert.equal(conflicts(a, b), false)
	assert.equal(conflictsWithNonce(a, b), true)
})
