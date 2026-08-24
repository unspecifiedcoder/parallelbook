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
