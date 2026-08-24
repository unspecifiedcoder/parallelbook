import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { colour } from "./colour.ts"
import { analyse } from "./report.ts"
import type { AccessSet } from "./types.ts"

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, "../../contracts/test/accesses/matchtick-19.json")

interface Raw {
	tx: string
	sender: string
	reads: string[]
	writes: string[]
}

function load(): AccessSet[] {
	const raw = JSON.parse(readFileSync(FIXTURE, "utf8")) as Raw[]
	return raw.map((r) => ({
		tx: r.tx,
		sender: r.sender,
		reads: new Set(r.reads.map((s) => s.toLowerCase())),
		writes: new Set(r.writes.map((s) => s.toLowerCase())),
	}))
}

test("the exported workload is the one PARALLELISM.md describes", () => {
	const accesses = load()
	assert.equal(accesses.length, 19)
	for (const a of accesses) assert.ok(a.writes.size > 0, `${a.tx} wrote nothing`)
})

test("DIFFERENTIAL: the TypeScript core agrees with ConflictHarness.sol", () => {
	// ConflictHarness.sol colours this exact workload into ONE round. Two
	// implementations sharing no code, over byte-identical input.
	const accesses = load()
	assert.equal(colour(accesses).rounds, 1)
	assert.equal(analyse(accesses).stateWidth, 19)
})
