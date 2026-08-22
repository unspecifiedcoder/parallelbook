import { AppNav } from "../../../components/AppNav"
import { ReferralPanel } from "../../../components/ReferralPanel"

// Wallet state is per-visitor and only exists in the browser, so there is
// nothing correct to prerender: wagmi's hooks throw at build time because
// no WagmiProvider exists on the server. Every other wallet-facing page in
// this app already opts out the same way.
export const dynamic = "force-dynamic"

export const metadata = { title: "Invite" }

export default function InvitePage() {
	return (
		<div className="theme-ink">
			<AppNav />
			<main className="wrap" style={{ paddingTop: "var(--s6)", paddingBottom: "var(--s8)" }}>
				<h1 className="display" style={{ fontSize: "var(--t-h2)", marginTop: 0 }}>
					Invite
				</h1>
				<p className="lead" style={{ marginTop: 0, marginBottom: "var(--s5)" }}>
					A referral only counts when the person who was invited signs for it. That is the whole design: a counter
					anyone could POST to would be a number you should not trust.
				</p>
				<ReferralPanel />
			</main>
		</div>
	)
}
