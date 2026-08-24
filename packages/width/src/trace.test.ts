import assert from "node:assert/strict"
import test from "node:test"

import { accessSetFromTraces, requirePost, requireTouched, storageSlots } from "./trace.ts"

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

// C1(a): prestateTracer's diffMode:true reports the NET diff. A reverted
// transaction leaves no trace in `post` even though it touched every slot on
// TOUCHED's list -- so a revert must be classified from the receipt, not the diff.
test("a reverted transaction counts every touched slot as a write, and reads nothing", () => {
	const a = accessSetFromTraces("0xdead", "0xF39Fd6", TOUCHED, WRITTEN, true)
	assert.equal(a.reverted, true)
	assert.equal(a.reads.size, 0)
	assert.equal(a.writes.size, 3)
	for (const s of storageSlots(TOUCHED)) assert.ok(a.writes.has(s))
})

test("a non-reverted transaction keeps the touched-minus-written derivation", () => {
	const a = accessSetFromTraces("0xdead", "0xF39Fd6", TOUCHED, WRITTEN, false)
	assert.equal(a.reverted, false)
	assert.equal(a.writes.size, 2)
	assert.equal(a.reads.size, 1)
})

// C2: an endpoint that serves prestateTracer but ignores tracerConfig.diffMode
// must not be allowed to silently report maximal width for a block it never
// actually measured.
test("requirePost throws when the diffMode:true response has no post", () => {
	assert.throws(() => requirePost(undefined, "http://x"), /diffMode/)
	assert.throws(() => requirePost(null, "http://x"), /diffMode/)
	assert.throws(() => requirePost({}, "http://x"), /diffMode/)
	assert.throws(() => requirePost({ pre: {} }, "http://x"), /diffMode/)
})

test("requirePost accepts a response that has a post, even an empty one", () => {
	assert.deepEqual(requirePost({ post: {} }, "http://x"), {})
	assert.deepEqual(requirePost({ post: WRITTEN }, "http://x"), WRITTEN)
})

test("requireTouched throws when the diffMode:false response is null or undefined", () => {
	assert.throws(() => requireTouched(null, "http://x"), /diffMode/)
	assert.throws(() => requireTouched(undefined, "http://x"), /diffMode/)
})

test("requireTouched accepts an empty object", () => {
	assert.deepEqual(requireTouched({}, "http://x"), {})
})
