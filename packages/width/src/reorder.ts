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
