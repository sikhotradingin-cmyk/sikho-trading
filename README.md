# Indian Securities Paper-Trading Platform (Android-First)

An Android-first, high-performance paper-trading application built for Indian retail traders. Practice analyzing live market charts and executing simulated trades against market quotes without financial risk.

---

## 1. Monorepo Architecture

```
trading/
├── package.json                   # Root monorepo workspace configuration
├── tsconfig.base.json             # Shared strict TypeScript configuration
├── packages/
│   ├── shared/                    # Common models, validation, indicators, contracts
│   │   ├── src/models/            # Instrument, Money (Integer Paise), Orders, Positions, Ledger
│   │   ├── src/indicators/        # EMA, SMA, RSI (Wilder's smoothing) with warm-up logic
│   │   └── src/validation/        # Strict order validator, dynamic lot multiples, tick alignment
│   ├── backend/                   # Fastify TypeScript service
│   │   ├── migrations/            # PostgreSQL DDL schema (accounts, ledger, orders, positions)
│   │   ├── src/providers/         # IMarketDataProvider, DeterministicProvider, SmartAPIAdapter
│   │   ├── src/engine/            # VirtualAccountEngine, SimulationEngine, SecurityAirGap
│   │   └── src/benchmarks/        # Reproducible load-test & latency benchmark suite
│   └── mobile/                    # Android React Native application
│       ├── android/               # Android Gradle project, manifest, and build configs
│       ├── src/chart/             # Lightweight Charts (Apache 2.0) HTML/JS bundle & NOTICE
│       ├── src/store/             # Zustand state management
│       ├── src/components/        # LightweightChartWebView, QuickOrderTicket, FeedHealthBadge
│       └── src/screens/           # WatchlistScreen, ChartScreen, OrdersPositionsScreen, AccountScreen
```

---

## 2. Setup & Execution Instructions

### Prerequisites
* **Node.js**: v20+ or v22+ (tested on Node v24.19)
* **npm**: v10+

### Installation & Build
```bash
# Install all monorepo dependencies across shared, backend, and mobile
npm install

# Build shared package
npm run build:shared

# Build backend service
npm run build:backend
```

### Running Automated Test Suites
```bash
# Run all 30 unit, engine, and integration tests across the workspace
npm test

# Run backend load test & performance benchmark (500 orders)
npm --workspace=packages/backend run benchmark
```

### Starting the Local Development Servers
```bash
# Start backend API & WebSocket server on http://localhost:4000
npm run start:backend

# In a separate terminal, start React Native Metro bundler
npm run start:mobile
```

---

## 3. Environment Configuration

Copy `packages/backend/.env.example` to `packages/backend/.env`:

```env
PORT=4000
HOST=0.0.0.0
NODE_ENV=development
JWT_SECRET=super_secret_jwt_key_here

# Optional: Angel One SmartAPI Credentials
# (If omitted, system automatically runs on high-fidelity Deterministic Demo Provider)
SMARTAPI_API_KEY=
SMARTAPI_CLIENT_CODE=
SMARTAPI_PASSWORD=
SMARTAPI_TOTP_SECRET=
```

---

## 4. Key Design Implementation Highlights

1. **Dynamic Lot Sizing (Never Hardcoded):**
   * The platform dynamically resolves `lotSize`, `tickSize`, `expiry`, and `exchange` from contract metadata.
   * Order validator strictly rejects any order quantity where `quantity % instrument.lotSize !== 0`.
2. **Decimal-Safe Integer Paise Accounting:**
   * All accounts, margin locks, realized/unrealized P&L, and transaction fees are computed using 64-bit integer Paise (1 INR = 100 Paise), preventing IEEE 754 float drift.
3. **Security Air-Gap Against Real Execution:**
   * `SecurityAirGap` guardrail actively inspects outgoing requests and enforces that broker order placement endpoints are inaccessible and forbidden in paper-trading mode.
4. **Lightweight Charts Apache 2.0 Compliance:**
   * Locally embedded WebView bundle utilizing TradingView Lightweight Charts with official Apache 2.0 LICENSE and NOTICE attribution displayed.
5. **Simulated Execution Engine:**
   * Market orders execute against Best Ask/Bid.
   * Stop-Loss orders handle gap-down/gap-up scenarios realistically by filling at the market tick price rather than an artificial trigger price.
   * OCO exit protection ensures that when a Stop-Loss triggers, its linked Target order is atomically cancelled.
