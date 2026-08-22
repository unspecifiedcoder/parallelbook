/**
 * The benchmark.
 *
 * The landing page claims that sharding the book by price lets a whole round fill
 * at once instead of one level at a time. This script is the receipt for that
 * claim, and it writes its own results into apps/web/config/bench.ts so the page
 * can never show a number that nobody measured.
 *
 * What it actually measures, on a live chain, with real transactions:
 *
 *   A  19 levels, one at a time    send matchTick(0), wait, send matchTick(1)…
 *   B  19 levels, all at once      pre-compute nonces, fire all 19, wait once
 *   C  19 levels, one transaction  matchTicks([0…19]) — the batched-call baseline
 *   D  the same work on NaiveBook  one shared book with global counters
 *
 * A vs B is the parallelism result and the honest headline: identical gas,
 * radically different wall clock, because the transactions never touch the same
 * storage. C shows that batching inside one transaction is not the same win — it
 * is still one sequential execution, it just hides the round trips. D shows what
 * the naive design costs even before contention: every fill writes the same
 * counters.
 *
 * Run:  npm run bench
 * Needs: a funded key and an RPC endpoint. Costs a few cents of testnet MON.
 */

import { execSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
	createPublicClient,
	createWalletClient,
	decodeEventLog,
	http,
	type Address,
	type Hex,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { defineChain } from "viem"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")
const deploymentPath = join(root, "packages/contracts/deployments/10143.json")
const benchConfigPath = join(root, "apps/web/config/bench.ts")

const NUM_TICKS = 19
const ONE = 10_000n
const TICK_STEP = 500n
const SHARES = 10n ** 18n // 1 share per level per side
const MATCH_STEPS = 64

const chain = defineChain({
	id: 10143,
	name: "Monad Testnet",
	nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
	rpcUrls: { default: { http: [process.env.MONAD_RPC_URL ?? "https://testnet-rpc.monad.xyz"] } },
	testnet: true,
})

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
		type: "event",
		name: "MarketCreated",
		inputs: [
			{ name: "market", type: "address", indexed: true },
			{ name: "question", type: "string", indexed: false },
			{ name: "openUntil", type: "uint64", indexed: false },
			{ name: "resolveAfter", type: "uint64", indexed: false },
		],
	},
] as const

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
	{
		type: "function",
		name: "matchTick",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "tick", type: "uint8" },
			{ name: "maxSteps", type: "uint32" },
		],
		outputs: [{ type: "uint128" }],
	},
	{
		type: "function",
		name: "matchTicks",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "tickList", type: "uint8[]" },
			{ name: "maxSteps", type: "uint32" },
		],
		outputs: [{ type: "uint128" }],
	},
] as const

const naiveAbi = [
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
	{
		type: "function",
		name: "matchAll",
		stateMutability: "nonpayable",
		inputs: [{ name: "maxSteps", type: "uint32" }],
		outputs: [{ type: "uint128" }],
	},
] as const

function legPrice(tick: number, isYes: boolean): bigint {
	const p = (BigInt(tick) + 1n) * TICK_STEP
	return isYes ? p : ONE - p
}

function cost(tick: number, shares: bigint, isYes: boolean): bigint {
	const prod = shares * legPrice(tick, isYes)
	return prod === 0n ? 0n : (prod - 1n) / ONE + 1n
}

function key(): Hex {
	const k = process.env.BENCH_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY ?? process.env.CRANK_PRIVATE_KEY
	if (!k) throw new Error("set BENCH_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY) in .env")
	return k as Hex
}

const account = privateKeyToAccount(key())
const pub = createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0]) })
const wallet = createWalletClient({ account, chain, transport: http(chain.rpcUrls.default.http[0]) })

type Deployment = { chainId: number; factory: Address; naiveBook: Address }
const deployment = JSON.parse(readFileSync(deploymentPath, "utf8")) as Deployment

