# Linux builds and PTY verification in a clean container.
FROM rust:slim-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends git pkg-config python3 zsh && rm -rf /var/lib/apt/lists/*
WORKDIR /wrap
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --locked --release

FROM build AS verify
COPY tests ./tests
COPY eval/fixtures ./eval/fixtures
RUN cargo test --locked && cargo build --locked && python3 tests/contracts/cli.py && python3 tests/terminal.py target/debug/wrap && python3 tests/editor_terminal.py target/debug/wrap && python3 tests/shell_terminal.py target/debug/wrap && python3 tests/help_terminal.py target/debug/wrap

FROM ubuntu:24.04 AS sandbox
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git jq zsh && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --shell /bin/bash dev
COPY --from=build /wrap/target/release/wrap /usr/local/bin/wrap
USER dev
WORKDIR /home/dev
CMD ["bash"]
