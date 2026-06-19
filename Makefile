SHELL := /bin/bash
.DEFAULT_GOAL := help

# ─── Paths ────────────────────────────────────────────────────────────────────

NODE    := $(shell which node 2>/dev/null)
TRADING := $(shell pwd)

# ─── Targets ─────────────────────────────────────────────────────────────────

.PHONY: help install deps env mcp cron ew-cron test test-discord analyze bot bot-logs report report-30 war-report ew ew-backtest ew-summary ew-brief ew-outlook ew-monthly ew-clean logs clean

help: ## Show available commands
	@echo ""
	@echo "  Ace Trading System"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
	  awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'
	@echo ""

install: deps env mcp cron ## Full setup: deps → .env → MCP → crontab
	@echo ""
	@echo "  Setup complete. Run 'make test' to verify the pipeline."
	@echo ""

deps: ## Install Node dependencies for tradingview-mcp
	@echo "→ Installing tradingview-mcp dependencies..."
	@if [ ! -d tradingview-mcp/node_modules ]; then \
	  cd tradingview-mcp && npm install --silent; \
	  echo "✓  Dependencies installed"; \
	else \
	  echo "✓  Dependencies already installed — skipping"; \
	fi

env: ## Create .env from .env.example (skips if already exists)
	@if [ -f .env ]; then \
	  echo "✓  .env already exists — skipping (edit manually if needed)"; \
	else \
	  cp .env.example .env; \
	  echo "→ .env created"; \
	  echo ""; \
	  read -p "  Paste your Discord webhook URL: " url && \
	  sed -i '' "s|DISCORD_WEBHOOK_URL=.*|DISCORD_WEBHOOK_URL=$$url|" .env; \
	  echo "✓  .env configured"; \
	fi

mcp: ## Register TradingView MCP server with Claude Desktop
	@echo "→ Registering TradingView MCP with Claude Desktop..."
	@if claude mcp list 2>/dev/null | grep -q tradingview; then \
	  echo "✓  MCP already registered — skipping"; \
	else \
	  claude mcp add tradingview -s user -- node $(TRADING)/tradingview-mcp/src/server.js 2>/dev/null && \
	  echo "✓  MCP registered" || \
	  echo "⚠  Could not register MCP — is 'claude' CLI installed? Register manually: claude mcp add tradingview -s user -- node $(TRADING)/tradingview-mcp/src/server.js"; \
	fi

cron: ## Install host crontab entries (CDP-bound — BTC trigger + Discord bot). Docker-side jobs live in scripts/cron/ace.crontab.
	@NODEDIR=$$(dirname $(NODE)); \
	if crontab -l 2>/dev/null | grep -q "scripts/trigger-check.js"; then \
	  echo "✓  BTC trigger cron already installed — skipping"; \
	else \
	  CRONLINE="*/10 * * * * PATH=$$NODEDIR:/usr/local/bin:/usr/bin:/bin $(NODE) $(TRADING)/scripts/trigger-check.js >> $(TRADING)/logs/trigger-check.log 2>&1"; \
	  (crontab -l 2>/dev/null; echo ""; echo "# Ace Trading System — BTC trigger every 10 minutes (CDP-bound — host only)"; echo "$$CRONLINE") | crontab -; \
	  echo "✓  BTC trigger cron installed (every 10 min)"; \
	fi; \
	if crontab -l 2>/dev/null | grep -q "scripts/discord-bot/index.js"; then \
	  echo "✓  Discord bot cron already installed — skipping"; \
	else \
	  BOTLINE="* * * * * PATH=$$NODEDIR:/usr/local/bin:/usr/bin:/bin $(NODE) $(TRADING)/scripts/discord-bot/index.js >> $(TRADING)/logs/discord-bot.log 2>&1"; \
	  (crontab -l 2>/dev/null; echo ""; echo "# Ace Trading System — Discord bot every 1 minute (CDP-bound handlers — host only)"; echo "$$BOTLINE") | crontab -; \
	  echo "✓  Discord bot cron installed (every 1 min)"; \
	fi; \
	echo ""; \
	echo "Docker-side scheduled jobs:    edit scripts/cron/ace.crontab"; \
	echo "Apply changes:                 docker compose restart ace-cron"; \
	echo ""; \
	echo "NOTE: BZ + Poly + EW run.js trigger crons are installed by their own scripts:"; \
	echo "  make ew-cron       (installs EW run.js host entry only)"; \
	echo "  BZ + Poly triggers — see README cron section"

test: ## Run trigger-check.js once and show output
	@echo "→ Running trigger check..."
	@$(NODE) $(TRADING)/scripts/trigger-check.js

analyze: ## Run a full MTF analysis now and post to Discord (same as !analyze in Discord)
	@echo "→ Running MTF analysis..."
	@$(NODE) $(TRADING)/scripts/mtf-analyze.js

bot: ## Run discord-bot/index.js once (polls for !analyze commands and processes any pending)
	@echo "→ Running Discord bot poll..."
	@$(NODE) $(TRADING)/scripts/discord-bot/index.js

