import assert from "node:assert/strict"
import { mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import { isMainModule, parseArgs } from "./cli.ts"

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

// I4: npm installs bin.width as a SYMLINK. Node sets process.argv[1] to the
// symlink path but import.meta.url to the REALPATH, so a naive string-equality
// guard is always false for the installed binary and the CLI silently no-ops.
test("isMainModule is true when argv[1] is a symlink resolving to this module", () => {
	const dir = mkdtempSync(join(tmpdir(), "width-cli-"))
	const link = join(dir, "width")
	const real = fileURLToPath(import.meta.url)
	try {
		symlinkSync(real, link)
		assert.equal(isMainModule(link, import.meta.url), true)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test("isMainModule is false for an unrelated path", () => {
	assert.equal(isMainModule(join(tmpdir(), "not-cli.ts"), import.meta.url), false)
})

test("isMainModule is false when argv[1] is undefined", () => {
	assert.equal(isMainModule(undefined, import.meta.url), false)
})

test("importing cli.ts from the test runner does not trigger execution", () => {
	// If the guard were ever true here, importing cli.ts would call
	// process.exit and this whole test suite would never finish running.
	assert.equal(isMainModule(process.argv[1], pathToFileURL(join(import.meta.dirname, "cli.ts")).href), false)
})
