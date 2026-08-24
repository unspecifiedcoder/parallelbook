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
