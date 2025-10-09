# BSC Sniper — Rust (executor) + Node.js (orchestrator)

**Hybrid demo (production-style)**: a high-performance **Rust** executor for the execution hot-path, and a flexible **Node.js / TypeScript** orchestrator for event listening, heuristics and orchestration.

> ⚠️ **This repository is a demo intended for testnet / forked mainnet use only. Do NOT use with real funds on mainnet until you fully audit, harden, and secure your deployment.**

---



## Purpose

This project demonstrates a pragmatic production-style architecture used for high-frequency DeFi operations:

- **Node orchestrator (TypeScript)** — listens for `PairCreated` and liquidity events, performs heuristics/pre-checks, posts buy requests to executor.
- **Rust executor (Actix + ethers-rs)** — minimal, deterministic hot-path that builds/signs/submits swap transactions (`swapExactETHForTokensSupportingFeeOnTransferTokens`).

The split keeps fast deterministic transaction logic in Rust and flexible orchestration logic in Node for quick iteration.

---

### API(Rust executor)
Post / buy
Content-Type: application/json


### Development notes & architecture rationale
- **Rust Executor**: deterministic, low-latency, compiled binary for the critical path. Ideal for signing & sending txs reliably.
- **Node orchestrator**: fast iteration, rich DeFi tooling, easier to write heuristics/token-safety scans, and integrations (alerts, UIs).
- Keep the hot-path as small as possible — business logic, heavy checks, ML scoring should live in orchestrator or a separate service.


### CI / Docker / Deployment notes
- **Add GitHub Actions workflows**:
  Rust: cargo fmt -- --check, cargo clippy, cargo build --release
  Node: npm ci, npm run lint, npm run build
- Dockerize executor & orchestrator with environment variables injected at runtime (do NOT bake secrets).
- Use container orchestration (K8s) or systemd with secret mounts for production.

### Support / Contact
If you have any question or something, feel free to reach out me anytime via telegram, discord or twitter.
<br>
#### 🌹 You're always welcome 🌹

Telegram: [@Leo](https://t.me/shinnyleo0912) <br>
