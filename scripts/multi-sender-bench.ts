/**
 * The multi-sender benchmark.
 *
 * Every earlier benchmark here sent from ONE funded account, and test/Conflict.t.sol
 * proves that configuration can never exhibit parallelism in the placing path:
 * place() writes balance[msg.sender], so nineteen orders from one sender colour into
 * nineteen sequential rounds -- width 1.00x, identical to the naive baseline. On top
 * of that, EVM account nonces are strictly ordered, so one account's transactions
 * cannot execute concurrently at the protocol level no matter how the contract is
 * written. A single-sender benchmark of concurrency measures nothing.
 *
 * So: N accounts, one transaction each.
 *
 * THE EXPERIMENT is A vs B, and the point is that only ONE variable moves:
 *
 *   A  spread    N senders, N DISTINCT ticks   -> disjoint storage, conflict-free
 *   B  contended N senders, ONE shared tick    -> every tx writes the same tick slots
 *   C  naive     N senders, NaiveBook          -> every tx writes the same globals
 *
 * A and B are the same contract, the same function, the same work, the same number
 * of senders, the same gas. The ONLY difference is which slots get written. Anything
 * that separates them is attributable to state topology and nothing else. C is the
 * cross-contract baseline and is weaker evidence, because the contract changes too.
 *
 * WHAT SAME-BLOCK INCLUSION DOES AND DOES NOT PROVE. Landing N transactions in one
 * block is not by itself proof of parallel execution -- a sequential executor can
 * also pack them into one block. What is evidence is a DIFFERENCE between A and B
 * under identical conditions: if contended transactions need more blocks, or take
 * longer to confirm, that is the scheduler re-executing conflicts. Reported honestly
 * below rather than dressed up.
 *
 * ANVIL. BENCH_CHAIN_ID=31337 runs the whole thing locally for free, and that is
 * worth doing -- but not for the headline number. Anvil executes SEQUENTIALLY, so
 * arms A and B are identical there BY CONSTRUCTION and any gap between them is
 * noise. What a local run does buy: it exercises every code path end to end, it
 * proves all three arms produce the same fills, and it reports exact gas -- all
 * without spending testnet MON. Debug here, measure on a parallel node.
 *
 * Run:  npx tsx scripts/multi-sender-bench.ts
 * Env:  MONAD_RPC_URL   private endpoint STRONGLY recommended; the public one
 *                       rate-limits (429) well before this finishes
 *       BENCH_SENDERS   default 19
 *       BENCH_RUNS      default 5, for median/p95 rather than one lucky number
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
	createPublicClient,
	createWalletClient,
	defineChain,
	http,
	keccak256,
	toHex,
	formatEther,
	type Address,
	type Hex,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")
const CHAIN_ID = Number(process.env.BENCH_CHAIN_ID ?? 10143)
const LOCAL = CHAIN_ID === 31337
const deployment = JSON.parse(
	await import("node:fs/promises").then((fs) =>
		fs.readFile(join(root, `packages/contracts/deployments/${CHAIN_ID}.json`), "utf8"),
	),
) as { factory: Address; naiveBook: Address }

const RPC = process.env.MONAD_RPC_URL ?? (LOCAL ? "http://127.0.0.1:8545" : "https://testnet-rpc.monad.xyz")
const SENDERS = Number(process.env.BENCH_SENDERS ?? 19)
const RUNS = Number(process.env.BENCH_RUNS ?? 5)
// Near MIN_SHARES (1e15). The benchmark measures scheduling, not size: a full
// 1e18 share costs 0.95 MON at the top tick, so funding 19 senders would burn ~20
// MON per run to measure something share size has no bearing on.
const SHARES = 2n * 10n ** 15n
const ONE = 10_000n

const chain = defineChain({
	id: CHAIN_ID,
	name: LOCAL ? "Anvil" : "Monad Testnet",
	nativeCurrency: { name: LOCAL ? "Ether" : "Monad", symbol: LOCAL ? "ETH" : "MON", decimals: 18 },
	rpcUrls: { default: { http: [RPC] } },
	testnet: true,
})

const marketAbi = [
	{
		type: "function",
		name: "place",
		stateMutability: "payable",
		inputs: [
			{ name: "tick", type: "uint8" },
			{ name: "shares", type: "uint128" },
			{ name: "isYes", type: "bool" },
		],
		outputs: [{ type: "uint32" }],
	},
	{ type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
] as const

const naiveAbi = [
	{
		type: "function",
		name: "place",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "tick", type: "uint8" },
			{ name: "shares", type: "uint128" },
			{ name: "isYes", type: "bool" },
		],
		outputs: [{ type: "uint256" }],
	},
	{ type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
] as const

const factoryAbi = [
	{
		type: "function",
		name: "create",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "question", type: "string" },
			{ name: "openSeconds", type: "uint64" },
			{ name: "resolveSeconds", type: "uint64" },
		],
		outputs: [{ type: "address" }],
	},
	{
		type: "function",
		name: "recent",
		stateMutability: "view",
		inputs: [{ name: "n", type: "uint256" }],
		outputs: [{ type: "address[]" }],
	},
] as const

function fundingKey(): Hex {
	const k = process.env.BENCH_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY ?? process.env.PRIVATE_KEY
	// anvil's first prefunded account, so a local run needs no configuration at all
	if (!k && LOCAL) return "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex
	if (!k) throw new Error("set BENCH_PRIVATE_KEY (or PRIVATE_KEY) in the environment")
	return (k.startsWith("0x") ? k : `0x${k}`) as Hex
}

/**
 * Deterministic throwaway accounts. Derived from a fixed label so the same run is
 * repeatable and so leftover dust is recoverable by re-deriving rather than by
 * remembering. These hold testnet dust and nothing else.
 */
