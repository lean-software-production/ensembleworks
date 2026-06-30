
# --- EnsembleWorks terminal env ---
# Source ~/.config/ensembleworks/term.env so CLI tools run from a canvas xterm/tmux
# session see those vars (OPENCODE_API_KEY, …). Sourced under `set -a` at shell
# startup — new terminals pick it up; edit term.env then open a new terminal (or
# `source ~/.bashrc`). Appended (idempotently) by deploy/deploy.sh.
__ew_term_env_file="${XDG_CONFIG_HOME:-$HOME/.config}/ensembleworks/term.env"
[ -f "$__ew_term_env_file" ] && { set -a; . "$__ew_term_env_file" 2>/dev/null; set +a; }
# --- end EnsembleWorks terminal env ---
