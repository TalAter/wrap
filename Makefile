.PHONY: check test build terminal sandbox linux-test optimize
check:
	cargo fmt --check
	cargo clippy --locked --all-targets -- -D warnings
	cargo test --locked
test:
	cargo test --locked
build:
	cargo build --locked --release
terminal:
	cargo build --locked
	python3 tests/terminal.py target/debug/wrap
	python3 tests/help_terminal.py target/debug/wrap
sandbox:
	./scripts/sandbox.sh
linux-test:
	./scripts/sandbox.sh test
optimize:
	docker build -t wrap-dspy -f eval/dspy/Dockerfile .
	docker run --rm \
		-v "$(CURDIR)/eval/examples":/app/eval/examples \
		-v "$(CURDIR)/eval/results":/app/eval/results \
		-v "$(CURDIR)/eval/dspy":/app/eval/dspy \
		-v "$(CURDIR)/src":/app/src \
		-v dspy-cache:/root/.dspy_cache \
		-v bridge-cache:/tmp/wrap-bridge-cache \
		--env-file eval/dspy/.env \
		wrap-dspy
