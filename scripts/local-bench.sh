#!/usr/bin/env bash
# Run the whole benchmark locally against anvil. No testnet, no funds, no RPC key.
#
# WHAT THIS PROVES AND WHAT IT DOES NOT.
# Anvil executes transactions SEQUENTIALLY. It therefore cannot show a parallel
# speedup, and arms A (spread) and B (contended) are identical here by construction
# -- any gap between them locally is scheduling noise, not evidence. Do not quote a
# local A/B ratio as a parallelism result.
#
# What it does give you, for free and repeatably:
#   * every code path in the harness exercised end to end
#   * all three arms confirmed to produce the same fills
#   * exact gas per transaction per arm
#   * a known-good harness, so a paid run on a parallel node is spent measuring
#     rather than debugging
#
# The conflict-graph numbers -- the mechanism itself -- are measured with no chain
# at all: forge test --mc ConflictTest -vv and --mc CrossBenchTest -vv.
set -euo pipefail

cd "$(dirname "$0")/.."
ANVIL_PORT="${ANVIL_PORT:-8545}"
ANVIL_LOG="$(mktemp -t anvil.XXXXXX.log)"

anvil --port "$ANVIL_PORT" --silent >"$ANVIL_LOG" 2>&1 &
ANVIL_PID=$!
trap 'kill "$ANVIL_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 50); do
  cast block-number --rpc-url "http://127.0.0.1:$ANVIL_PORT" >/dev/null 2>&1 && break
  sleep 0.2
done

echo "==> deploying to anvil :$ANVIL_PORT"
(
  cd packages/contracts
  DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
    forge script script/Deploy.s.sol:Deploy \
      --rpc-url "http://127.0.0.1:$ANVIL_PORT" --broadcast --skip-simulation 2>&1 | tail -12
)

echo
echo "==> benchmarking (sequential executor: A vs B is a NULL control here)"
BENCH_CHAIN_ID=31337 \
BENCH_SENDERS="${BENCH_SENDERS:-19}" \
BENCH_RUNS="${BENCH_RUNS:-3}" \
  npx tsx scripts/multi-sender-bench.ts
