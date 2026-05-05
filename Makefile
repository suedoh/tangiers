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

cron: ## Install all cron jobs: trigger-check (10m), discord-bot (1m), weekly-report, war-report (idempotent)
	@NODEDIR=$$(dirname $(NODE)); \
	ADDED=0; \
	if crontab -l 2>/dev/null | grep -q "trigger-check.js"; then \
	  echo "✓  Trigger cron already installed — skipping"; \
	else \
	  CRONLINE="*/10 * * * * PATH=$$NODEDIR:/usr/local/bin:/usr/bin:/bin $(NODE) $(TRADING)/scripts/trigger-check.js >> $(TRADING)/logs/trigger-check.log 2>&1"; \
	  (crontab -l 2>/dev/null; echo ""; echo "# Ace Trading System — trigger check every 10 minutes"; echo "$$CRONLINE") | crontab -; \
	  echo "✓  Trigger cron installed (runs every 10 minutes)"; \
	  ADDED=1; \
	fi; \
	if crontab -l 2>/dev/null | grep -q "discord-bot/index.js"; then \
	  echo "✓  Discord bot cron already installed — skipping"; \
	else \
	  BOTLINE="*/1 * * * * PATH=$$NODEDIR:/usr/local/bin:/usr/bin:/bin $(NODE) $(TRADING)/scripts/discord-bot/index.js >> $(TRADING)/logs/discord-bot.log 2>&1"; \
	  (crontab -l 2>/dev/null; echo ""; echo "# Ace Trading System — Discord !analyze listener every minute"; echo "$$BOTLINE") | crontab -; \
	  echo "✓  Discord bot cron installed (runs every minute)"; \
	fi; \
	if crontab -l 2>/dev/null | grep -q "weekly-report.js"; then \
	  echo "✓  Weekly report cron already installed — skipping"; \
	else \
	  REPORTLINE="0 9 * * 1 PATH=$$NODEDIR:/usr/local/bin:/usr/bin:/bin $(NODE) $(TRADING)/scripts/weekly-report.js >> $(TRADING)/logs/weekly-report.log 2>&1"; \
	  (crontab -l 2>/dev/null; echo ""; echo "# Ace Trading System — weekly report every Monday 09:00 UTC"; echo "$$REPORTLINE") | crontab -; \
	  echo "✓  Weekly report cron installed (runs Mondays at 09:00 UTC)"; \
	fi; \
	if crontab -l 2>/dev/null | grep -q "weekly-war-report.js"; then \
	  echo "✓  War report cron already installed — skipping"; \
	else \
	  WARLINE="0 14 * * 0 PATH=$$NODEDIR:/usr/local/bin:/usr/bin:/bin $(NODE) $(TRADING)/scripts/weekly-war-report.js >> $(TRADING)/logs/weekly-war-report.log 2>&1"; \
	  (crontab -l 2>/dev/null; echo ""; echo "# Ace Trading System — weekly war report every Sunday 14:00 UTC (09:00 EST / 10:00 EDT)"; echo "$$WARLINE") | crontab -; \
	  echo "✓  War report cron installed (runs Sundays at 14:00 UTC)"; \
	fi

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
