SHELL := /bin/bash
.DEFAULT_GOAL := help

# ─── Paths ────────────────────────────────────────────────────────────────────

NODE    := $(shell which node 2>/dev/null)
TRADING := $(shell pwd)

# ─── Targets ─────────────────────────────────────────────────────────────────

.PHONY: help install deps env mcp cron test test-discord logs clean

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

cron: ## Install the 30-minute cron job (idempotent)
	@if crontab -l 2>/dev/null | grep -q "trigger-check.js"; then \
	  echo "✓  Cron job already installed — skipping"; \
	else \
	  NODEDIR=$$(dirname $(NODE)); \
	  CRONLINE="*/30 * * * * PATH=$$NODEDIR:/usr/local/bin:/usr/bin:/bin $(NODE) $(TRADING)/scripts/trigger-check.js >> $(TRADING)/logs/trigger-check.log 2>&1"; \
	  (crontab -l 2>/dev/null; echo ""; echo "# Ace Trading System — trigger check every 30 minutes"; echo "$$CRONLINE") | crontab -; \
	  echo "✓  Cron job installed (runs every 30 minutes)"; \
	fi

test: ## Run trigger-check.js once and show output
	@echo "→ Running trigger check..."
	@$(NODE) $(TRADING)/scripts/trigger-check.js

test-discord: ## Send a test Discord notification
	@bash scripts/discord-notify.sh info "Ace system online — test from \`make test-discord\`"

logs: ## Tail the trigger-check log (Ctrl+C to stop)
	@tail -f logs/trigger-check.log

clean: ## Remove .trigger-state.json and clear logs (resets cooldowns and OI trend)
	@rm -f .trigger-state.json
	@rm -f logs/trigger-check.log
	@echo "✓  Cleared state and logs"
