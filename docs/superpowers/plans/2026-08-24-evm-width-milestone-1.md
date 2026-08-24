# evm-width Milestone 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a tool that reads real blocks over `debug_traceTransaction` and reports how much concurrency a workload actually had, how much it could have had, and how much the block's ordering cost it.

**Architecture:** A pure core (access sets → conflict graph → four metrics) with no I/O, fed by a trace adapter that turns `prestateTracer` output into access sets. The core is ported from `packages/contracts/test/ConflictHarness.sol`, which stays in the repo as a differential oracle: two implementations sharing no code must agree.

**Tech Stack:** TypeScript, Node 22 native type stripping, `node:test` + `node:assert/strict` (zero test dependencies, matching `apps/web/lib/market-math.test.ts`), Foundry/anvil for integration fixtures.

**Spec:** `docs/superpowers/specs/2026-08-24-evm-width-design.md`

## Global Constraints

- Node `>=20.11` per root `package.json` engines; development assumes Node 22 for `.ts` execution without a loader.
- Zero runtime dependencies in `packages/width`. The repo's existing test suite runs "with nothing installed" and this must too.
- Tests use `node:test` and `node:assert/strict`. Do not add vitest, jest, or chai.
- `SlotKey` is always account-qualified: `` `${address}:${slot}` ``, both lowercased.
- **Storage slots only.** Never treat account balance or nonce changes as conflict state. Every transaction pays a fee to the block's fee recipient, so including balances would make all transactions conflict and every report would read 1.00×.
- Greedy colouring and heuristic reordering both **under-report** available concurrency. That direction is deliberate and must never be silently reversed.
- Tab indentation, double quotes, no semicolons — match `scripts/multi-sender-bench.ts`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/width/package.json` | workspace manifest, `width` bin, test script |
| `packages/width/src/types.ts` | `AccessSet`, `SlotKey`, `WidthReport` |
| `packages/width/src/graph.ts` | the conflict predicate; shared reads are free |
| `packages/width/src/colour.ts` | greedy colouring → order-free rounds |
| `packages/width/src/critical-path.ts` | order-dependent rounds (what the chain did) |
| `packages/width/src/reorder.ts` | nonce-preserving conflict-aware reordering |
| `packages/width/src/report.ts` | assembles the four metrics and the printed limitations |
| `packages/width/src/trace.ts` | `prestateTracer` → `AccessSet[]` |
| `packages/width/src/cli.ts` | `width block <n>` |
| `packages/width/src/*.test.ts` | one test file per module |

---

### Task 1: Package scaffold, types, and the conflict predicate

**Files:**
- Create: `packages/width/package.json`, `packages/width/src/types.ts`, `packages/width/src/graph.ts`, `packages/width/src/graph.test.ts`
- Modify: `package.json` (root) — add workspace and `test:width` script

**Interfaces:**
- Consumes: nothing
- Produces: `type SlotKey = string`; `interface AccessSet { tx: string; sender: string; reads: Set<SlotKey>; writes: Set<SlotKey>; reverted?: boolean }`; `slotKey(address: string, slot: string): SlotKey`; `conflicts(a: AccessSet, b: AccessSet): boolean`; `sameSender(a: AccessSet, b: AccessSet): boolean`; `conflictsWithNonce(a: AccessSet, b: AccessSet): boolean`

- [ ] **Step 1: Write the failing test**

Create `packages/width/src/graph.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/width && node --test src/graph.test.ts`
Expected: FAIL — `Cannot find module './graph.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `packages/width/package.json`:

```json
{
	"name": "@livemarkets/width",
	"version": "0.1.0",
	"private": true,
	"type": "module",
	"description": "Measures whether a contract is actually parallel.",
	"bin": { "width": "./src/cli.ts" },
	"scripts": {
		"test": "node --test src"
	}
}
```

Create `packages/width/src/types.ts`:

```ts
/** `${address}:${slot}`, both lowercased. Account-qualified so a shared token or
 *  oracle cannot vanish from the graph by colliding with another contract's slot 0. */
export type SlotKey = string

export interface AccessSet {
	tx: string
	sender: string
	reads: Set<SlotKey>
	writes: Set<SlotKey>
	/** Reverted transactions are INCLUDED. A revert still occupied the scheduler
	 *  and still forced re-execution; excluding them would flatter the number. */
	reverted?: boolean
}

export interface WidthReport {
	txs: number
	stateWidth: number
	effectiveWidth: number
	realizedRounds: number
	reorderedRounds: number
	headroom: number
	limitations: string[]
}
```

Create `packages/width/src/graph.ts`:

```ts
import type { AccessSet, SlotKey } from "./types.ts"

