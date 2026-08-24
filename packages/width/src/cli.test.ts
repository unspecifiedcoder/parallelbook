import assert from "node:assert/strict"
import test from "node:test"

import { parseArgs } from "./cli.ts"

test("block number and rpc are parsed", () => {
	const a = parseArgs(["block", "12345", "--rpc", "http://localhost:8545"])
	assert.equal(a.command, "block")
	assert.equal(a.block, 12345n)
	assert.equal(a.rpc, "http://localhost:8545")
	assert.equal(a.json, false)
})

test("the rpc defaults to a local node", () => {
	assert.equal(parseArgs(["block", "1"]).rpc, "http://127.0.0.1:8545")
})

test("--json is a flag", () => {
	assert.equal(parseArgs(["block", "1", "--json"]).json, true)
})

test("a missing block number is rejected rather than defaulted", () => {
	assert.throws(() => parseArgs(["block"]), /block number/)
})

test("a non-numeric block number is rejected", () => {
	assert.throws(() => parseArgs(["block", "latest"]), /block number/)
})

test("an unknown command is rejected", () => {
	assert.throws(() => parseArgs(["explode", "1"]), /unknown command/)
})
