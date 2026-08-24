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