bot-logs: ## Tail the Discord bot log (Ctrl+C to stop)
	@tail -f logs/discord-bot.log

report: ## Run the weekly performance report now and post to #btc-backtest
	@$(NODE) $(TRADING)/scripts/weekly-report.js

report-30: ## Run a 30-day performance report and post to #btc-backtest
	@$(NODE) $(TRADING)/scripts/weekly-report.js --days 30

war-report: ## Run the weekly war report now and post to #btc-weekly-war-report
	@$(NODE) $(TRADING)/scripts/weekly-war-report.js

test-discord: ## Send a test Discord notification
	@bash scripts/discord-notify.sh info "Ace system online — test from \`make test-discord\`"

logs: ## Tail the trigger-check log (Ctrl+C to stop)
	@tail -f logs/trigger-check.log

clean: ## Remove .trigger-state.json and clear logs (resets cooldowns and OI trend)
	@rm -f .trigger-state.json
	@rm -f logs/trigger-check.log
	@echo "✓  Cleared state and logs"

# ─── Elliott Wave (EW) targets ────────────────────────────────────────────────

ew: ## Run scripts/ew/run.js once (scheduled-style EW analysis pass; posts to #btc-ew-signals)
	@$(NODE) $(TRADING)/scripts/ew/run.js

ew-backtest: ## Run scripts/ew/backtest.js once (walks open forecasts, posts events to #btc-ew-backtest)
	@$(NODE) $(TRADING)/scripts/ew/backtest.js

ew-summary: ## Run scripts/ew/daily-summary.js once (stats post to #btc-ew-backtest)
	@$(NODE) $(TRADING)/scripts/ew/daily-summary.js

ew-brief: ## Run scripts/ew/daily-brief.js once (narrative brief to #btc-ew-report)
	@$(NODE) $(TRADING)/scripts/ew/daily-brief.js

ew-outlook: ## Run scripts/ew/weekly-outlook.js once (Sunday weekly outlook to #btc-ew-report)
	@$(NODE) $(TRADING)/scripts/ew/weekly-outlook.js

ew-monthly: ## Run scripts/ew/monthly-review.js once (1st-of-month cycle review to #btc-ew-report)
	@$(NODE) $(TRADING)/scripts/ew/monthly-review.js

ew-clean: ## Reset EW flat-file state (forecasts + state + locks). Idempotent.
	@rm -f ew-forecasts.json .ew-state.json
	@rm -f ew-forecasts.json.lock .ew-state.json.lock
	@rm -f logs/ew-*.log
	@echo "✓  Cleared EW state, forecasts, and logs"

poly-backfill-reactions: ## Add ✅/❌ reactions to historical #poly-btc-5-signals messages (safe to re-run)
	@$(NODE) $(TRADING)/scripts/poly/btc-5/backfill-reactions.js

poly-backfill-reactions-dry: ## Dry-run: show which reactions would be posted without posting
	@$(NODE) $(TRADING)/scripts/poly/btc-5/backfill-reactions.js --dry-run

ew-cron: ## Install all six EW cron entries (idempotent). Runs alongside `make cron`.
	@NODE=$(NODE) TRADING=$(TRADING) bash $(TRADING)/scripts/ew/install-cron.sh

blofin-status: ## Phase A health check: confirms BloFin demo API + credentials work
	@$(NODE) $(TRADING)/scripts/blofin/status.js

blofin-fund: ## Top up the BloFin demo account with 10000 USDT (demo only)
	@$(NODE) $(TRADING)/scripts/blofin/fund-demo.js

blofin-setup: ## One-time: set futures account to one-way mode + 10× isolated leverage for BTC-USDT
	@$(NODE) $(TRADING)/scripts/blofin/setup-account.js

blofin-probe: ## Phase B.2 health check: place limit far below market, verify, cancel, verify clean
	@$(NODE) $(TRADING)/scripts/blofin/order-probe.js

blofin-store-probe: ## Phase B.3 health check: persisted order lifecycle place → recon → cancel → recon
	@$(NODE) $(TRADING)/scripts/blofin/store-probe.js

blofin-recon-once: ## One-shot reconciliation between local Mongo state and BloFin exchange truth
	@$(NODE) $(TRADING)/scripts/blofin/recon-once.js

blofin-autotrade-probe: ## Phase B.4 health check: synthetic signal → 4 orders → idempotency → cleanup (needs BLOFIN_AUTOTRADE=true)
	@$(NODE) $(TRADING)/scripts/blofin/autotrade-probe.js

blofin-resolve-probe: ## Phase B.5 health check: market entry → live → disappeared → filled (via fills-history)
	@$(NODE) $(TRADING)/scripts/blofin/resolve-probe.js

blofin-sl-probe: ## Phase B.6 health check: standalone TPSL conditional placement + verify + cancel + protection invariant
	@$(NODE) $(TRADING)/scripts/blofin/sl-probe.js