export function slotKey(address: string, slot: string): SlotKey {
	return `${address.toLowerCase()}:${slot.toLowerCase()}`
}

function intersects(a: Set<SlotKey>, b: Set<SlotKey>): boolean {
	const [small, large] = a.size <= b.size ? [a, b] : [b, a]
	for (const k of small) if (large.has(k)) return true
	return false
}

/**
 * Two transactions conflict when one writes a slot the other reads or writes.
 * Shared READS are deliberately free: that is the whole basis of optimistic
 * concurrency, and treating them as conflicts would understate every
 * well-designed contract.
 */
export function conflicts(a: AccessSet, b: AccessSet): boolean {
	return intersects(a.writes, b.writes) || intersects(a.writes, b.reads) || intersects(b.writes, a.reads)
}

export function sameSender(a: AccessSet, b: AccessSet): boolean {
	return a.sender.toLowerCase() === b.sender.toLowerCase()
}

/**
 * EVM account nonces are strictly ordered, so one account's transactions cannot
 * execute concurrently at the protocol level no matter how the contract is
 * written. Reporting width without this would score a single-sender workload at
 * 19x -- the exact error this project caught in its own benchmark.
 */
export function conflictsWithNonce(a: AccessSet, b: AccessSet): boolean {
	return conflicts(a, b) || sameSender(a, b)
}
```

Modify root `package.json` — add `"packages/width"` to the `workspaces` array, and add to `scripts`:

```json
"test:width": "npm -w @livemarkets/width run test"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/width && node --test src/graph.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add packages/width package.json
git commit -m "Conflict predicate, with shared reads free and nonces serialising"
```

---

### Task 2: Greedy colouring — the order-free ceiling

**Files:**
- Create: `packages/width/src/colour.ts`, `packages/width/src/colour.test.ts`

**Interfaces:**
- Consumes: `AccessSet` from `./types.ts`; `conflicts`, `conflictsWithNonce` from `./graph.ts`
- Produces: `colour(accesses: AccessSet[], conflictFn?: (a: AccessSet, b: AccessSet) => boolean): { rounds: number; colourOf: number[] }`; `width(txs: number, rounds: number): number`

- [ ] **Step 1: Write the failing test**

Create `packages/width/src/colour.test.ts`:

```ts
import assert from "node:assert/strict"
import test from "node:test"

import { colour, width } from "./colour.ts"
import { conflictsWithNonce } from "./graph.ts"
import type { AccessSet } from "./types.ts"

function tx(id: string, sender: string, writes: string[]): AccessSet {
	return { tx: id, sender, reads: new Set(), writes: new Set(writes) }
}

test("an empty workload has no rounds", () => {
	assert.deepEqual(colour([]), { rounds: 0, colourOf: [] })
})

test("fully disjoint writes colour into a single round", () => {
	const txs = [tx("a", "0x1", ["c:1"]), tx("b", "0x2", ["c:2"]), tx("c", "0x3", ["c:3"])]
	assert.equal(colour(txs).rounds, 1)
	assert.equal(width(3, 1), 3)
})

test("a shared slot forces one round per transaction", () => {
	const txs = [tx("a", "0x1", ["c:0"]), tx("b", "0x2", ["c:0"]), tx("c", "0x3", ["c:0"])]
	assert.equal(colour(txs).rounds, 3)
	assert.equal(width(3, 3), 1)
})

test("the nonce predicate serialises one sender despite disjoint storage", () => {
	const txs = [tx("a", "0x1", ["c:1"]), tx("b", "0x1", ["c:2"]), tx("c", "0x1", ["c:3"])]
	assert.equal(colour(txs).rounds, 1)
	assert.equal(colour(txs, conflictsWithNonce).rounds, 3)
})

test("greedy may use more rounds than optimal, and that under-reports", () => {
	// A-B and B-C conflict; A-C do not. Optimal is 2 colours, and greedy in this
	// index order also finds 2. The point of the assertion is the DIRECTION of the
	// guarantee: rounds are never fewer than the true optimum.
	const a = tx("a", "0x1", ["c:1"])
	const b = tx("b", "0x2", ["c:1", "c:2"])
	const c = tx("c", "0x3", ["c:2"])
	const r = colour([a, b, c]).rounds
	assert.ok(r >= 2, "must never claim fewer rounds than the clique requires")
	assert.equal(r, 2)
})

