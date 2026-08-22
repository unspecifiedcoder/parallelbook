"use client"

import Link from "next/link"
import { useCallback, useEffect, useRef, useState } from "react"
import { useAccount, useWriteContract } from "wagmi"

import { Countdown } from "../../components/ascii/Countdown"
import { ToastProvider, useToast } from "../../components/ascii/Toast"
import { brand } from "../../config/brand"
import { explorerTx } from "../../config/chains"
import { trust } from "../../config/contracts"
import { OUTCOME, PHASE, marketAbi } from "../../lib/abi"
import { publicClient, readMarketList, type MarketSnapshot } from "../../lib/market-client"
import { formatBps } from "../../lib/market-math"

/**
 * Resolver console.
 *
 * This is the most dangerous page in the product, so it is built to feel that way.
 *
 * Authorisation is deliberately NOT a signature check against an env allowlist.
 * An allowlist in an env var only decides who sees the buttons; the contract
 * decides who can actually resolve, and it already checks msg.sender == resolver.
 * A second, weaker gate in front of a real one is theatre, and theatre is how you
 * end up trusting the wrong thing. So the page asks the chain: it reads each
 * market's resolver and shows controls only when the connected address matches.
 *
 * Every resolution needs the outcome typed out in full. Muscle memory should not
 * be able to settle a market.
 *
 * THE KILL SWITCH (fixed here)
 *
 * Pausing had three bugs that between them made it useless:
 *
 *   1. The button only ever sent `true`. `pause()` took a boolean and the toast
 *      already said "Trading resumed", but nothing could send `false`. A kill
 *      switch you cannot un-pull is a foot-gun, not a safety feature.
 *   2. Nothing read `tradingPaused()`, so the operator could not see whether a
 *      market was already stopped.
 *   3. It was rendered only inside the `awaiting` list, which filters to
 *      `phase !== Open` -- so the stop button did not exist during the one phase
 *      in which trading happens. Exactly when you need it, it was unreachable.
 *
 * Note the deliberate asymmetry in friction: resolving is irreversible and needs
 * the outcome typed out; pausing is reversible and safety-positive, so it is one
 * click. Putting a confirmation dialog in front of an emergency stop is how the
 * stop arrives too late.
 */

const POLL_MS = 2_000
const SCAN = 24

type Controlled = {
	snap: MarketSnapshot
	resolver: string
	/** null while unread -- never rendered as "live", because unknown is not safe */
	paused: boolean | null
}

