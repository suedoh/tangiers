SHELL := /bin/bash
.DEFAULT_GOAL := help

# ─── Paths ────────────────────────────────────────────────────────────────────

NODE    := $(shell which node 2>/dev/null)
TRADING := $(shell pwd)

# ─── Targets ─────────────────────────────────────────────────────────────────

.PHONY: help install deps env mcp cron test test-discord analyze bot bot-logs report report-30 war-report logs clean weather-scan weather-analyze weather-report weather-perf weather-clean

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
	if crontab -l 2>/dev/null | grep -q "discord-bot.js"; then \
	  echo "✓  Discord bot cron already installed — skipping"; \
	else \
	  BOTLINE="*/1 * * * * PATH=$$NODEDIR:/usr/local/bin:/usr/bin:/bin $(NODE) $(TRADING)/scripts/discord-bot.js >> $(TRADING)/logs/discord-bot.log 2>&1"; \
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

bot: ## Run discord-bot.js once (polls for !analyze commands and processes any pending)
	@echo "→ Running Discord bot poll..."
	@$(NODE) $(TRADING)/scripts/discord-bot.js

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

# ─── Weathermen targets ───────────────────────────────────────────────────────

weather-scan: ## Run market-scan.js once — check Polymarket for temperature edge now
	@echo "→ Running weather market scan..."
	@mkdir -p logs
	@$(NODE) $(TRADING)/scripts/weather/market-scan.js

weather-analyze: ## Deep-dive a specific market: make weather-analyze URL=https://polymarket.com/event/...
	@if [ -z "$(URL)" ] && [ -z "$(Q)" ]; then \
	  echo "Usage: make weather-analyze URL=https://polymarket.com/event/..."; \
	  echo "   or: make weather-analyze Q=\"Will NYC high exceed 75F on April 28?\""; \
	  exit 1; \
	fi
	@if [ -n "$(URL)" ]; then \
	  $(NODE) $(TRADING)/scripts/weather/analyze.js --url "$(URL)"; \
	else \
	  $(NODE) $(TRADING)/scripts/weather/analyze.js --question "$(Q)"; \
	fi

weather-report: ## Generate the weekly weather P&L report now
	@echo "→ Running weather weekly report..."
	@$(NODE) $(TRADING)/scripts/weather/weekly-report.js --force

weather-cron: ## Install weather cron jobs (15-min scan + Sunday report)
	@NODEDIR=$$(dirname $(NODE)); \
	if crontab -l 2>/dev/null | grep -q "weather/market-scan.js"; then \
	  echo "✓  Weather scan cron already installed — skipping"; \
	else \
	  SCANLINE="*/15 * * * * PATH=$$NODEDIR:/usr/local/bin:/usr/bin:/bin $(NODE) $(TRADING)/scripts/weather/market-scan.js >> $(TRADING)/logs/weather-scan.log 2>&1"; \
	  (crontab -l 2>/dev/null; echo ""; echo "# Weathermen — Polymarket weather scan every 15 minutes"; echo "$$SCANLINE") | crontab -; \
	  echo "✓  Weather scan cron installed (runs every 15 minutes)"; \
	fi; \
	if crontab -l 2>/dev/null | grep -q "weather/weekly-report.js"; then \
	  echo "✓  Weather report cron already installed — skipping"; \
	else \
	  REPORTLINE="0 18 * * 0 PATH=$$NODEDIR:/usr/local/bin:/usr/bin:/bin $(NODE) $(TRADING)/scripts/weather/weekly-report.js >> $(TRADING)/logs/weather-report.log 2>&1"; \
	  (crontab -l 2>/dev/null; echo ""; echo "# Weathermen — weekly P&L report every Sunday 18:00 UTC"; echo "$$REPORTLINE") | crontab -; \
	  echo "✓  Weather report cron installed (runs Sundays at 18:00 UTC)"; \
	fi

weather-perf: ## Full performance + city leaderboard analysis → #weather-backtest
	@echo "→ Running weather performance analysis..."
	@$(NODE) $(TRADING)/scripts/weather/analyze-performance.js

weather-clean: ## Reset weather state + clear weather logs
	@rm -f .weather-state.json
	@rm -f logs/weather-scan.log logs/weather-report.log
	@echo "✓  Weather state and logs cleared"
