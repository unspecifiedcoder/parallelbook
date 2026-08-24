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