function AdminInner() {
	const { address: account, isConnected } = useAccount()
	const { writeContractAsync } = useWriteContract()
	const toast = useToast()

	const [rows, setRows] = useState<Controlled[]>([])
	const [scanned, setScanned] = useState(0)
	const [typed, setTyped] = useState("")
	const [target, setTarget] = useState<{ address: string; outcome: number; word: string } | null>(null)
	const [busy, setBusy] = useState<string | null>(null)

	/**
	 * resolver() is set in the constructor and never changes, so it is read once
	 * per market and remembered. The previous version re-read all 24 resolvers
	 * every two seconds -- about 720 needless calls a minute for an answer that
	 * cannot move.
	 */
	const resolverCache = useRef<Map<string, string>>(new Map())

	const refetch = useCallback(async () => {
		try {
			const snaps = await readMarketList(SCAN, account)
			setScanned(snaps.length)

			const unknown = snaps.filter((s) => !resolverCache.current.has(s.address.toLowerCase()))
			if (unknown.length > 0) {
				const found = await Promise.allSettled(
					unknown.map(async (s) => ({
						key: s.address.toLowerCase(),
						resolver: (await publicClient.readContract({
							address: s.address,
							abi: marketAbi,
							functionName: "resolver",
						})) as string,
					})),
				)
				for (const r of found) {
					// A failed read is simply retried on the next poll.
					if (r.status === "fulfilled") resolverCache.current.set(r.value.key, r.value.resolver)
				}
			}

			const controlled: Controlled[] = []
			for (const snap of snaps) {
				const resolver = resolverCache.current.get(snap.address.toLowerCase())
				if (!resolver) continue
				if (!account || resolver.toLowerCase() !== account.toLowerCase()) continue
				controlled.push({ snap, resolver, paused: null })
			}

			// tradingPaused IS mutable, so it has to be polled -- but only for the
			// markets this address actually controls, which is normally a handful.
			const flags = await Promise.allSettled(
				controlled.map(async (r) => ({
					key: r.snap.address.toLowerCase(),
					paused: (await publicClient.readContract({
						address: r.snap.address,
						abi: marketAbi,
						functionName: "tradingPaused",
					})) as boolean,
				})),
			)
			const pausedBy = new Map<string, boolean>()
			for (const f of flags) if (f.status === "fulfilled") pausedBy.set(f.value.key, f.value.paused)
			for (const r of controlled) {
				const v = pausedBy.get(r.snap.address.toLowerCase())
				r.paused = v === undefined ? null : v
			}

			// Most urgent first: needs an outcome, then still trading, then done.
			const rank = (r: Controlled) => {
				if (r.snap.outcome === OUTCOME.Unresolved && r.snap.phase !== PHASE.Open) return 0
				if (r.snap.phase === PHASE.Open) return 1
				if (r.snap.outcome === OUTCOME.Unresolved) return 2
				return 3
			}
			controlled.sort((a, b) => rank(a) - rank(b))

			setRows(controlled)
		} catch {
			/* the empty state below covers it */
		}
	}, [account])

	useEffect(() => {
		void refetch()
		const t = setInterval(() => {
			if (!document.hidden) void refetch()
		}, POLL_MS)
		return () => clearInterval(t)
	}, [refetch])

	const awaiting = rows.filter((r) => r.snap.outcome === OUTCOME.Unresolved && r.snap.phase !== PHASE.Open)
	const pausedCount = rows.filter((r) => r.paused === true).length

	const resolve = useCallback(async () => {
		if (!target || typed.trim().toLowerCase() !== target.word) return
		setBusy(target.address)
		try {
			const hash = await writeContractAsync({
				address: target.address as `0x${string}`,
				abi: marketAbi,
				functionName: "resolve",
				args: [target.outcome],
			})
			toast.push({ title: `Resolved ${target.word}`, body: "sent", tone: "yes", href: explorerTx(hash) })
			await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 })
			setTarget(null)
			setTyped("")
			await refetch()
		} catch (err) {
			toast.push({
				title: "Not resolved",
				body: err instanceof Error && /TooEarly/.test(err.message) ? "the resolve window has not opened" : "reverted",
				tone: "no",
			})
		} finally {
			setBusy(null)
		}
	}, [refetch, target, toast, typed, writeContractAsync])

	const setPaused = useCallback(
		async (address: string, next: boolean) => {
			setBusy(address)
			try {
				const hash = await writeContractAsync({
					address: address as `0x${string}`,
					abi: marketAbi,
					functionName: "setTradingPaused",
					args: [next],
				})
				toast.push({
					title: next ? "Trading paused" : "Trading resumed",
					body: next ? "new orders rejected · claims still work" : "orders accepted again",
					tone: next ? "no" : "yes",
					href: explorerTx(hash),
				})
				await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 })
				await refetch()
			} catch {
				// The previous version had no catch, so a revert here became an
				// unhandled rejection and the operator saw nothing at all.
				toast.push({
					title: next ? "Not paused" : "Not resumed",
					body: "the transaction did not go through. nothing changed.",
					tone: "no",
				})
			} finally {
				setBusy(null)
			}
		},
		[refetch, toast, writeContractAsync],
	)

	return (
		<div className="theme-ink">
			<header className="wrap" style={{ display: "flex", gap: "var(--s4)", alignItems: "center", paddingTop: "var(--s4)", flexWrap: "wrap" }}>
				<Link href="/app" className="display" style={{ fontSize: "var(--t-lead)", letterSpacing: "0.14em", textDecoration: "none" }}>
					{brand.wordmark}
				</Link>
				<span className="badge no">resolver console</span>
				{pausedCount > 0 ? <span className="badge no">{pausedCount} paused</span> : null}
				<Link className="btn btn-ghost" href="/app" style={{ marginLeft: "auto" }}>
					Back to rounds
				</Link>
			</header>

			<main className="wrap" style={{ paddingTop: "var(--s6)", paddingBottom: "var(--s8)" }}>
				<div className="panel" style={{ borderColor: "var(--no)" }}>
					<div className="panel-head">
						<span className="label">this is the centralisation risk</span>
					</div>
					<div className="panel-body prose">
						<p style={{ margin: 0 }}>
							{trust.detail} Resolving is final: <code>resolve()</code> reverts if the market is already settled, so
							there is no undo. {trust.roadmap[1]?.label} is next.
						</p>
						<p style={{ marginBottom: 0 }}>
							Pausing is the reversible one. It makes <code>place()</code> revert while claims and withdrawals keep
							working, so stopping a market never traps anyone&apos;s money.
						</p>
					</div>
				</div>

				{!isConnected ? (
					<p className="label" style={{ marginTop: "var(--s5)" }}>
						Connect the resolver wallet. Nothing on this page works from any other address — the contract checks,
						not the page.
					</p>
				) : rows.length === 0 ? (
					<p className="label" style={{ marginTop: "var(--s5)" }}>
						This address does not resolve any of the {scanned} recent markets. Nothing for you to do here.
					</p>
				) : (
					<>
						<h2 className="display" style={{ fontSize: "var(--t-h3)", margin: "var(--s6) 0 var(--s3)" }}>
							Markets you control ({rows.length})
						</h2>
						<p className="label" style={{ marginTop: 0, marginBottom: "var(--s4)" }}>
							{awaiting.length} awaiting an outcome · most urgent first
						</p>

						<div style={{ display: "grid", gap: "var(--s4)" }}>
							{rows.map((r) => {
								const settled = r.snap.outcome !== OUTCOME.Unresolved
								const resolvable = !settled && r.snap.phase !== PHASE.Open
								const thisBusy = busy === r.snap.address
								return (
									<div
										className="panel"
										key={r.snap.address}
										style={r.paused ? { borderColor: "var(--no)" } : undefined}
									>
										<div className="panel-head">
											<span className="label">{r.snap.address}</span>
											{/* Unknown is never rendered as "live". */}
											{r.paused === null ? (
												<span className="label muted">state unread</span>
											) : r.paused ? (
												<span className="badge no">paused</span>
											) : null}
											<span className="label num">{formatBps(r.snap.impliedBps)} implied</span>
										</div>
										<div className="panel-body" style={{ display: "grid", gap: "var(--s3)" }}>
											<strong style={{ fontSize: "var(--t-lead)" }}>{r.snap.question}</strong>
											<Countdown phase={r.snap.phase} openUntil={r.snap.openUntil} resolveAfter={r.snap.resolveAfter} />

											<div style={{ display: "flex", gap: "var(--s2)", flexWrap: "wrap" }}>
												{resolvable ? (
													<>
														<button
															className="btn btn-yes"
															disabled={thisBusy}
															onClick={() => {
																setTyped("")
																setTarget({ address: r.snap.address, outcome: OUTCOME.Yes, word: "yes" })
															}}
														>
															Yes
														</button>
														<button
															className="btn btn-no"
															disabled={thisBusy}
															onClick={() => {
																setTyped("")
																setTarget({ address: r.snap.address, outcome: OUTCOME.No, word: "no" })
															}}
														>
															No
														</button>
														<button
															className="btn btn-ghost"
															disabled={thisBusy}
															onClick={() => {
																setTyped("")
																setTarget({ address: r.snap.address, outcome: OUTCOME.Void, word: "void" })
															}}
															title="Void refunds both legs at the price they paid and charges no fee"
														>
															Void
														</button>
													</>
												) : (
													<span className="label">
														{settled
															? `settled · ${["", "yes", "no", "void"][r.snap.outcome]}`
															: "still open · no outcome until orders close"}
													</span>
												)}

												{/* THE STOP BUTTON IS ALWAYS HERE, including while the market is
												    open -- which is the only phase where stopping does anything.
												    Hidden once settled, where it would be meaningless. */}
												{!settled ? (
													<button
														className={r.paused ? "btn btn-yes" : "btn btn-no"}
														disabled={thisBusy || r.paused === null}
														style={{ marginLeft: "auto" }}
														title={
															r.paused === null
																? "waiting for the current paused state"
																: r.paused
																	? "Accept orders again"
																	: "Reject new orders. Claims and withdrawals keep working."
														}
														onClick={() => void setPaused(r.snap.address, !r.paused)}
													>
														{thisBusy ? "signing…" : r.paused ? "Resume trading" : "Pause trading"}
													</button>
												) : null}
											</div>

											{target && target.address === r.snap.address ? (
												<div className="panel" style={{ borderColor: "var(--no)" }}>
													<div className="panel-body" style={{ display: "grid", gap: "var(--s2)" }}>
														<span className="label">
															Type <strong>{target.word}</strong> to settle this market permanently
														</span>
														<div style={{ display: "flex", gap: "var(--s2)" }}>
															<input
																className="input"
																value={typed}
																autoFocus
																onChange={(e) => setTyped(e.target.value)}
																placeholder={target.word}
															/>
															<button
																className="btn btn-no"
																disabled={thisBusy || typed.trim().toLowerCase() !== target.word}
																onClick={() => void resolve()}
															>
																{thisBusy ? "signing…" : `Settle ${target.word}`}
															</button>
															<button className="btn btn-ghost" onClick={() => setTarget(null)}>
																Cancel
															</button>
														</div>
													</div>
												</div>
											) : null}
										</div>
									</div>
								)
							})}
						</div>

						<p className="label" style={{ marginTop: "var(--s5)" }}>
							Scanned the {scanned} most recent markets. Any resolved by another address are not shown.
						</p>
					</>
				)}
			</main>
		</div>
	)
}

export default function AdminPage() {
	return (
		<ToastProvider>
			<AdminInner />
		</ToastProvider>
	)
}
