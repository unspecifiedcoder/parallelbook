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
 *
 * diffMode:true reports the NET state diff, not the write set. A REVERTED
 * transaction has no effect on `post` -- its storage snaps back -- so it would
 * otherwise report an empty write set for a transaction that, on-chain, still
 * occupied the scheduler and still invalidated every reader of the slots it
 * touched. `reverted` must therefore come from the receipt, not the diff: when
 * true, every touched slot is a write and nothing is a read.
 *
 * Not fixable from this tracer alone: an SSTORE that writes a slot's EXISTING
 * value is omitted from the diff (pre == post), so it is indistinguishable from
 * a read here. That is a named, upward-biasing limitation -- see report.ts.
 */
export function accessSetFromTraces(
	tx: string,
	sender: string,
	touched: PrestateResult,
	written: PrestateResult,
	reverted = false,
): AccessSet {
	if (reverted) {
		return { tx, sender, reads: new Set(), writes: storageSlots(touched), reverted: true }
	}
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

/**
 * C2: an RPC that SERVES prestateTracer but IGNORES tracerConfig.diffMode
 * (seen on some older geth and Erigon/Besu builds) returns no `post`, and
 * silently defaulting to `{}` there would report maximal width for a block
 * this tool never actually measured. Never default -- throw, naming the
 * endpoint's shortcoming, so the user can act on it.
 */
export function requirePost(diff: unknown, rpc: string): PrestateResult {
	if (diff === null || typeof diff !== "object" || !("post" in diff)) {
		throw new Error(
			`${rpc}: debug_traceTransaction with prestateTracer diffMode:true returned no "post" -- ` +
				"this endpoint appears not to honour prestateTracer's diffMode, and results cannot be trusted",
		)
	}
	return (diff as { post: PrestateResult }).post
}

export function requireTouched(touched: unknown, rpc: string): PrestateResult {
	if (touched === null || touched === undefined) {
		throw new Error(
			`${rpc}: debug_traceTransaction with prestateTracer diffMode:false returned no result -- ` +
				"this endpoint appears not to honour prestateTracer's diffMode, and results cannot be trusted",
		)
	}
	return touched as PrestateResult
}

export async function accessSetsForBlock(rpc: string, blockNumber: bigint): Promise<AccessSet[]> {
	const block = await rpcCall(rpc, "eth_getBlockByNumber", [`0x${blockNumber.toString(16)}`, true])
	if (!block) throw new Error(`block ${blockNumber} not found`)

	const out: AccessSet[] = []
	for (const t of block.transactions ?? []) {
		const [touchedRaw, diffRaw, receipt] = await Promise.all([
			rpcCall(rpc, "debug_traceTransaction", [t.hash, PRESTATE_TOUCHED]),
			rpcCall(rpc, "debug_traceTransaction", [t.hash, PRESTATE_WRITTEN]),
			rpcCall(rpc, "eth_getTransactionReceipt", [t.hash]),
		])
		const touched = requireTouched(touchedRaw, rpc)
		const written = requirePost(diffRaw, rpc)
		const reverted = receipt?.status === "0x0"
		out.push(accessSetFromTraces(t.hash, t.from, touched, written, reverted))
	}
	return out
}
