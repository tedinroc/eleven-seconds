# PROJECT_NAME

> Placeholder. One-line description goes here.

Built at **Monad Blitz Shanghai, 2026-10-17**. Target network: Monad testnet (chain id 10143).

## Quick start

```bash
# contracts
forge build
forge test

# web (Vite + TypeScript + viem)
cd web && npm install && npm run dev

# tools
scripts/rpc-health.sh                 # eth_chainId / eth_blockNumber per RPC
cd scripts && npm install && node heads.mjs   # print new block headers + intervals
scripts/deploy.sh src/Counter.sol:Counter     # dry run; BROADCAST=1 to send, then Sourcify verify
```

Copy `.env.example` to `.env` for local settings. Keys are never committed.

## Prepared before the event (boilerplate only)

The following generic scaffolding was set up before the event, following the Blitz rule that only
boilerplate and research/planning may be prepared in advance. None of it contains application logic.

| Item | Source |
| --- | --- |
| `foundry.toml`, `remappings.txt` | Foundry defaults, plus Monad settings from the Monad docs (solc 0.8.37, `evm_version = "osaka"`, `network = "monad"`, public testnet RPC list, Sourcify verifier URL) |
| `src/Counter.sol`, `test/Counter.t.sol`, `script/Counter.s.sol` | `forge init` template (only change: SPDX `UNLICENSED` -> `MIT`), kept only to prove the toolchain compiles |
| `lib/forge-std` v1.17.0 | foundry-rs/forge-std release tag, vendored |
| `lib/openzeppelin-contracts` v5.7.0 | OpenZeppelin release tag, vendored |
| `lib/openzeppelin-contracts-upgradeable` v5.7.0 | OpenZeppelin release tag, vendored |
| `web/` | `create-vite` vanilla-ts template, plus a viem `defineChain` for Monad testnet with a multi-RPC `fallback` transport, and a blank page that shows "connected to chain 10143, block N" |
| `scripts/rpc-health.sh` | Generic RPC health check (curl) |
| `scripts/heads.mjs` | Generic block-header probe CLI (viem `watchBlocks`), a dev tool and not part of the app |
| `scripts/deploy.sh`, `scripts/verify.sh` | Generic `forge create` + `forge verify-contract --verifier sourcify` wrappers (contract name and constructor args are parameters) |
| `.gitignore`, `.env.example`, `LICENSE` | Standard project metadata |
| `docs/spec.md` | Plain-text spec / threat model / interface list written before the event as planning; contains no code |

**All application logic was written during Monad Blitz Shanghai on 2026-10-17.** The repository was
created at the start of the event; the commit history shows everything added after this boilerplate.

## AI tools used

- Claude Code: TODO (describe what it was used for during the event)
- Claude Code was also used before the event to prepare the boilerplate above and the planning docs (`docs/spec.md`).

## Architecture

TODO

## Next steps

TODO

## License

MIT, see [LICENSE](LICENSE).
