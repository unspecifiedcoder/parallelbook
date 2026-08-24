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
