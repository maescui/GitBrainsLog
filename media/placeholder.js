// @ts-check
// Aviso del panel inferior mientras el Log está en una pestaña del editor (showPlaceholder, extension.ts)
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  // Fuentes de Settings ▸ Fonts (atributos data-* del <body>; sin ellos, las de VS Code)
  const d = document.body.dataset, r = document.documentElement.style;
  if (d.font) { r.setProperty('--jb-font', d.font); }
  if (d.fontSize) { r.setProperty('--jb-font-size', `${d.fontSize}px`); }
  // Cada botón pide su comando (data-command) a la extensión
  document.querySelectorAll('[data-command]').forEach(b => b.addEventListener('click', () =>
    vscode.postMessage({ type: 'command', id: /** @type {HTMLElement} */ (b).dataset.command })));
})();
