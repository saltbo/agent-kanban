import { continueRender, delayRender } from "remotion";

let loaded = false;

export function ensureFonts() {
  if (loaded) return;
  loaded = true;

  // Check if Geist fonts are already available (e.g. installed locally)
  if (document.fonts.check("16px Geist") && document.fonts.check("16px 'Geist Mono'")) {
    return;
  }

  // Wait briefly for any system fonts to settle, but don't block on external loading
  const handle = delayRender("Waiting for fonts...");
  document.fonts.ready.then(() => continueRender(handle));
}
