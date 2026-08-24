import assert from "node:assert/strict"
import test from "node:test"

import { accessSetFromTraces, storageSlots } from "./trace.ts"

// Captured from anvil on 2026-08-24, NaiveBook.place(3, 1e18, true).
// diffMode:false returns everything TOUCHED; diffMode:true returns, under `post`,
// everything WRITTEN. So reads = touched - writes.
const TOUCHED = {
	"0xE7f1725E7734CE288F8367e1Bb143E90bb3F0512": {
		storage: {
			"0x0000000000000000000000000000000000000000000000000000000000000000": "0x00",
			"0x0000000000000000000000000000000000000000000000000000000000000001": "0x00",
			"0xc651ee22c6951bb8b5bd29e8210fb394645a94315fe10eff2cc73de1aa75c137": "0x00",
		},
	},
}

const WRITTEN = {
	"0xE7f1725E7734CE288F8367e1Bb143E90bb3F0512": {
		storage: {
			"0x0000000000000000000000000000000000000000000000000000000000000000": "0x01",
			"0x0000000000000000000000000000000000000000000000000000000000000001": "0x01",
		},
	},
}

test("storage slots are account-qualified and lowercased", () => {
	const s = storageSlots(TOUCHED)
	assert.equal(s.size, 3)
	assert.ok(s.has("0xe7f1725e7734ce288f8367e1bb143e90bb3f0512:0x0000000000000000000000000000000000000000000000000000000000000000"))
})

test("balance-only and nonce-only entries contribute no slots", () => {
	assert.equal(storageSlots({ "0xabc": {} }).size, 0)
	assert.equal(storageSlots({}).size, 0)
})

test("reads are touched minus written", () => {
	const a = accessSetFromTraces("0xdead", "0xF39Fd6", TOUCHED, WRITTEN)
	assert.equal(a.writes.size, 2)
	assert.equal(a.reads.size, 1)
	assert.ok(a.reads.has("0xe7f1725e7734ce288f8367e1bb143e90bb3f0512:0xc651ee22c6951bb8b5bd29e8210fb394645a94315fe10eff2cc73de1aa75c137"))
	for (const w of a.writes) assert.ok(!a.reads.has(w), "a slot cannot be in both sets")
})

test("the sender is carried through, because nonces need it", () => {
	const a = accessSetFromTraces("0xdead", "0xF39Fd6", TOUCHED, WRITTEN)
	assert.equal(a.sender, "0xF39Fd6")
	assert.equal(a.tx, "0xdead")
})

test("a written slot that was never reported as touched still counts as a write", () => {
	const a = accessSetFromTraces("0x1", "0x2", {}, WRITTEN)
	assert.equal(a.writes.size, 2)
	assert.equal(a.reads.size, 0)
})
