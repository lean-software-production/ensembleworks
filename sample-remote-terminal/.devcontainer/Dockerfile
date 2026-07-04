FROM mcr.microsoft.com/devcontainers/base:ubuntu

# Terminal + editor + search tools from the Ubuntu repos.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tmux neovim ripgrep ca-certificates curl git \
 && rm -rf /var/lib/apt/lists/*

# git-delta ships as a .deb per release (not always in the distro repo).
# Bump DELTA_VERSION if the download 404s (the smoke test will catch it).
ARG DELTA_VERSION=0.18.2
RUN arch="$(dpkg --print-architecture)" \
 && curl -fsSL -o /tmp/delta.deb \
      "https://github.com/dandavison/delta/releases/download/${DELTA_VERSION}/git-delta_${DELTA_VERSION}_${arch}.deb" \
 && dpkg -i /tmp/delta.deb \
 && rm -f /tmp/delta.deb

# Node 22 via NodeSource — also the global-install path for the agents below,
# which lands their bins on PATH for every user (more reliable than the
# per-user curl installers in a shared image).
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# opencode + pi coding agents, installed globally.
RUN npm install -g opencode-ai @earendil-works/pi-coding-agent
