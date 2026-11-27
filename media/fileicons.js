// @ts-check
// Iconos de archivos y carpetas según el tema de iconos de VS Code (workbench.iconTheme). Lo cargan
// el panel principal, la ventana de Push y la de comparación: cada una recibe el tema de la
// extensión (src/iconTheme.ts, mensaje «iconTheme») con setTheme y pide el icono de cada fila con
// html(). Sin tema (o «None») html() devuelve '' y cada fila usa su icono de siempre.
(function () {
  /**
   * Lo que manda la extensión: las asociaciones ya resueltas para el tema de color actual y los
   * iconos como data: URI (imágenes o caracteres de una fuente).
   * @typedef {{ id: string,
   *   defs: Record<string, { src?: string, glyph?: { font: string, ch: string, color?: string, size?: string } }>,
   *   fonts: { id: string, src: string, weight?: string, style?: string }[],
   *   file?: string, folder?: string, folderExpanded?: string,
   *   fileNames: Record<string, string>, fileExtensions: Record<string, string>,
   *   folderNames: Record<string, string>, folderNamesExpanded: Record<string, string>,
   *   languageIds: Record<string, string>, langByExt: Record<string, string>, langByName: Record<string, string> }} IconTheme
   */
  /** @type {IconTheme | null} */
  let theme = null;

  /** Texto para un atributo HTML (entre comillas dobles). */
  const esc = (/** @type {string} */ s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));

  /** Un nombre de archivo o carpeta: sin la ruta, en minúsculas (se comparan sin distinguir mayúsculas). */
  const leaf = (/** @type {string} */ name) => String(name).replace(/\/+$/, '').split('/').pop().toLowerCase();

  /**
   * Icono de un archivo: por nombre exacto, luego por extensión (la más larga primero:
   * «a.test.ts» prueba «test.ts» y después «ts») y, si el tema los usa, por lenguaje.
   * @param {IconTheme} t
   * @param {string} name
   */
  function fileIconId(t, name) {
    const lower = leaf(name);
    if (t.fileNames[lower]) { return t.fileNames[lower]; }
    const parts = lower.split('.');
    for (let i = 1; i < parts.length; i++) {
      const id = t.fileExtensions[parts.slice(i).join('.')];
      if (id) { return id; }
    }
    const lang = t.langByName[lower] || (parts.length > 1 ? t.langByExt[parts[parts.length - 1]] : undefined);
    if (lang && t.languageIds[lang]) { return t.languageIds[lang]; }
    return t.file;
  }

  /**
   * Icono de una carpeta: por nombre (la abierta, con su propia asociación si la hay) y si no el
   * de carpeta del tema (abierta o cerrada). Una cadena compactada «src/main/java» cuenta por su
   * último nombre.
   * @param {IconTheme} t
   * @param {string} name
   * @param {boolean} open
   */
  function folderIconId(t, name, open) {
    const lower = leaf(name);
    const named = open ? (t.folderNamesExpanded[lower] || t.folderNames[lower]) : t.folderNames[lower];
    return named || (open && t.folderExpanded) || t.folder;
  }

  /** Nombre de la familia de fuente de un icono de carácter (el tema puede traer varias). */
  const fontFamily = (/** @type {string} */ id) => `jbicon-${id.replace(/[^\w-]/g, '_')}`;

  /**
   * HTML del icono de un archivo o carpeta, o '' si no hay tema o no tiene icono para él.
   * Las fuentes y colores de los iconos de carácter se aplican después con apply() (la CSP no deja style="").
   * @param {string} name  nombre o ruta del archivo o carpeta
   * @param {boolean} [isFolder]
   * @param {boolean} [open]  carpeta abierta
   */
  function html(name, isFolder, open) {
    if (!theme) { return ''; }
    const id = isFolder ? folderIconId(theme, name, !!open) : fileIconId(theme, name);
    const d = id ? theme.defs[id] : undefined;
    if (!d) { return ''; }
    if (d.src) { return `<img class="ficon" src="${esc(d.src)}" alt="" draggable="false">`; }
    if (d.glyph) {
      const g = d.glyph;
      return `<span class="ficon ficon-g" data-font="${esc(g.font)}"${g.color ? ` data-color="${esc(g.color)}"` : ''}${g.size ? ` data-size="${esc(g.size)}"` : ''}>${esc(g.ch)}</span>`;
    }
    return '';
  }

  /** Pone la fuente, el color y el tamaño de los iconos de carácter de `root` (por CSSOM). */
  function apply(root) {
    for (const el of root.querySelectorAll('.ficon-g:not([data-done])')) {
      const e = /** @type {HTMLElement} */ (el);
      e.style.fontFamily = fontFamily(e.dataset.font || '');
      if (e.dataset.color) { e.style.color = e.dataset.color; }
      if (e.dataset.size) { e.style.fontSize = e.dataset.size; }
      e.dataset.done = '1';
    }
  }

  /** Carga las fuentes del tema (los iconos de carácter solo se ven cuando están cargadas). */
  function loadFonts(/** @type {IconTheme} */ t) {
    if (typeof FontFace === 'undefined') { return; }
    for (const f of t.fonts) {
      try {
        const face = new FontFace(fontFamily(f.id), `url("${f.src}")`, { weight: f.weight || 'normal', style: f.style || 'normal' });
        face.load().then(l => document.fonts.add(l), () => { /* sin fuente: sin iconos de carácter */ });
      } catch { /* fuente no válida */ }
    }
  }

  /** Cambia el tema (null o algo que no lo sea: sin iconos del tema). La página repinta sus filas después. */
  function setTheme(/** @type {IconTheme | null | undefined} */ t) {
    theme = t && typeof t === 'object' && t.defs ? t : null;
    if (theme) { loadFonts(theme); }
  }

  // @ts-ignore
  const api = { setTheme, html, apply, hasTheme: () => !!theme, fileIconId, folderIconId };
  // @ts-ignore
  (typeof window !== 'undefined' ? window : globalThis).jbFileIcons = api;
})();
