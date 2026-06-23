-- EnsembleWorks neovim theme (LazyVim plugin spec), wired the way Omarchy
-- themes are: a stub in ~/.config/nvim/lua/plugins/theme.lua does
--
--   return dofile("<repo>/ensembleworks/deploy/theme/neovim.lua")
--
-- Base scheme is flexoki-light (paper-and-ink, the same scheme Omarchy ships
-- for its light theme), with highlights pinned to the Wellmaintained tokens
-- from client/src/theme.ts so nvim sits on the same paper as the canvas,
-- xterm and tmux.
return {
	{
		"kepano/flexoki-neovim",
		name = "flexoki",
		priority = 1000,
		init = function()
			vim.opt.background = "light"
			vim.api.nvim_create_autocmd("ColorScheme", {
				pattern = "flexoki-light",
				callback = function()
					local hl = function(group, opts)
						vim.api.nvim_set_hl(0, group, opts)
					end
					-- Wellmaintained tokens (client/src/theme.ts)
					local paper = "#fafaf7" -- matches the xterm background
					local panel = "#f2f0ea"
					local warmline = "#f6f3ec" -- canvas paper, one step warmer
					local ink = "#0f172a"
					local ink_subtle = "#8d94a3"
					local seal_blue = "#004990"
					local accent_soft = "#f4e4cc" -- kraft tint, = xterm selection

					hl("Normal", { fg = ink, bg = paper })
					hl("NormalNC", { fg = ink, bg = paper })
					hl("NormalFloat", { fg = ink, bg = panel })
					hl("FloatBorder", { fg = ink_subtle, bg = panel })
					hl("SignColumn", { bg = paper })
					hl("LineNr", { fg = ink_subtle, bg = paper })
					hl("CursorLine", { bg = warmline })
					hl("CursorLineNr", { fg = seal_blue, bg = warmline, bold = true })
					hl("Visual", { bg = accent_soft })
					hl("Search", { fg = ink, bg = accent_soft })
					hl("StatusLine", { fg = ink, bg = panel })
					hl("StatusLineNC", { fg = ink_subtle, bg = panel })
					hl("WinSeparator", { fg = ink_subtle, bg = paper })
					hl("Directory", { fg = seal_blue })
					hl("Title", { fg = seal_blue, bold = true })
				end,
			})
		end,
	},
	{
		"LazyVim/LazyVim",
		opts = {
			colorscheme = "flexoki-light",
		},
	},
}
