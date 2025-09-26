# 默认目标
.DEFAULT_GOAL := help

# Docker compose 命令
DC = docker-compose

# 帮助信息
help:
	@echo "可用命令:"
	@echo "  make run               构建并启动所有服务 (Conflux, Hardhat, MCP, Indexers)"
	@echo "  make build             构建 Docker 镜像"
	@echo "  make up                启动容器 (不重建)"
	@echo "  make down              停止并删除容器"
	@echo "  make addresses         显示合约地址 (IdentityRegistry / Marketplace)"
	@echo "  make indexers-up       启动两个事件索引器"
	@echo "  make indexers-down     停止两个事件索引器"
	@echo "  make logs              查看 MCP 服务日志"
	@echo "  make logs-marketplace  查看 Marketplace 索引器日志"
	@echo "  make logs-registered   查看 Registered 索引器日志"
	@echo "  make logs-indexers     同时查看两个索引器日志"
	@echo "  make clean             清理所有数据和镜像"

# 构建镜像
build:
	$(DC) build

# 启动 (不重建)
up:
	$(DC) up -d

# 构建 + 启动
run: build
	$(DC) up -d
	@echo ">>> 等待 Conflux 节点启动并部署合约..."
	@sleep 15
	@echo ">>> 部署合约..."
	$(DC) logs hardhat | grep "Contract deployed to" || true
	$(DC) logs hardhat | grep "Marketplace deployed to" || true
	@echo ">>> MCP 服务已启动在 http://localhost:17777"
	@echo ">>> 索引器将读取事件并输出到容器/挂载目录 (registered_events.jsonl 等)"

# 仅启动索引器
indexers-up:
	$(DC) up -d indexer-marketplace indexer-registered

# 停止索引器
indexers-down:
	$(DC) stop indexer-marketplace indexer-registered

# 查看 MCP 日志
logs:
	$(DC) logs -f mcp

# 查看索引器日志
logs-marketplace:
	$(DC) logs -f indexer-marketplace

logs-registered:
	$(DC) logs -f indexer-registered

logs-indexers:
	$(DC) logs -f indexer-marketplace indexer-registered

# 显示合约地址
addresses:
	@echo "IdentityRegistry: $$(sed -n '1p' hardhat/contract_address.txt 2>/dev/null || echo 'N/A')"
	@echo "Marketplace:      $$(sed -n '1p' hardhat/marketplace_address.txt 2>/dev/null || echo 'N/A')"

# 停止并清理容器
down:
	$(DC) down

# 清理所有数据
clean: down
	$(DC) rm -f
	docker volume prune -f
	docker image prune -f
	rm -rf data
	rm -f hardhat/contract_address.txt hardhat/marketplace_address.txt scripts/registered_events.jsonl