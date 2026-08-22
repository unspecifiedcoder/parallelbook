"use client"

import { usePrivy } from "@privy-io/react-auth"
import { useAccount } from "wagmi"

import { useSignInAvailable } from "../../app/providers"

/**
 * Sign in, or say plainly that signing in is not configured.
 *
 * THE HOOK-ORDER PROBLEM THIS SOLVES
 *
 * usePrivy() throws when there is no PrivyProvider above it, and calling it
 * conditionally would break the rules of hooks. So the decision is made by
 * choosing WHICH COMPONENT TO RENDER, not by branching inside one: <SignIn>
 * always has a provider above it, <WatchOnly> never calls the hook at all. Each
 * component's hook order is therefore fixed for its whole lifetime.
 */
function WatchOnly() {
	return (
		<span className="label" title="Set NEXT_PUBLIC_PRIVY_APP_ID to enable sign-in">
			watch only
		</span>
	)
}

function SignIn({ compact }: { compact?: boolean }) {
	const { ready, authenticated, login, logout } = usePrivy()
	const { address } = useAccount()

	// Reserve the space rather than popping a button in after hydration.
	if (!ready) {
		return (
			<span className="label" aria-hidden="true">
				\u00b7\u00b7\u00b7
			</span>
		)
	}

	if (!authenticated) {
		return (
			<button className="btn" onClick={() => login()}>
				{/* Not "connect wallet": most people arriving do not have one, and the
				    passkey path does not need one. */}
				sign in
			</button>
		)
	}

	const short = address ? `${address.slice(0, 6)}\u2026${address.slice(-4)}` : "signed in"

	return (
		<span style={{ display: "inline-flex", gap: "var(--s2)", alignItems: "center" }}>
			<span className="label num" title={address}>
				{short}
			</span>
			{/* Always rendered. AppNav passes compact, and AppNav is on every app
			    page, so hiding this here meant the app had no sign-out control at
			    all -- and therefore no way to switch to a different wallet. */}
			<button className="btn btn-ghost" onClick={() => void logout()}>
				{compact ? "out" : "sign out"}
			</button>
		</span>
	)
}

export function AuthButton({ compact }: { compact?: boolean }) {
	return useSignInAvailable() ? <SignIn compact={compact} /> : <WatchOnly />
}