test("width is txs over rounds, and zero rounds is zero width", () => {
	assert.equal(width(19, 1), 19)
	assert.equal(width(19, 19), 1)
	assert.equal(width(0, 0), 0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/width && node --test src/colour.test.ts`
Expected: FAIL — `Cannot find module './colour.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `packages/width/src/colour.ts`:

```ts
import { conflicts } from "./graph.ts"
import type { AccessSet } from "./types.ts"

type ConflictFn = (a: AccessSet, b: AccessSet) => boolean

/**
 * Greedy graph colouring. Each colour is one round of concurrent execution, and
 * the count is ORDER-FREE: it is a property of the undirected conflict graph and
 * says what a scheduler could reach if it were free to arrange the block however
 * it liked.
 *
 * Optimal colouring is NP-hard, so greedy may use MORE rounds than necessary.
 * Reported width is therefore a conservative lower bound. For a tool whose whole
 * argument is that other benchmarks over-claim, under-claiming is the only
 * defensible direction to err in.
 */
export function colour(
	accesses: AccessSet[],
	conflictFn: ConflictFn = conflicts,
): { rounds: number; colourOf: number[] } {
	const n = accesses.length
	const colourOf: number[] = new Array(n)
	let used = 0

	for (let i = 0; i < n; ++i) {
		const blocked = new Set<number>()
		for (let j = 0; j < i; ++j) {
			if (conflictFn(accesses[i]!, accesses[j]!)) blocked.add(colourOf[j]!)
		}
		let c = 0
		while (blocked.has(c)) ++c
		colourOf[i] = c
		if (c + 1 > used) used = c + 1
	}

	return { rounds: used, colourOf }
}

export function width(txs: number, rounds: number): number {
	return rounds === 0 ? 0 : txs / rounds
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/width && node --test src/colour.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add packages/width/src/colour.ts packages/width/src/colour.test.ts
git commit -m "Greedy colouring, which under-reports on purpose"
```

---

### Task 3: Critical path — what the chain actually did

**Files:**
- Create: `packages/width/src/critical-path.ts`, `packages/width/src/critical-path.test.ts`

**Interfaces:**
- Consumes: `AccessSet`; `conflicts` from `./graph.ts`
- Produces: `criticalPath(accesses: AccessSet[], conflictFn?: (a: AccessSet, b: AccessSet) => boolean): { rounds: number; roundOf: number[] }`

- [ ] **Step 1: Write the failing test**

Create `packages/width/src/critical-path.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/width && node --test src/critical-path.test.ts`
Expected: FAIL — `Cannot find module './critical-path.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `packages/width/src/critical-path.ts`:

```ts
import { conflicts } from "./graph.ts"
import type { AccessSet } from "./types.ts"

type ConflictFn = (a: AccessSet, b: AccessSet) => boolean

/**
 * Rounds under the block's ACTUAL order.
 *
 * Monad executes optimistically in linear order and never reorders, so a
 * transaction can only settle once every earlier transaction it conflicts with
 * has settled. That makes the cost the longest path through the DAG that orders
 * conflicts by position: round(i) = 1 + max(round(j)) over conflicting j < i.
 *
 * Graph colouring cannot produce this number -- colouring is a property of the
 * undirected graph and throws the order away, so it would describe a block the
 * chain never executed.
 */
export function criticalPath(
	accesses: AccessSet[],
	conflictFn: ConflictFn = conflicts,
): { rounds: number; roundOf: number[] } {
	const n = accesses.length
	const roundOf: number[] = new Array(n)
	let deepest = 0

	for (let i = 0; i < n; ++i) {
		let r = 1
		for (let j = 0; j < i; ++j) {
			if (conflictFn(accesses[i]!, accesses[j]!) && roundOf[j]! + 1 > r) r = roundOf[j]! + 1
		}
		roundOf[i] = r
		if (r > deepest) deepest = r
	}

	return { rounds: deepest, roundOf }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/width && node --test src/critical-path.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add packages/width/src/critical-path.ts packages/width/src/critical-path.test.ts
git commit -m "Critical path, because colouring describes a block the chain never ran"
```

---

### Task 4: Nonce-preserving reordering

**Files:**
- Create: `packages/width/src/reorder.ts`, `packages/width/src/reorder.test.ts`

**Interfaces:**
- Consumes: `AccessSet`; `conflicts`, `sameSender` from `./graph.ts`
- Produces: `reorder(accesses: AccessSet[]): AccessSet[]`; `noncePreserved(before: AccessSet[], after: AccessSet[]): boolean`

- [ ] **Step 1: Write the failing test**

Create `packages/width/src/reorder.test.ts`:

```ts
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

test("reordering never increases the round count", () => {
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/width && node --test src/reorder.test.ts`
Expected: FAIL — `Cannot find module './reorder.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `packages/width/src/reorder.ts`:

```ts
import { conflicts } from "./graph.ts"
import type { AccessSet } from "./types.ts"

/**
 * A conflict-aware ordering of the same transactions.
 *
 * TWO THINGS THIS IS NOT.
 *
 * It is not free throughput. Swapping two CONFLICTING transactions changes what
 * they do -- that is what MEV is. A leader may pick any order and no rule is
 * broken, but the resulting block is not the same block, and any report built on
 * this must say so.
 *
 * It is not optimal. Minimum-round ordering is NP-hard, so this is a heuristic
 * and the round count it produces is an UPPER bound on what is achievable.
 * Reported headroom is therefore conservative, like every other number here.
 *
 * Method: assign each transaction the lowest layer not used by any earlier
 * transaction it conflicts with, floored at one past the layer of the same
 * sender's previous transaction. That floor is what makes layers strictly
 * increasing per sender, so a stable sort by layer cannot permute one account's
 * transactions -- which account nonces forbid.
 */
export function reorder(accesses: AccessSet[]): AccessSet[] {
	const n = accesses.length
	const layerOf: number[] = new Array(n)
	const lastLayerBySender = new Map<string, number>()

	for (let i = 0; i < n; ++i) {
		const me = accesses[i]!
		const blocked = new Set<number>()
		for (let j = 0; j < i; ++j) {
			if (conflicts(me, accesses[j]!)) blocked.add(layerOf[j]!)
		}
		const key = me.sender.toLowerCase()
		let layer = (lastLayerBySender.get(key) ?? -1) + 1
		while (blocked.has(layer)) ++layer
		layerOf[i] = layer
		lastLayerBySender.set(key, layer)
	}

	return accesses
		.map((a, i) => ({ a, i, layer: layerOf[i]! }))
		.sort((x, y) => x.layer - y.layer || x.i - y.i)
		.map((e) => e.a)
}

/** Every sender's transactions must appear in their original relative order. */
export function noncePreserved(before: AccessSet[], after: AccessSet[]): boolean {
	const seq = new Map<string, string[]>()
	for (const t of before) {
		const k = t.sender.toLowerCase()
		if (!seq.has(k)) seq.set(k, [])
		seq.get(k)!.push(t.tx)
	}
	const seen = new Map<string, number>()
	for (const t of after) {
		const k = t.sender.toLowerCase()
		const expected = seq.get(k)
		if (!expected) return false
		const idx = seen.get(k) ?? 0
		if (expected[idx] !== t.tx) return false
		seen.set(k, idx + 1)
	}
	return true
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/width && node --test src/reorder.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add packages/width/src/reorder.ts packages/width/src/reorder.test.ts
git commit -m "Reordering that respects nonces and admits it changes outcomes"
```

---

### Task 5: The report — four metrics and the limitations that travel with them

**Files:**
- Create: `packages/width/src/report.ts`, `packages/width/src/report.test.ts`

**Interfaces:**
- Consumes: `AccessSet`, `WidthReport`; `colour`, `width`; `criticalPath`; `reorder`; `conflictsWithNonce`
- Produces: `analyse(accesses: AccessSet[]): WidthReport`; `formatReport(r: WidthReport): string`; `LIMITATIONS: string[]`

- [ ] **Step 1: Write the failing test**

Create `packages/width/src/report.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/width && node --test src/report.test.ts`
Expected: FAIL — `Cannot find module './report.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `packages/width/src/report.ts`:

```ts
import { colour, width } from "./colour.ts"
import { criticalPath } from "./critical-path.ts"
import { conflictsWithNonce } from "./graph.ts"
import { reorder } from "./reorder.ts"
import type { AccessSet, WidthReport } from "./types.ts"

/** Printed with every report. A number that describes its own limits is more
 *  useful than a bigger number that does not. */
export const LIMITATIONS = [
	"width is a ceiling, not a speedup: it converts to latency only once execution, rather than block time or consensus, is the binding constraint",
	"measured traffic is not possible traffic: a quiet block scores as parallel even for a contract that would collapse under load",
	"greedy colouring and heuristic reordering both under-report, so these numbers are conservative",
	"reordering changes outcomes: a reordered block is a different block, so headroom is not free throughput",
	"account balances and nonces are excluded from conflicts; only storage slots count",
]

export function analyse(accesses: AccessSet[]): WidthReport {
	const n = accesses.length
	const stateRounds = colour(accesses).rounds
	const effectiveRounds = colour(accesses, conflictsWithNonce).rounds
	const realizedRounds = criticalPath(accesses).rounds
	const reorderedRounds = criticalPath(reorder(accesses)).rounds

	return {
		txs: n,
		stateWidth: width(n, stateRounds),
		effectiveWidth: width(n, effectiveRounds),
		realizedRounds,
		reorderedRounds,
		headroom: reorderedRounds === 0 ? 1 : realizedRounds / reorderedRounds,
		limitations: LIMITATIONS,
	}
}

function x(v: number): string {
	return `${v.toFixed(2)}x`
}

export function formatReport(r: WidthReport): string {
	const lines = [
		`transactions      ${r.txs}`,
		`stateWidth        ${x(r.stateWidth)}   ceiling from storage conflicts alone`,
		`effectiveWidth    ${x(r.effectiveWidth)}   after account nonces serialise each sender`,
		`realizedRounds    ${r.realizedRounds}       what the chain did, in the order it used`,
		`reorderedRounds   ${r.reorderedRounds}       the same transactions, ordered for concurrency`,
		`headroom          ${x(r.headroom)}   left on the table by fee-blind ordering`,
		"",
		"limitations:",
		...r.limitations.map((l) => `  - ${l}`),
	]
	return lines.join("\n")
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/width && node --test src/report.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add packages/width/src/report.ts packages/width/src/report.test.ts
git commit -m "Four metrics, and the limitations printed beside them"
```

---

### Task 6: Trace adapter — prestateTracer to access sets

**Files:**
- Create: `packages/width/src/trace.ts`, `packages/width/src/trace.test.ts`

**Interfaces:**
- Consumes: `AccessSet`, `SlotKey`; `slotKey` from `./graph.ts`
- Produces: `type PrestateResult = Record<string, { storage?: Record<string, string> }>`; `storageSlots(result: PrestateResult): Set<SlotKey>`; `accessSetFromTraces(tx: string, sender: string, touched: PrestateResult, written: PrestateResult, reverted?: boolean): AccessSet`; `accessSetsForBlock(rpc: string, blockNumber: bigint): Promise<AccessSet[]>`

- [ ] **Step 1: Write the failing test**

Create `packages/width/src/trace.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/width && node --test src/trace.test.ts`
Expected: FAIL — `Cannot find module './trace.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `packages/width/src/trace.ts`:

```ts
import { slotKey } from "./graph.ts"
import type { AccessSet, SlotKey } from "./types.ts"

export type PrestateResult = Record<string, { storage?: Record<string, string> }>

/**
 * ONLY storage. Account balance and nonce deltas are deliberately dropped: every
 * transaction pays a fee to the block's fee recipient, so counting balances would
 * make all transactions conflict and every report would read 1.00x.
 */
export function storageSlots(result: PrestateResult): Set<SlotKey> {
	const out = new Set<SlotKey>()
	for (const [address, entry] of Object.entries(result ?? {})) {
		for (const slot of Object.keys(entry?.storage ?? {})) out.add(slotKey(address, slot))
	}
	return out
}

/**
 * `touched` comes from prestateTracer with diffMode:false -- every slot the
 * transaction read or wrote. `written` is the `post` half of diffMode:true.
 * Verified against anvil on 2026-08-24: touched had 7 slots, written 6, and the
 * difference was the one slot that was read but never written.
 */
export function accessSetFromTraces(
	tx: string,
	sender: string,
	touched: PrestateResult,
	written: PrestateResult,
	reverted = false,
): AccessSet {
	const writes = storageSlots(written)
	const reads = new Set<SlotKey>()
	for (const s of storageSlots(touched)) if (!writes.has(s)) reads.add(s)
	return { tx, sender, reads, writes, reverted }
}

async function rpcCall(rpc: string, method: string, params: unknown[]): Promise<any> {
	const res = await fetch(rpc, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	})
	const body = await res.json()
	if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`)
	return body.result
}

const PRESTATE_TOUCHED = { tracer: "prestateTracer", tracerConfig: { diffMode: false } }
const PRESTATE_WRITTEN = { tracer: "prestateTracer", tracerConfig: { diffMode: true } }

export async function accessSetsForBlock(rpc: string, blockNumber: bigint): Promise<AccessSet[]> {
	const block = await rpcCall(rpc, "eth_getBlockByNumber", [`0x${blockNumber.toString(16)}`, true])
	if (!block) throw new Error(`block ${blockNumber} not found`)

	const out: AccessSet[] = []
	for (const t of block.transactions ?? []) {
		const [touched, diff] = await Promise.all([
			rpcCall(rpc, "debug_traceTransaction", [t.hash, PRESTATE_TOUCHED]),
			rpcCall(rpc, "debug_traceTransaction", [t.hash, PRESTATE_WRITTEN]),
		])
		out.push(accessSetFromTraces(t.hash, t.from, touched ?? {}, diff?.post ?? {}))
	}
	return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/width && node --test src/trace.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add packages/width/src/trace.ts packages/width/src/trace.test.ts
git commit -m "prestateTracer adapter: reads are touched minus written"
```

---

### Task 7: The `width block` CLI

**Files:**
- Create: `packages/width/src/cli.ts`, `packages/width/src/cli.test.ts`

**Interfaces:**
- Consumes: `accessSetsForBlock` from `./trace.ts`; `analyse`, `formatReport` from `./report.ts`
- Produces: `parseArgs(argv: string[]): { command: string; block: bigint; rpc: string; json: boolean }`; `main(argv: string[]): Promise<number>`

- [ ] **Step 1: Write the failing test**

Create `packages/width/src/cli.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/width && node --test src/cli.test.ts`
Expected: FAIL — `Cannot find module './cli.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `packages/width/src/cli.ts`:

```ts
#!/usr/bin/env node
import { analyse, formatReport } from "./report.ts"
import { accessSetsForBlock } from "./trace.ts"

export interface Args {
	command: string
	block: bigint
	rpc: string
	json: boolean
}

export function parseArgs(argv: string[]): Args {
	const command = argv[0] ?? ""
	if (command !== "block") throw new Error(`unknown command: ${command || "(none)"} -- try: width block <n>`)

	const raw = argv[1]
	if (!raw || !/^\d+$/.test(raw)) throw new Error("a block number is required: width block <n>")

	const rpcIdx = argv.indexOf("--rpc")
	return {
		command,
		block: BigInt(raw),
		rpc: rpcIdx >= 0 ? (argv[rpcIdx + 1] ?? "") : "http://127.0.0.1:8545",
		json: argv.includes("--json"),
	}
}

export async function main(argv: string[]): Promise<number> {
	let args: Args
	try {
		args = parseArgs(argv)
	} catch (e) {
		console.error(String(e instanceof Error ? e.message : e))
		return 2
	}

	try {
		const accesses = await accessSetsForBlock(args.rpc, args.block)
		const report = analyse(accesses)
		console.log(args.json ? JSON.stringify(report, null, 2) : formatReport(report))
		return 0
	} catch (e) {
		const msg = String(e instanceof Error ? e.message : e)
		console.error(msg)
		if (/method|not supported|not available/i.test(msg)) {
			console.error("\nthis endpoint does not expose debug_traceTransaction. most public RPCs disable it.")
		}
		return 1
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	process.exit(await main(process.argv.slice(2)))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/width && node --test src/cli.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add packages/width/src/cli.ts packages/width/src/cli.test.ts
git commit -m "width block <n>, and a clear message when tracing is disabled"
```

---

### Task 8: Regression fixtures — the tool must reproduce what we already proved

**Files:**
- Create: `packages/width/src/fixtures.test.ts`
- Modify: `package.json` (root) — add `test:width` into the `test` script chain

**Interfaces:**
- Consumes: `analyse` from `./report.ts`; `AccessSet` from `./types.ts`
- Produces: nothing consumed downstream

**Why this task exists:** `docs/PARALLELISM.md` records numbers established by a completely different instrument — `vm.accesses()` inside Solidity. If the TypeScript core disagrees with the Solidity oracle on the same workload, one of them is wrong. Two implementations sharing no code is the strongest check available here.

- [ ] **Step 1: Write the failing test**

Create `packages/width/src/fixtures.test.ts`:

```ts
import assert from "node:assert/strict"
import test from "node:test"

import { analyse } from "./report.ts"
import type { AccessSet } from "./types.ts"

const MARKET = "0xmarket"
const NAIVE = "0xnaive"
const TICKS = 19

function set(sender: string, id: string, reads: string[], writes: string[]): AccessSet {
	return { tx: id, sender, reads: new Set(reads), writes: new Set(writes) }
}

/** matchTick(t) touches only tick t's own shards. Mirrors Market.sol. */
function matchTick(t: number, sender: string): AccessSet {
	return set(sender, `match-${t}`, [`${MARKET}:tick-${t}-book`], [
		`${MARKET}:tick-${t}-open`,
		`${MARKET}:tick-${t}-matched`,
		`${MARKET}:pos-${t}-maker`,
	])
}

/** NaiveBook.place writes orders.length, the open totals, and orderCount -- all
 *  shared -- plus the caller's balance. Mirrors bench/NaiveBook.sol. */
function naivePlace(i: number, sender: string): AccessSet {
	return set(sender, `naive-${i}`, [`${NAIVE}:bal-${sender}`], [
		`${NAIVE}:orders-length`,
		`${NAIVE}:total-open`,
		`${NAIVE}:order-count`,
		`${NAIVE}:bal-${sender}`,
	])
}

/** Market.place writes the tick's shard plus balance[msg.sender]. */
function marketPlace(t: number, sender: string): AccessSet {
	return set(sender, `place-${t}-${sender}`, [`${MARKET}:tick-${t}-book`], [
		`${MARKET}:tick-${t}-open`,
		`${MARKET}:bal-${sender}`,
	])
}

test("PARALLELISM.md: market.matchTick over 19 ticks is width 19.00x", () => {
	const txs = Array.from({ length: TICKS }, (_, t) => matchTick(t, `0xcranker${t}`))
	const r = analyse(txs)
	assert.equal(r.stateWidth, 19)
	assert.equal(r.realizedRounds, 1)
})

test("PARALLELISM.md: matchTick stays 19.00x under ONE shared maker", () => {
	// Positions are keyed by tick AND maker, so a single cranker does not
	// reserialise it. This is the property FlashGrid lacks.
	const txs = Array.from({ length: TICKS }, (_, t) => matchTick(t, "0xsamecranker"))
	assert.equal(analyse(txs).stateWidth, 19)
})

test("PARALLELISM.md: naive.place is width 1.00x -- the shared counter", () => {
	const txs = Array.from({ length: TICKS }, (_, i) => naivePlace(i, `0xtrader${i}`))
	const r = analyse(txs)
	assert.equal(r.stateWidth, 1)
	assert.equal(r.realizedRounds, 19)
})

test("PARALLELISM.md: place() from 19 senders is width 19.00x", () => {
	const txs = Array.from({ length: TICKS }, (_, t) => marketPlace(t, `0xtrader${t}`))
	assert.equal(analyse(txs).stateWidth, 19)
})

test("PARALLELISM.md: place() from ONE sender is width 1.00x", () => {
	// Every call writes balance[msg.sender]. This is the finding that invalidated
	// the original single-key benchmark, and the tool must reproduce it.
	const txs = Array.from({ length: TICKS }, (_, t) => marketPlace(t, "0xonetrader"))
	const r = analyse(txs)
	assert.equal(r.stateWidth, 1)
	assert.equal(r.effectiveWidth, 1)
})

test("PARALLELISM.md: contention curve, 19 txs over a shrinking spread", () => {
	const expected: Record<number, number> = { 19: 1, 10: 2, 5: 4, 2: 10, 1: 19 }
	for (const [spreadStr, rounds] of Object.entries(expected)) {
		const spread = Number(spreadStr)
		const txs = Array.from({ length: TICKS }, (_, i) => matchTick(i % spread, `0xcranker${i}`))
		assert.equal(analyse(txs).realizedRounds, rounds, `spread ${spread}`)
	}
})

test("effectiveWidth catches a disjoint workload sent from one key", () => {
	const txs = Array.from({ length: TICKS }, (_, t) => matchTick(t, "0xonekey"))
	const r = analyse(txs)
	assert.equal(r.stateWidth, 19, "storage is genuinely disjoint")
	assert.equal(r.effectiveWidth, 1, "but one account's nonces serialise it anyway")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/width && node --test src/fixtures.test.ts`
Expected: FAIL — the file imports `./report.ts`, which exists, so failures here are genuine disagreements between the model and the recorded numbers. Fix the modelling helpers, never the recorded numbers.

- [ ] **Step 3: Write minimal implementation**

No new source. If a fixture fails, the bug is in `graph.ts`, `colour.ts`, `critical-path.ts`, or the helper's model of the contract — investigate in that order. `docs/PARALLELISM.md` is the oracle and does not get edited to make a test pass.

Modify root `package.json`, changing the `test` script to:

```json
"test": "npm run test:contracts && npm run test:math && npm run test:width && npm run test:model"
```

- [ ] **Step 4: Run the whole suite**

Run: `cd packages/width && node --test src` then `cd ../.. && npm test`
Expected: all width tests PASS; the contract, math and model suites still PASS

- [ ] **Step 5: Commit**

```bash
git add packages/width/src/fixtures.test.ts package.json
git commit -m "Regression fixtures: the TypeScript core must agree with the Solidity oracle"
```

---

### Task 9: True differential — export real access sets from Solidity, assert the cores agree

**Files:**
- Create: `packages/contracts/test/ExportAccesses.t.sol`, `packages/width/src/differential.test.ts`
- Modify: `packages/contracts/foundry.toml` — extend `fs_permissions` with `./test/accesses`

**Interfaces:**
- Consumes: `analyse` from `./report.ts`; `AccessSet` from `./types.ts`
- Produces: `packages/contracts/test/accesses/matchtick-19.json`, checked in

**Why this task exists:** Task 8 asserts against workloads a human modelled by hand, which tests the colouring but not the modelling. This task exports the slots `vm.accesses()` actually reported and asserts the TypeScript core reaches the same rounds. Two implementations sharing no code, over identical input, is the strongest check available.

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/test/ExportAccesses.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ConflictHarness} from "./ConflictHarness.sol";
import {Market} from "../src/Market.sol";

/// Dumps the slots vm.accesses() actually reported, so the TypeScript core can be
/// held to the same input rather than to a hand-written model of it.
///
///   forge test --mt test_exportMatchTickAccesses
contract ExportAccessesTest is ConflictHarness {
    uint8 constant TICKS = 19;
    uint128 constant SH = 1e18;

    function test_exportMatchTickAccesses() public {
        Market m = new Market("export", address(this), address(this), 100, 1_000, 3_000, 6_000);
        m.deposit{value: 400 ether}();
        for (uint8 t; t < TICKS; ++t) {
            m.place(t, SH, true);
            m.place(t, SH, false);
        }

        string memory arr = "[";
        for (uint8 t; t < TICKS; ++t) {
            vm.record();
            m.matchTick(t, 8);
            (bytes32[] memory reads, bytes32[] memory writes) = vm.accesses(address(m));

            string memory obj = string.concat('{"tx":"match-', vm.toString(uint256(t)), '","sender":"0x');
            obj = string.concat(obj, vm.toString(uint256(t)), '","reads":[', _slots(address(m), reads), '],"writes":[');
            obj = string.concat(obj, _slots(address(m), writes), "]}");

            arr = string.concat(arr, obj, t + 1 < TICKS ? "," : "");
        }
        arr = string.concat(arr, "]");

        vm.writeFile("./test/accesses/matchtick-19.json", arr);
    }

    function _slots(address who, bytes32[] memory ss) internal pure returns (string memory out) {
        for (uint256 i; i < ss.length; ++i) {
            out = string.concat(out, '"', vm.toString(who), ":", vm.toString(ss[i]), '"');
            if (i + 1 < ss.length) out = string.concat(out, ",");
        }
    }

    receive() external payable {}
}
```

Create `packages/width/src/differential.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/width && node --test src/differential.test.ts`
Expected: FAIL — `ENOENT`, the fixture has not been generated yet

- [ ] **Step 3: Generate the fixture**

Modify `packages/contracts/foundry.toml`, adding to `fs_permissions`:

```toml
  { access = "read-write", path = "./test/accesses" },
```

Then:

```bash
mkdir -p packages/contracts/test/accesses
cd packages/contracts && forge test --mt test_exportMatchTickAccesses
```

Expected: writes `packages/contracts/test/accesses/matchtick-19.json` with 19 entries.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/width && node --test src/differential.test.ts`
Expected: PASS, 2 tests

If it fails, the two implementations genuinely disagree. Do not adjust the assertion to match — find which one is wrong.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/test/ExportAccesses.t.sol packages/contracts/test/accesses packages/contracts/foundry.toml packages/width/src/differential.test.ts
git commit -m "Differential test: two cores, no shared code, identical input"
```

---

## Definition of done for Milestone 1

- [ ] `npm test` from the repo root runs the width suite alongside the contract, math and model suites
- [ ] `npx tsx packages/width/src/cli.ts block <n> --rpc http://127.0.0.1:8545` prints a report against a local anvil produced by `./scripts/local-bench.sh`
- [ ] Every number in `docs/PARALLELISM.md` is reproduced by `fixtures.test.ts`
- [ ] `differential.test.ts` proves the TypeScript core and `ConflictHarness.sol` agree on byte-identical input
- [ ] The printed report always carries its limitations
- [ ] Zero runtime dependencies added