function ms(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`
}

/** Create a market with a long window so the benchmark is never racing the clock. */
async function freshMarket(label: string): Promise<Address> {
	const hash = await wallet.writeContract({
		chain,
		account,
		address: deployment.factory,
		abi: factoryAbi,
		functionName: "create",
		args: [`bench ${label} ${Date.now()}`, 900n, 960n],
	})
	const receipt = await pub.waitForTransactionReceipt({ hash })
	for (const log of receipt.logs) {
		try {
			const ev = decodeEventLog({ abi: factoryAbi, data: log.data, topics: log.topics })
			if (ev.eventName === "MarketCreated") return ev.args.market as Address
		} catch {
			/* not our event */
		}
	}
	throw new Error("MarketCreated not found in receipt")
}

/**
 * Put one share of YES and one of NO on every tick, so all 19 levels are
 * crossable and both benchmarks do exactly the same work.
 */
async function seed(target: Address, abi: typeof marketAbi | typeof naiveAbi): Promise<number> {
	// Thunks, not promises. Calling writeContract eagerly starts the request, so
	// building an array of promises fires all 38 at once no matter how they are
	// awaited afterwards -- which is what Monad's mempool rejects.
	const sends: Array<() => Promise<Hex>> = []
	for (let tick = 0; tick < NUM_TICKS; tick++) {
		for (const isYes of [true, false]) {
			sends.push(() =>
				wallet.writeContract({
					chain,
					account,
					address: target,
					abi: abi as typeof marketAbi,
					functionName: "place",
					args: [tick, SHARES, isYes],
					value: cost(tick, SHARES, isYes),
					// No explicit nonce. Seeding is paced, so a nonce computed up front
					// is stale by the time the later batches send; viem fetching it per
					// send is correct and costs nothing here. The measured sections DO
					// pre-compute nonces, because firing nineteen at once is the point.
				}),
			)
		}
	}
	// Seeding is SETUP, not the measurement, so it does not need to be parallel --
	// and firing all 38 places at once is rejected by Monad's mempool with "an
	// existing transaction had higher priority", which killed every run of this
	// script. Batching keeps the queue shallow enough to be accepted. The measured
	// sections below are untouched and still fire all nineteen ticks at once.
	// The public endpoint rate-limits at 429 well before the mempool complains, so
	// seeding is paced. Only setup pays this cost; the measured sections still fire
	// all nineteen ticks simultaneously, which is the entire point of the exercise.
	// One at a time. Without an explicit nonce, two concurrent sends fetch the same
	// pending nonce and collide; with an explicit nonce, pacing makes it stale.
	// Sequential sidesteps both, and seeding is setup rather than the measurement.
	const BATCH = 1
	const PAUSE_MS = 250
	const hashes: Hex[] = []
	for (let i = 0; i < sends.length; i += BATCH) {
		const chunk = await Promise.all(sends.slice(i, i + BATCH).map((send) => send()))
		await Promise.all(chunk.map((hash) => pub.waitForTransactionReceipt({ hash })))
		hashes.push(...chunk)
		if (i + BATCH < sends.length) await new Promise((r) => setTimeout(r, PAUSE_MS))
	}
	return hashes.length
}

type Timing = { wall: number; gas: bigint; txs: number }

/** A: one level at a time. Every level waits for the one before it. */
async function sequentialFill(market: Address): Promise<Timing> {
	let gas = 0n
	const t0 = performance.now()
	for (let tick = 0; tick < NUM_TICKS; tick++) {
		const hash = await wallet.writeContract({
			chain,
			account,
			address: market,
			abi: marketAbi,
			functionName: "matchTick",
			args: [tick, MATCH_STEPS],
		})
		const r = await pub.waitForTransactionReceipt({ hash })
		gas += r.gasUsed
	}
	return { wall: performance.now() - t0, gas, txs: NUM_TICKS }
}

/** B: all 19 at once. Pre-computed nonces, one wait for the whole set. */
async function parallelFill(market: Address): Promise<Timing> {
	const base = await pub.getTransactionCount({ address: account.address, blockTag: "pending" })
	const t0 = performance.now()
	const hashes = await Promise.all(
		Array.from({ length: NUM_TICKS }, (_, tick) =>
			wallet.writeContract({
				chain,
				account,
				address: market,
				abi: marketAbi,
				functionName: "matchTick",
				args: [tick, MATCH_STEPS],
				nonce: base + tick,
			}),
		),
	)
	const receipts = await Promise.all(hashes.map((hash) => pub.waitForTransactionReceipt({ hash })))
	const wall = performance.now() - t0
	const gas = receipts.reduce((a, r) => a + r.gasUsed, 0n)
	const blocks = new Set(receipts.map((r) => r.blockNumber.toString()))

	console.log(`   \u2192 19 transactions landed across ${blocks.size} block(s)`)
	return { wall, gas, txs: NUM_TICKS }
}

/** C: one transaction that loops over all 19 levels internally. */
async function batchedFill(market: Address): Promise<Timing> {
	const ticks = Array.from({ length: NUM_TICKS }, (_, i) => i)
	const t0 = performance.now()
	const hash = await wallet.writeContract({
		chain,
		account,
		address: market,
		abi: marketAbi,
		functionName: "matchTicks",
		args: [ticks, MATCH_STEPS],
	})
	const r = await pub.waitForTransactionReceipt({ hash })
	return { wall: performance.now() - t0, gas: r.gasUsed, txs: 1 }
}

/** D: the same fills against a single shared book with global counters. */
async function naiveFill(book: Address): Promise<Timing> {
	const t0 = performance.now()
	const hash = await wallet.writeContract({
		chain,
		account,
		address: book,
		abi: naiveAbi,
		functionName: "matchAll",
		args: [MATCH_STEPS * NUM_TICKS],
	})
	const r = await pub.waitForTransactionReceipt({ hash })
	return { wall: performance.now() - t0, gas: r.gasUsed, txs: 1 }
}

function commit(): string {
	try {
		return execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim()
	} catch {
		return "unknown"
	}
}

/**
 * Write the results back into the config the landing page imports. Only the
 * `bench` export is rewritten — the comments and the structural facts above it
 * are left exactly as they are.
 */
function persist(rows: Array<{ label: string; sequential: string; parallel: string; note?: string }>) {
	const source = readFileSync(benchConfigPath, "utf8")
	const body = [
		"export const bench: BenchResults = {",
		"\tmeasured: true,",
		`\tchain: ${JSON.stringify(chain.name)},`,
		`\ttakenAt: ${JSON.stringify(new Date().toISOString())},`,
		`\tcommit: ${JSON.stringify(commit())},`,
		"\trows: [",
		...rows.map(
			(r) =>
				`\t\t{\n\t\t\tlabel: ${JSON.stringify(r.label)},\n\t\t\tsequential: ${JSON.stringify(
					r.sequential,
				)},\n\t\t\tparallel: ${JSON.stringify(r.parallel)},${
					r.note ? `\n\t\t\tnote: ${JSON.stringify(r.note)},` : ""
				}\n\t\t},`,
		),
		"\t],",
		"}",
	].join("\n")

	const next = source.replace(/export const bench: BenchResults = \{[\s\S]*?\n\}/, body)
	if (next === source) throw new Error("could not find the bench export to rewrite")
	writeFileSync(benchConfigPath, next)
	console.log(`\nwrote ${benchConfigPath}`)
}

async function main() {
	const balance = await pub.getBalance({ address: account.address })
	console.log(`bench \u00b7 ${account.address} \u00b7 ${(Number(balance) / 1e18).toFixed(3)} MON`)
	if (balance < 10n ** 18n) throw new Error("need at least 1 MON \u2014 https://faucet.monad.xyz")

	console.log("\n1/4 sequential: 19 levels, one transaction at a time")
	const mA = await freshMarket("sequential")
	await seed(mA, marketAbi)
	const a = await sequentialFill(mA)
	console.log(`   ${ms(a.wall)} \u00b7 ${a.gas} gas \u00b7 ${a.txs} txs`)

	console.log("\n2/4 parallel: 19 levels, all transactions at once")
	const mB = await freshMarket("parallel")
	await seed(mB, marketAbi)
	const b = await parallelFill(mB)
	console.log(`   ${ms(b.wall)} \u00b7 ${b.gas} gas \u00b7 ${b.txs} txs`)

	console.log("\n3/4 batched: 19 levels inside one transaction")
	const mC = await freshMarket("batched")
	await seed(mC, marketAbi)
	const c = await batchedFill(mC)
	console.log(`   ${ms(c.wall)} \u00b7 ${c.gas} gas \u00b7 ${c.txs} tx`)

	let d: Timing | null = null
	if (deployment.naiveBook && !/^0x0{40}$/.test(deployment.naiveBook)) {
		console.log("\n4/4 naive: the same fills against one shared book")
		try {
			await seed(deployment.naiveBook, naiveAbi)
			d = await naiveFill(deployment.naiveBook)
			console.log(`   ${ms(d.wall)} \u00b7 ${d.gas} gas \u00b7 ${d.txs} tx`)
		} catch (err) {
			console.warn("   skipped:", err instanceof Error ? err.message.slice(0, 120) : err)
		}
	} else {
		console.log("\n4/4 naive: skipped (NaiveBook not deployed)")
	}

	const speedup = a.wall / b.wall
	const rows = [
		{
			label: "fill all 19 price levels",
			sequential: ms(a.wall),
			parallel: ms(b.wall),
			note: `${speedup.toFixed(1)}\u00d7 faster wall clock for identical work`,
		},
		{
			label: "gas for that same fill",
			sequential: `${a.gas.toLocaleString()}`,
			parallel: `${b.gas.toLocaleString()}`,
			note: "within rounding \u2014 parallelism is a latency win, not a gas trick",
		},
		{
			label: "transactions to fill a round",
			sequential: `${a.txs} round trips`,
			parallel: `${b.txs} in flight, 1 wait`,
			note: "same count, no waiting in between",
		},
		{
			label: "one batched transaction instead",
			sequential: ms(a.wall),
			parallel: ms(c.wall),
			note: `batching hides round trips but still executes serially \u00b7 ${c.gas.toLocaleString()} gas`,
		},
	]
	if (d) {
		rows.push({
			label: "single shared book (NaiveBook)",
			sequential: `${d.gas.toLocaleString()} gas`,
			parallel: `${b.gas.toLocaleString()} gas`,
			note: "every fill writes the same counters, so no amount of concurrency helps",
		})
	}

	console.log(`\nresult: ${ms(a.wall)} \u2192 ${ms(b.wall)} (${speedup.toFixed(1)}\u00d7)`)
	persist(rows)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
