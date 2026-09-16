// EnsembleWorks embed-mode switch, injected into t3code's built index.html by
// deploy/t3code-embed/build.sh (never part of the upstream source tree).
//
// `?embed=1` latches a class onto <html> for the lifetime of the document, so
// SPA navigations that drop the query param keep embed mode. embed.css scopes
// all hiding under this class; without the param the app is untouched.
//
// `?theme=light|dark|system` writes the app's own theme preference
// (localStorage "t3code:theme") and re-applies the boot decision — upstream's
// inline theme script in <head> has already run by the time this executes, so
// mirror its class/background handling (apps/web/index.html). The preference
// persists exactly as if set in t3code's settings UI.
(function () {
	var params = new URLSearchParams(window.location.search);
	if (params.get("embed") === "1") {
		document.documentElement.classList.add("ew-embed");
	}
	var theme = params.get("theme");
	if (theme === "light" || theme === "dark" || theme === "system") {
		try {
			window.localStorage.setItem("t3code:theme", theme);
			var isDark =
				theme === "dark" ||
				(theme === "system" &&
					window.matchMedia("(prefers-color-scheme: dark)").matches);
			document.documentElement.classList.toggle("dark", isDark);
			var chromeColor = isDark ? "#161616" : "#ffffff";
			document.documentElement.style.backgroundColor = chromeColor;
			var meta = document.querySelector('meta[name="theme-color"]');
			if (meta) meta.setAttribute("content", chromeColor);
		} catch (e) {
			/* storage unavailable — leave upstream's boot decision in place */
		}
	}
})();
