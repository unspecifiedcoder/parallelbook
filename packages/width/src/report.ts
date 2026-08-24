import { colour, width } from "./colour.ts"
import { criticalPath } from "./critical-path.ts"
import { conflictsWithNonce } from "./graph.ts"
import { reorder } from "./reorder.ts"
import type { AccessSet, WidthReport } from "./types.ts"

/** Printed with every report. A number that describes its own limits is more
 *  useful than a bigger number that does not. */
export const LIMITATIONS = [
	"UPWARD bias: an SSTORE that writes a slot's EXISTING value is invisible to prestateTracer -- pre equals post, so it never appears in the diff -- and is counted as a read. Contracts that rewrite unchanged values score too high.",
	"UPWARD bias: account balances and nonces are excluded from conflicts (necessary -- every transaction pays the same fee recipient, and counting balances would make everything conflict). Native-value transfers sharing a recipient look disjoint here even though a real scheduler would serialise them on that recipient's balance.",
	"DOWNWARD bias: greedy colouring and heuristic reordering both under-report, since optimal colouring and optimal ordering are both NP-hard.",
	"width is a ceiling, not a speedup: it converts to latency only once execution, rather than block time or consensus, is the binding constraint",
	"measured traffic is not possible traffic: a quiet block scores as parallel even for a contract that would collapse under load",
	"reordering changes outcomes: a reordered block is a different block, so headroom is not free throughput",
]

export function analyse(accesses: AccessSet[]): WidthReport {
	const n = accesses.length
	const stateRounds = colour(accesses).rounds
	const effectiveRounds = colour(accesses, conflictsWithNonce).rounds
	const realizedRounds = criticalPath(accesses).rounds
	// reorder()'s per-sender layer floor can push a transaction past a layer it
	// did not need, which can make criticalPath(reorder(accesses)) WORSE than
	// the original order (I3; confirmed by property testing over 200,000 random
	// workloads). The original order is always itself a valid nonce-preserving
	// candidate, so clamping to it is sound and can never over-claim.
	const reorderedRounds = Math.min(realizedRounds, criticalPath(reorder(accesses)).rounds)

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
