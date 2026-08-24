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
