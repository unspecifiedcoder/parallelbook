/** @type {import('next').NextConfig} */
const nextConfig = {
	reactStrictMode: true,

	// The contracts package is imported for ABIs, deployment addresses and the
	// shared cost vectors. Next needs to know it is part of the monorepo.
	transpilePackages: [],

	experimental: {
		// deployments/*.json and the ABIs live outside apps/web
		externalDir: true,
	},

	// @coinbase/cdp-sdk ships an x402 payment path that imports @x402/* as
	// OPTIONAL peers, and does it with static imports, so webpack tries to
	// resolve them whether or not the code runs. Nothing here uses Base Account
	// payments -- the SDK arrives transitively via
	// @privy-io/wagmi -> wagmi -> @wagmi/connectors -> @base-org/account -- so
	// the modules are aliased to false and webpack substitutes an empty module.
	//
	// Installing the @x402 packages instead would add a payments SDK to the
	// bundle to satisfy an import path the app never takes.
	webpack: (config) => {
		config.resolve.alias = {
			...config.resolve.alias,
			"@x402/core/client": false,
			"@x402/evm": false,
			"@x402/evm/exact/client": false,
			"@x402/evm/upto/client": false,
			"@x402/svm": false,
			"@x402/svm/exact/client": false,
		}
		return config
	},

	// A prediction market must never be served stale. Every price-bearing route
	// opts out of caching explicitly at the route level; this is belt and braces
	// for the shell.
	headers: async () => [
		{
			source: "/api/:path*",
			headers: [
				{ key: "Cache-Control", value: "no-store, max-age=0, must-revalidate" },
				{ key: "X-Content-Type-Options", value: "nosniff" },
				{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
			],
		},
		{
			source: "/:path*",
			headers: [
				{ key: "X-Frame-Options", value: "DENY" },
				{ key: "X-Content-Type-Options", value: "nosniff" },
			],
		},
	],
}

export default nextConfig