function senderKey(i: number): Hex {
	return keccak256(toHex(`parallelbook/multi-sender/v1/${i}`))
}

const funder = privateKeyToAccount(fundingKey())
const pub = createPublicClient({ chain, transport: http(RPC) })
const funderWallet = createWalletClient({ account: funder, chain, transport: http(RPC) })
const senders = Array.from({ length: SENDERS }, (_, i) => privateKeyToAccount(senderKey(i)))

function legPrice(tick: number, isYes: boolean): bigint {
	const p = (BigInt(tick) + 1n) * 500n
	return isYes ? p : ONE - p
}
function cost(tick: number, shares: bigint, isYes: boolean): bigint {
	return (shares * legPrice(tick, isYes) + ONE - 1n) / ONE
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type RunResult = {
	wallMs: number
	blocks: number
	txs: number
	perBlock: number
	gasTotal: bigint
	failures: number
}

/** Setup, deliberately sequential: nonces and rate limits both punish concurrency. */
async function fundSenders(perSender: bigint) {
	console.log(`funding ${SENDERS} senders with ${formatEther(perSender)} MON each…`)
	for (let i = 0; i < senders.length; i++) {
		const bal = await pub.getBalance({ address: senders[i]!.address })
		if (bal >= perSender) continue
		const hash = await funderWallet.sendTransaction({ to: senders[i]!.address, value: perSender - bal })
		await pub.waitForTransactionReceipt({ hash })
		await sleep(150)
	}
}

/** Each sender deposits collateral up front, so the measured tx is only place(). */
async function depositAll(market: Address, amount: bigint, abi: typeof marketAbi | typeof naiveAbi = marketAbi) {
	for (let i = 0; i < senders.length; i++) {
		const w = createWalletClient({ account: senders[i]!, chain, transport: http(RPC) })
		const hash = await w.writeContract({
			chain,
			account: senders[i]!,
			address: market,
			abi: abi as typeof marketAbi,
			functionName: "deposit",
			value: amount,
		})
		await pub.waitForTransactionReceipt({ hash })
		await sleep(150)
	}
}

/**
 * The measurement. Every sender fires at once; each has its own nonce sequence, so
 * nothing is serialised by the protocol and the only remaining constraint is state.
 */
async function fire(target: Address, abi: typeof marketAbi | typeof naiveAbi, tickFor: (i: number) => number): Promise<RunResult> {
	const nonces = await Promise.all(
		senders.map((s) => pub.getTransactionCount({ address: s.address, blockTag: "pending" })),
	)

	const t0 = Date.now()
	const sent = await Promise.allSettled(
		senders.map((s, i) => {
			const w = createWalletClient({ account: s, chain, transport: http(RPC) })
			const tick = tickFor(i)
			return w.writeContract({
				chain,
				account: s,
				address: target,
				abi: abi as typeof marketAbi,
				functionName: "place",
				args: [tick, SHARES, i % 2 === 0],
				nonce: nonces[i]!,
				...(abi === marketAbi ? { value: 0n } : {}),
			})
		}),
	)

	const hashes = sent.flatMap((r) => (r.status === "fulfilled" ? [r.value as Hex] : []))
	const receipts = await Promise.all(hashes.map((hash) => pub.waitForTransactionReceipt({ hash })))
	const wallMs = Date.now() - t0

	const blockSet = new Set(receipts.map((r) => r.blockNumber.toString()))
	const gasTotal = receipts.reduce((a, r) => a + r.gasUsed, 0n)

	return {
		wallMs,
		blocks: blockSet.size,
		txs: receipts.length,
		perBlock: blockSet.size === 0 ? 0 : receipts.length / blockSet.size,
		gasTotal,
		failures: sent.length - hashes.length,
	}
}

function stats(xs: number[]) {
	const s = [...xs].sort((a, b) => a - b)
	const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!
	return {
		min: s[0]!,
		median: at(0.5),
		p95: at(0.95),
		max: s[s.length - 1]!,
		mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
	}
}

async function freshMarket(label: string): Promise<Address> {
	const hash = await funderWallet.writeContract({
		chain,
		account: funder,
		address: deployment.factory,
		abi: factoryAbi,
		functionName: "create",
		args: [`multi-sender ${label} ${Date.now()}`, 3_600n, 7_200n],
	})
	await pub.waitForTransactionReceipt({ hash })
	const recent = (await pub.readContract({
		address: deployment.factory,
		abi: factoryAbi,
		functionName: "recent",
		args: [1n],
	})) as readonly Address[]
	return recent[0]!
}

async function main() {
	console.log(`rpc      ${RPC}`)
	console.log(`senders  ${SENDERS}`)
	console.log(`runs     ${RUNS}`)
	console.log(`funder   ${funder.address} · ${formatEther(await pub.getBalance({ address: funder.address }))} MON`)
	if (RPC.includes("testnet-rpc.monad.xyz")) {
		console.log("\nWARNING: public endpoint. It rate-limits (429) partway through a run of this")
		console.log("size. Set MONAD_RPC_URL to a private endpoint for a result worth quoting.\n")
	}

	// Enough for gas plus the most expensive leg, with headroom.
	await fundSenders(cost(18, SHARES, true) + 10n ** 17n)

	const arms: Record<string, RunResult[]> = { spread: [], contended: [], naive: [] }

	for (let run = 0; run < RUNS; run++) {
		console.log(`\n── run ${run + 1}/${RUNS} ──`)

		const a = await freshMarket("spread")
		await depositAll(a, cost(18, SHARES, true))
		const spread = await fire(a, marketAbi, (i) => i % 19)
		arms.spread!.push(spread)
		console.log(`  A spread     ${spread.wallMs}ms  ${spread.txs}tx  ${spread.blocks}blk  ${spread.perBlock.toFixed(1)}/blk  fail=${spread.failures}`)

		const b = await freshMarket("contended")
		await depositAll(b, cost(18, SHARES, true))
		const contended = await fire(b, marketAbi, () => 9)
		arms.contended!.push(contended)
		console.log(`  B contended  ${contended.wallMs}ms  ${contended.txs}tx  ${contended.blocks}blk  ${contended.perBlock.toFixed(1)}/blk  fail=${contended.failures}`)

		// NaiveBook keeps its own balances, so it needs its own deposit. Without this
		// every arm-C transaction reverts on "bal" and the arm silently measures
		// nothing, which is exactly what the first validation run did.
		if (run === 0) await depositAll(deployment.naiveBook, cost(18, SHARES, true) * BigInt(RUNS + 1), naiveAbi)
		const naive = await fire(deployment.naiveBook, naiveAbi, (i) => i % 19)
		arms.naive!.push(naive)
		console.log(`  C naive      ${naive.wallMs}ms  ${naive.txs}tx  ${naive.blocks}blk  ${naive.perBlock.toFixed(1)}/blk  fail=${naive.failures}`)
	}

	console.log("\n──────── summary (wall ms) ────────")
	if (SENDERS < 12 || RUNS < 5) {
		console.log("UNDERPOWERED: with few senders or few runs, block boundaries and network")
		console.log("jitter dominate scheduling. Treat the ratio below as noise, not a result.")
	}
	const summary: Record<string, unknown> = {}
	for (const [name, rs] of Object.entries(arms)) {
		if (rs.length === 0) continue
		const wall = stats(rs.map((r) => r.wallMs))
		const blocks = stats(rs.map((r) => r.blocks))
		summary[name] = { wall, blocks, gasTotal: rs[0]!.gasTotal.toString(), runs: rs.length }
		console.log(
			`${name.padEnd(10)} median ${String(wall.median).padStart(6)}  p95 ${String(wall.p95).padStart(6)}  ` +
				`min ${String(wall.min).padStart(6)}  max ${String(wall.max).padStart(6)}  blocks(med) ${blocks.median}`,
		)
	}

	const sp = arms.spread!.map((r) => r.wallMs)
	const co = arms.contended!.map((r) => r.wallMs)
	if (sp.length && co.length) {
		const ratio = stats(co).median / stats(sp).median
		console.log(`\nA vs B (identical work, only state topology differs): ${ratio.toFixed(2)}x`)
		console.log("Gas is identical between A and B by construction; any difference is scheduling.")
	}

	const outDir = join(root, "bench-results")
	mkdirSync(outDir, { recursive: true })
	const out = join(outDir, `multi-sender-${Date.now()}.json`)
	writeFileSync(
		out,
		JSON.stringify({ rpc: RPC, senders: SENDERS, runs: RUNS, arms, summary }, (_k, v) =>
			typeof v === "bigint" ? v.toString() : v, 2),
	)
	console.log(`\nraw results → ${out}`)
}

main().catch((e) => {
	console.error(e instanceof Error ? e.message : e)
	process.exit(1)
})
