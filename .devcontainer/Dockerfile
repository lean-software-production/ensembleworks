# EnsembleWorks devcontainer — Debian 13 (trixie), the same OS as the
# production and dogfood boxes. Everything a keyless contributor needs is
# baked in: Bun (pinned in .tool-versions), tmux, Caddy, the LiveKit OSS
# SFU (voice/video via --dev keys) and whisper.cpp + a small model (keyless
# transcription). Version pins follow deploy/runtime-requirements — bump them
# together. The shared browser (neko) is deliberately absent: it needs
# docker-in-docker; use a native host for that.
FROM debian:trixie

ARG CADDY_VERSION=2.10.0
ARG LIVEKIT_VERSION=1.13.1
ARG WHISPER_TAG=v1.9.1

RUN apt-get update && apt-get install -y --no-install-recommends \
		build-essential ca-certificates cmake curl git gh less locales \
		pkg-config procps python3 sudo tmux unzip xz-utils \
	&& rm -rf /var/lib/apt/lists/* \
	&& sed -i 's/# en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen
ENV LANG=en_US.UTF-8
# Node 18+ prefers ::1 for "localhost"; force IPv4 so Vite binds 127.0.0.1
# and probePort (which connects to 127.0.0.1) can reach it.
ENV NODE_OPTIONS=--dns-result-order=ipv4first
# Marks that bin/dev is running INSIDE the devcontainer, so it acts as the
# engine (runs the tmux stack) rather than the host controller (which forwards
# in). See resolveMode() in bin/dev-lib.mjs.
ENV ENSEMBLEWORKS_IN_DEVCONTAINER=1

# Bun — pinned to match .tool-versions (single source of truth; bin/dev and the
# deploy preflight enforce the same floor at runtime). Installed system-wide to
# /usr/local/bin via the official installer (BUN_INSTALL sets the prefix).
ARG BUN_VERSION=1.3.14
ENV BUN_INSTALL=/usr/local
RUN set -eux; \
	curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"; \
	bun --version

# Caddy — static binary (not packaged in Debian main).
RUN set -eux; \
	case "$(dpkg --print-architecture)" in amd64) a=amd64;; arm64) a=arm64;; esac; \
	curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_${a}.tar.gz" \
		| tar -xz -C /usr/local/bin caddy; \
	caddy version

# LiveKit OSS SFU — exact pin per deploy/runtime-requirements.
RUN set -eux; \
	case "$(dpkg --print-architecture)" in amd64) a=amd64;; arm64) a=arm64;; esac; \
	curl -fsSL "https://github.com/livekit/livekit/releases/download/v${LIVEKIT_VERSION}/livekit_${LIVEKIT_VERSION}_linux_${a}.tar.gz" \
		| tar -xz -C /usr/local/bin livekit-server; \
	livekit-server --version

# whisper.cpp server + a small multilingual model — keyless local STT. The
# scribe's contract is OpenAI's POST <STT_URL>/audio/transcriptions; served
# natively via whisper-server's --inference-path (see bin/dev-lib.mjs).
RUN set -eux; \
	git clone --depth 1 --branch "${WHISPER_TAG}" https://github.com/ggml-org/whisper.cpp /tmp/whisper.cpp; \
	cmake -S /tmp/whisper.cpp -B /tmp/whisper.cpp/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF; \
	cmake --build /tmp/whisper.cpp/build -j"$(nproc)" --target whisper-server; \
	install -m 0755 /tmp/whisper.cpp/build/bin/whisper-server /usr/local/bin/whisper-server; \
	rm -rf /tmp/whisper.cpp; \
	mkdir -p /usr/local/share/whisper; \
	curl -fsSL -o /usr/local/share/whisper/ggml-base.bin \
		"https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"

# Non-root user, uid 1000 — what VS Code / Codespaces expects.
RUN useradd -m -s /bin/bash -u 1000 dev \
	&& echo 'dev ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/dev
USER dev
