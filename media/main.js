// @ts-check
(function () {
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();

  // Alto de una fila del log: tamaño de letra + 11 (24 con 13 px); lo recalcula applyFonts
  let ROW_H = 24;
  let FS = 13;   // tamaño de letra de la interfaz en px (el de Settings o el de VS Code)
  const LANE_W = 14;
  const GRAPH_PAD = 6;
  // Paleta de carriles: si cambia su longitud, cambiar PALETTE_SIZE (graph.ts) y autoBranchColor (extension.ts)
  const PALETTE = ['#4C8BF5', '#3FB9A6', '#E5534B', '#D4A72C', '#B07FE0', '#E07AB2', '#7FB65A', '#E0864A', '#5AA9E6', '#A9A24C'];

  /**
   * Estado de la interfaz con el que arranca la página: el más reciente (savedAt) entre el guardado
   * de este webview y el que guarda la extensión (data-ui-state), que es el del Log en su último
   * sitio (panel o pestaña del editor). El de este webview puede ser de antes de moverlo.
   */
  function newerUiState(own, shared) {
    const at = s => (s && typeof s.savedAt === 'number' ? s.savedAt : 0);
    return (at(shared) > at(own) ? shared : own || shared) || {};
  }
  const saved = newerUiState(vscode.getState(), (() => {
    try { return JSON.parse(document.body.dataset.uiState || 'null'); } catch { return null; }
  })());
  // Valores por defecto de las opciones de vista (para los Reset to Defaults de Settings)
  const LOGVIEW_DEFAULTS = { details: true, subject: true, author: true, date: true, hash: true, tags: true, compact: false, mine: true, merges: true, current: true };
  const GROUPBY_DEFAULTS = { directory: true, repository: true };
  const ui = {
    branchesWidth: saved.branchesWidth || 220,
    detailsWidth: saved.detailsWidth || 340,
    filesRatio: saved.filesRatio || 0.5,
    branchesHidden: !!saved.branchesHidden,
    expanded: new Set(saved.expanded || ['local']),
    tab: saved.tab || '',          // se valida contra las pestañas que existen en «Pestañas»
    tabOrder: saved.tabOrder || [],
    stashFilesWidth: saved.stashFilesWidth || 340,
    // «Group By» del ojo (View Options), como en JetBrains: por directorio por defecto
    changesGroupBy: saved.changesGroupBy || { ...GROUPBY_DEFAULTS },
    stashGroupBy: saved.stashGroupBy || { ...GROUPBY_DEFAULTS },
    repoNames: !!saved.repoNames,  // columna de repos del log desplegada (con sus nombres)
    branchGraphColors: saved.branchGraphColors !== false,  // icono de rama del color de su carril en el grafo
    // Ojo del Log (View Options, como en JetBrains): paneles, columnas, etiquetas y resaltados
    logView: Object.assign({}, LOGVIEW_DEFAULTS, saved.logView || {}),
    changesWidth: saved.changesWidth || 420,
    commitHeight: saved.commitHeight || 150,
    commitDraft: saved.commitDraft || '',
    settingsPage: saved.settingsPage || 'general',   // categoría abierta en la pestaña Settings
    settingsCollapsed: saved.settingsCollapsed || [],  // categorías con subcategorías plegadas en el menú
    mergeOptions: Array.isArray(saved.mergeOptions) ? saved.mergeOptions : [],  // Modify options del último Merge (como JetBrains)
  };

  /** @type {any} */
  let data = null;
  /** @type {any[]} */
  let view = [];             // commits visibles (tras búsqueda)
  let indexByHash = new Map();
  let refsByHash = new Map();
  let headIds = new Set();        // commits en los que está el HEAD de algún repo
  let detachedHeads = new Set();  // … con HEAD separado
  let childrenByHash = new Map();
  let inCurrentBranch = null;
  let filterChanging = false;     // se ha pedido un log con otros filtros: mantener el commit seleccionado     // commits alcanzables desde algún HEAD (Highlight ▸ Current Branch)
  let selected = null;       // hash seleccionado (el último pulsado: sus detalles se muestran)
  let selSet = new Set();    // commits seleccionados (Ctrl/Shift+clic selecciona varios)
  let selAnchor = null;      // ancla de Shift+clic
  let reachCache = new Map(); // HEAD → commits de la vista alcanzables desde él (inCurrent)
  let details = null;
  let search = '';
  let branchSearch = '';
  let selectedTreeKey = null;          // último nodo pulsado del árbol (ancla de Shift+clic)
  let selectedTreeKeys = new Set();    // nodos seleccionados (Ctrl/Shift+clic selecciona varias ramas)
  // Repos que puso en Paths el doble clic en una rama de solo algunos repos (para quitarlos con ella)
  let branchRoots = null;
  let detailsTimer = 0;
  /** @type {any} */
  let settings = null;          // valores de jbGit.* (mensaje «settings», pestaña Settings)
  let settingsActs = [];        // acciones de las casillas y botones de la pestaña Settings, por índice

  const $ = (/** @type {string} */ s) => /** @type {HTMLElement} */ (document.querySelector(s));
  const branchesEl = $('#branches');
  const detailsEl = $('#details');
  const treeEl = $('#branch-tree');
  const listEl = $('#log-list');
  const filesEl = $('#files');
  const infoEl = $('#commit-info');
  const settingsEl = $('#settings');

  const inner = document.createElement('div');
  inner.id = 'log-inner';
  listEl.appendChild(inner);

  function saveUi() {
    const state = {
      savedAt: Date.now(),   // para elegir el más reciente al cargar (newerUiState)
      branchesWidth: ui.branchesWidth,
      detailsWidth: ui.detailsWidth,
      filesRatio: ui.filesRatio,
      branchesHidden: ui.branchesHidden,
      expanded: [...ui.expanded],
      tab: ui.tab,
      tabOrder: ui.tabOrder,
      changesWidth: ui.changesWidth,
      commitHeight: ui.commitHeight,
      stashFilesWidth: ui.stashFilesWidth,
      changesGroupBy: ui.changesGroupBy,
      stashGroupBy: ui.stashGroupBy,
      repoNames: ui.repoNames,
      branchGraphColors: ui.branchGraphColors,
      logView: ui.logView,
      commitDraft: ui.commitDraft,
      settingsPage: ui.settingsPage,
      settingsCollapsed: ui.settingsCollapsed,
      mergeOptions: ui.mergeOptions,
    };
    vscode.setState(state);
    // La extensión también lo guarda, para la página del Log en su próximo sitio
    vscode.postMessage({ type: 'uiState', state });
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // -------------------------------------------------------------------------
  // Iconos
  // -------------------------------------------------------------------------

  const ICON = {
    // Rama al estilo JetBrains/codicons: dos commits en vertical y una rama que sale
    branch: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="4.5" cy="3.5" r="1.8"/><circle cx="4.5" cy="12.5" r="1.8"/><circle cx="11.5" cy="5" r="1.8"/><path d="M4.5 5.3v5.4M11.5 6.8c0 2.6-7 2-7 3.9"/></svg>',
    star: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linejoin="round"><path d="M8 1.6l1.95 4 4.4.6-3.2 3.05.78 4.35L8 11.5l-3.93 2.1.78-4.35-3.2-3.05 4.4-.6z"/></svg>',
    starOutline: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M8 1.6l1.95 4 4.4.6-3.2 3.05.78 4.35L8 11.5l-3.93 2.1.78-4.35-3.2-3.05 4.4-.6z"/></svg>',
    tag: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2.5 3.5a1 1 0 0 1 1-1h4.6l5.4 5.4-5.6 5.6-5.4-5.4V3.5Z"/><circle cx="5.5" cy="5.5" r="1" fill="currentColor"/></svg>',
    warning: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M8 1.8 14.6 13.5H1.4z"/><path d="M8 6v3.6M8 11.4v.4" stroke-linecap="round"/></svg>',
    // Rama actual (checkout), como la etiqueta de JetBrains
    lock: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="3.5" y="7" width="9" height="7" rx="1.2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/><path d="M8 9.8v1.6" stroke-linecap="round"/></svg>',
    current: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h6.3l4.2 5-4.2 5H3.5A1.5 1.5 0 0 1 2 11.5z"/></svg>',
    head: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="3.2"/><path d="M8 1v3.2M8 11.8V15" stroke="currentColor" stroke-width="1.6"/></svg>',
    folder: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.5 4a1 1 0 0 1 1-1h3.6l1.4 1.5h6a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4Z"/></svg>',
    file: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M4 1.5h5l3.5 3.5v9a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5Z"/><path d="M9 1.5V5h3.5"/></svg>',
    chevron: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>',
    fetch: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8M4.5 6.5 8 10l3.5-3.5"/><path d="M2.5 13.5h11" stroke-dasharray="2 1.6"/></svg>',
    pull: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v9M4 7l4 4 4-4"/><path d="M3 14h10"/></svg>',
    push: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 14V5M4 9l4-4 4 4"/><path d="M3 2h10"/></svg>',
    commit: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="3"/><path d="M1.5 8H5M11 8h3.5"/></svg>',
    newBranch: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="10.5" cy="6.5" r="1.5"/><path d="M4.5 5v6M10.5 8c0 2.2-6 1.4-6 3"/><path d="M13 1.5v4M11 3.5h4"/></svg>',
    stash: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 9v4.5h12V9"/><path d="M8 1.5v8M5 6.5l3 3 3-3"/></svg>',
    unstash: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 9v4.5h12V9"/><path d="M8 10V2M5 5l3-3 3 3"/></svg>',
    // Merge como en JetBrains: dos líneas que se juntan en una (Y invertida)
    merge: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2v2.5c0 2 4 3 4 5.5V14"/><path d="M12 2v2.5c0 2-4 3-4 5.5"/></svg>',
    trash: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4"/><path d="M6.8 6.5v4.5M9.2 6.5v4.5"/></svg>',
    plus: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v10M3 8h10"/></svg>',
    minus: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h10"/></svg>',
    info: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="8" cy="8" r="6.3"/><path d="M8 7.2v4"/><circle cx="8" cy="4.9" r=".55" fill="currentColor" stroke="none"/></svg>',
    undo: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 3 2.5 6l3 3"/><path d="M2.5 6H10a3.5 3.5 0 0 1 0 7H6"/></svg>',
    palette: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M8 1.75a6.25 6.25 0 1 0 0 12.5c.9 0 1.3-.6 1.1-1.3-.3-.9.2-1.7 1.2-1.7h1.4c1.5 0 2.55-1.15 2.55-2.6C14.25 4.6 11.5 1.75 8 1.75Z"/><circle cx="4.9" cy="7.2" r=".9" fill="currentColor" stroke="none"/><circle cx="7.2" cy="4.6" r=".9" fill="currentColor" stroke="none"/><circle cx="10.4" cy="5.2" r=".9" fill="currentColor" stroke="none"/></svg>',
    keyboard: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="4" width="13" height="8.5" rx="1.5"/><path d="M4 6.6h.01M6.3 6.6h.01M8.6 6.6h.01M10.9 6.6h.01M4.5 10h7"/></svg>',
    search: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="m10.4 10.4 3.6 3.6"/></svg>',
    log: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="4" cy="4" r="1.6"/><circle cx="4" cy="12" r="1.6"/><path d="M4 5.6v4.8M8 4h6.5M8 8h6.5M8 12h6.5"/></svg>',
    gear: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M6.9 1.5h2.2l.4 1.8 1.3.6 1.6-1 1.5 1.5-1 1.6.6 1.3 1.8.4v2.2l-1.8.4-.6 1.3 1 1.6-1.5 1.5-1.6-1-1.3.6-.4 1.8H6.9l-.4-1.8-1.3-.6-1.6 1-1.5-1.5 1-1.6-.6-1.3-1.8-.4V6.9l1.8-.4.6-1.3-1-1.6 1.5-1.5 1.6 1 1.3-.6z"/><circle cx="8" cy="8" r="2.2"/></svg>',
    eye: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8S3.9 3.5 8 3.5 14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/></svg>',
    repo: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M4.5 1.5h8.5v10.5H4.8a1.3 1.3 0 0 0-1.3 1.3V2.5a1 1 0 0 1 1-1Z"/><path d="M3.5 13.3a1.3 1.3 0 0 0 1.3 1.2H13V12"/><path d="M6 4.5h4.5"/></svg>',
    check: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3 3 7-7"/></svg>',
    chevronLeft: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 4 6 8l4 4"/></svg>',
    refresh: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.5v3h-3"/></svg>',
    chevronDown: '<svg class="chev" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>',
    close: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 3l6 6M9 3l-6 6"/></svg>',
    remote: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M4.5 12.5h7.2a3 3 0 0 0 .3-6 4 4 0 0 0-7.7-.9A3.4 3.4 0 0 0 4.5 12.5Z"/></svg>',
  };

  // Flecha de desplegar de los árboles: un chevron SVG que el CSS gira al abrirse
  const twisty = isOpen => `<span class="twisty${isOpen ? ' open' : ''}">${ICON.chevron}</span>`;

  // -------------------------------------------------------------------------
  // Mensajes desde la extensión
  // -------------------------------------------------------------------------

  window.addEventListener('message', ev => {
    const m = ev.data;
    switch (m.type) {
      case 'data': return onData(m);
      case 'details':
        if (m.details && m.details.hash === selected) { details = m.details; renderDetails(); }
        else if (!m.details && m.hash === selected) { details = null; infoEl.innerHTML = `<div class="empty error">${esc(m.error)}</div>`; filesEl.innerHTML = ''; }
        return;
      case 'changes': return onChanges(m);
      case 'changePreview': return onChangePreview(m);
      case 'stashes': return onStashes(m);
      case 'stashFiles': return onStashFiles(m);
      case 'confirm': return showConfirm(m);
      case 'mergeDialog': return showMergeDialog(m);
      case 'committed':
        commitMsg.value = ''; ui.commitDraft = ''; commitAmend.checked = false; saveUi(); updateCommitButtons();
        return;
      case 'noRepo':
        changes = null; renderChanges();
        stashes = null; stashSel = null; stashFiles = null; renderStashes();
        data = null;
        inner.style.height = '0px';
        inner.innerHTML = '<div class="empty"><strong>No Git repository found.</strong><br>Open a folder that is, or contains, a Git repository.</div>';
        treeEl.innerHTML = filesEl.innerHTML = infoEl.innerHTML = '';
        return;
      case 'settings':
        settings = m.values;
        applyTagColor();
        applyFonts();
        if (data) { renderTree(); renderRows(true); }
        return renderSettings();
      case 'error':
        inner.style.height = '0px';
        inner.innerHTML = `<div class="empty error">${esc(m.message)}</div>`;
        return;
    }
  });

  // -------------------------------------------------------------------------
  // Confirmación en un diálogo sobre el panel (borrar ramas), del tamaño de su contenido
  // -------------------------------------------------------------------------

  /**
   * m = { id, heading, notes: [], sections: [{ label, items, icon? }], checkbox, checkboxItems, action }.
   * La usan todas las confirmaciones de la extensión (confirm en extension.ts).
   * Responde confirmResult { id, ok, checked }. Las listas llevan un icono de repo por fila; las
   * de la casilla se atenúan mientras está desmarcada. Enter acepta, Escape cancela y Tab no
   * sale del diálogo.
   */
  /**
   * Quita el cuadro abierto sobre el panel, si lo hay, respondiendo «cancelado»: si no, la
   * acción de la extensión que lo esperaba se quedaría colgada para siempre.
   */
  function dismissDialog() {
    const old = /** @type {HTMLElement | null} */ (document.querySelector('.cf-back'));
    if (!old) { return; }
    old.remove();
    if (old.dataset.reply) { vscode.postMessage({ type: old.dataset.reply, id: Number(old.dataset.id), ok: false, checked: false }); }
  }

  function showConfirm(m) {
    dismissDialog();
    // Icono de cada fila: repo por defecto, o el de la sección (commit)
    const list = (items, icon) => `<ul class="cf-list${icon === 'commit' ? ' cf-commits' : ''}">${items.map(t => `<li>${icon === 'commit' ? ICON.commit : ICON.repo}<span title="${esc(t)}">${esc(t)}</span></li>`).join('')}</ul>`;
    const notes = (m.notes || []).map(t => `<p>${esc(t)}</p>`).join('');
    const sections = (m.sections || []).map(sec => `<div class="cf-section">${sec.label ? `<div class="cf-label">${esc(sec.label)}</div>` : ''}${list(sec.items || [], sec.icon)}</div>`).join('');
    const cbItems = m.checkboxItems && m.checkboxItems.length ? `<div class="cf-cb-items off">${list(m.checkboxItems)}</div>` : '';
    const back = document.createElement('div');
    back.className = 'cf-back';
    back.dataset.reply = 'confirmResult';
    back.dataset.id = String(m.id);
    back.innerHTML = `<div class="cf" role="dialog" aria-modal="true" aria-labelledby="cf-title">
      <div class="cf-title" id="cf-title"><span class="cf-icon">${ICON.warning}</span><span>${esc(m.heading)}</span></div>
      <div class="cf-body">
        ${notes ? `<div class="cf-notes">${notes}</div>` : ''}
        ${sections}
        ${m.checkbox ? `<div class="cf-cb-box"><label class="cf-check"><input type="checkbox" id="cf-cb"><span>${esc(m.checkbox)}</span></label>${cbItems}</div>` : ''}
      </div>
      <div class="cf-actions"><button class="btn secondary" data-act="cancel">Cancel</button><button class="btn" data-act="ok">${esc(m.action || 'OK')}</button></div>
    </div>`;
    const prevFocus = /** @type {HTMLElement | null} */ (document.activeElement);
    document.body.appendChild(back);
    const cb = /** @type {HTMLInputElement | null} */ (back.querySelector('#cf-cb'));
    const close = (ok) => {
      back.remove();
      vscode.postMessage({ type: 'confirmResult', id: m.id, ok, checked: !!(cb && cb.checked) });
      if (prevFocus && prevFocus.isConnected) { prevFocus.focus(); }
    };
    if (cb) {
      cb.addEventListener('change', () => { back.querySelector('.cf-cb-items')?.classList.toggle('off', !cb.checked); });
    }
    back.addEventListener('click', e => {
      const b = /** @type {HTMLElement} */ (e.target).closest('[data-act]');
      if (b) { close(b.getAttribute('data-act') === 'ok'); }
    });
    back.addEventListener('mousedown', e => { if (e.target === back) { e.preventDefault(); } });
    back.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); });
    back.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); close(false); return; }
      if (e.key === 'Enter' && !(/** @type {HTMLElement} */ (e.target).matches('button'))) { e.preventDefault(); close(true); return; }
      if (e.key === 'Tab') {
        const f = /** @type {HTMLElement[]} */ ([...back.querySelectorAll('input, button')]);
        const i = f.indexOf(/** @type {HTMLElement} */ (document.activeElement));
        e.preventDefault();
        f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
      }
    });
    /** @type {HTMLElement} */ (back.querySelector('[data-act="ok"]')).focus();
  }

  // -------------------------------------------------------------------------
  // Ventana Merge (como la de JetBrains), en un cuadro sobre el panel
  // -------------------------------------------------------------------------

  /** Opciones de git merge (Modify options): [opción, descripción, incompatibles]. */
  const MERGE_OPTS = [
    ['--ff-only', 'Fast-forward only', ['--no-ff', '--squash', '-m']],
    ['--no-ff', 'Create a merge commit even if fast-forward is possible', ['--ff-only', '--squash']],
    ['--squash', 'Create a single commit instead of merging', ['--ff-only', '--no-ff', '-m']],
    ['-m', 'Set the commit message', ['--ff-only', '--squash']],
    ['--no-commit', 'Merge without committing', []],
    ['--no-verify', 'Bypass pre-merge and commit-msg hooks', []],
    ['--allow-unrelated-histories', 'Allow merging unrelated histories', []],
  ];

  /**
   * m = { id, heading, repos: [], branches: [{ key, name, type, fav, repoNames }], preselect }.
   * Buscador de rama con la lista debajo (secciones Local / Remote; ↑/↓, Enter o doble clic
   * mergea), Modify options con las opciones como etiquetas quitables y, con -m, el mensaje.
   * Responde dialogResult { id, ok, key, options, message }. Escape cancela; en el mensaje,
   * Enter es salto de línea y Ctrl+Enter mergea.
   */
  function showMergeDialog(m) {
    dismissDialog();
    const branches = m.branches || [];
    // Empieza con las opciones del último Merge (las que ya no existan se ignoran)
    /** @type {Set<string>} */
    const opts = new Set(ui.mergeOptions.filter(o => MERGE_OPTS.some(([x]) => x === o)));
    let sel = branches.findIndex(b => b.key === m.preselect);
    const back = document.createElement('div');
    back.className = 'cf-back';
    back.dataset.reply = 'dialogResult';
    back.dataset.id = String(m.id);
    const where = m.repos && m.repos.length ? `<span class="mg-where" title="${esc(m.repos.join(', '))}">in ${esc(m.repos.join(', '))}</span>` : '';
    back.innerHTML = `<div class="cf mg" role="dialog" aria-modal="true" aria-labelledby="mg-title">
      <div class="cf-title" id="mg-title"><span class="mg-icon">${ICON.merge}</span><span>${esc(m.heading)}</span>${where}</div>
      <div class="mg-body">
        <div class="mg-line">
          <input type="text" class="mg-search" placeholder="Branch to merge" spellcheck="false" aria-label="Branch to merge">
          <button class="btn secondary mg-modify" data-act="modify">Modify options ${ICON.chevronDown}</button>
        </div>
        <div class="mg-list" role="listbox"></div>
        <div class="mg-chips"></div>
        <textarea class="mg-msg hidden" rows="3" spellcheck="false" placeholder="Commit message (Ctrl+Enter to merge)" aria-label="Commit message"></textarea>
      </div>
      <div class="cf-actions"><button class="btn mg-cancel" data-act="cancel">Cancel</button><button class="btn" data-act="ok">Merge</button></div>
    </div>`;
    const search = /** @type {HTMLInputElement} */ (back.querySelector('.mg-search'));
    const listEl = /** @type {HTMLElement} */ (back.querySelector('.mg-list'));
    const chipsEl = /** @type {HTMLElement} */ (back.querySelector('.mg-chips'));
    const msgEl = /** @type {HTMLTextAreaElement} */ (back.querySelector('.mg-msg'));
    const okBtn = /** @type {HTMLButtonElement} */ (back.querySelector('[data-act="ok"]'));
    const prevFocus = /** @type {HTMLElement | null} */ (document.activeElement);

    const rowHtml = (b, i) => {
      const icon = b.fav ? `<span class="mg-ico fav">${ICON.star}</span>` : `<span class="mg-ico">${b.type === 'remote' ? ICON.remote : ICON.branch}</span>`;
      const hint = b.repoNames ? `<span class="repo-hint" title="${esc(b.repoNames)}">${esc(b.repoNames)}</span>` : '';
      return `<div class="mg-row" role="option" data-i="${i}">${icon}<span class="mg-name" title="${esc(b.name)}">${esc(b.name)}</span>${hint}</div>`;
    };
    listEl.innerHTML = [['local', 'Local'], ['remote', 'Remote']].map(([t, label]) => {
      const rows = branches.map((b, i) => b.type === t ? rowHtml(b, i) : '').join('');
      return rows ? `<div class="mg-head" data-sec="${t}">${label}</div>${rows}` : '';
    }).join('') + '<div class="mg-empty hidden">No matching branches</div>';
    const rowEls = /** @type {HTMLElement[]} */ ([...listEl.querySelectorAll('.mg-row')]);
    const rowOf = i => rowEls.find(r => Number(r.dataset.i) === i);
    const visible = () => rowEls.filter(r => !r.classList.contains('hidden'));

    function setSel(i, scroll = true) {
      sel = i;
      for (const r of rowEls) {
        const on = Number(r.dataset.i) === i;
        r.classList.toggle('sel', on);
        r.setAttribute('aria-selected', String(on));
      }
      const r = rowOf(i);
      if (r && scroll) { r.scrollIntoView({ block: 'nearest' }); }
      okBtn.disabled = sel < 0;
    }
    function filter() {
      const q = search.value.trim().toLowerCase();
      for (const r of rowEls) {
        const b = branches[Number(r.dataset.i)];
        r.classList.toggle('hidden', !!q && !`${b.name} ${b.repoNames || ''}`.toLowerCase().includes(q));
      }
      for (const h of listEl.querySelectorAll('.mg-head')) {
        const t = /** @type {HTMLElement} */ (h).dataset.sec;
        h.classList.toggle('hidden', !rowEls.some(r => !r.classList.contains('hidden') && branches[Number(r.dataset.i)].type === t));
      }
      const vis = visible();
      listEl.querySelector('.mg-empty')?.classList.toggle('hidden', vis.length > 0);
      // Al escribir se marca la primera que coincide (Enter la mergea)
      if (q || !vis.some(r => Number(r.dataset.i) === sel)) { setSel(vis.length && (q || sel >= 0) ? Number(vis[0].dataset.i) : -1); }
    }
    function renderOpts() {
      chipsEl.innerHTML = MERGE_OPTS.filter(([o]) => opts.has(o)).map(([o, d]) =>
        `<span class="mg-chip" title="${esc(d)}">${esc(o)}<button class="mg-chip-x" data-rm="${esc(o)}" title="Remove" aria-label="Remove ${esc(o)}">${ICON.close}</button></span>`).join('');
      chipsEl.classList.toggle('hidden', !opts.size);
      msgEl.classList.toggle('hidden', !opts.has('-m'));
    }
    function modifyMenu() {
      const r = /** @type {HTMLElement} */ (back.querySelector('.mg-modify')).getBoundingClientRect();
      showMenu(MERGE_OPTS.map(([o, d, bad]) => ({
        label: `${o} ${d}`,
        labelHtml: `<span class="mg-opt">${esc(o)}</span> <span class="mg-opt-desc">${esc(d)}</span>`,
        checked: opts.has(o),
        disabled: !opts.has(o) && bad.some(x => opts.has(x)),
        act: () => {
          if (opts.has(o)) { opts.delete(o); } else { opts.add(o); }
          renderOpts();
          if (o === '-m' && opts.has(o)) { msgEl.focus(); } else { search.focus(); }
        },
      })), r.left, r.bottom + 2);
    }
    const close = (ok) => {
      if (ok && sel < 0) { return; }
      closeMenus();
      back.remove();
      // Se recuerdan al mergear (no al cancelar), como en JetBrains; el mensaje no
      if (ok) { ui.mergeOptions = [...opts]; saveUi(); }
      vscode.postMessage({
        type: 'dialogResult', id: m.id, ok,
        key: ok ? branches[sel].key : undefined,
        options: [...opts].filter(o => o !== '-m'),
        message: opts.has('-m') ? msgEl.value : '',
      });
      if (prevFocus && prevFocus.isConnected) { prevFocus.focus(); }
    };

    search.addEventListener('input', filter);
    listEl.addEventListener('mousedown', e => {
      const r = /** @type {HTMLElement} */ (e.target).closest('.mg-row');
      if (r) { e.preventDefault(); setSel(Number(/** @type {HTMLElement} */ (r).dataset.i), false); search.focus(); }
    });
    listEl.addEventListener('dblclick', e => { if (/** @type {HTMLElement} */ (e.target).closest('.mg-row')) { close(true); } });
    back.addEventListener('click', e => {
      const t = /** @type {HTMLElement} */ (e.target);
      const rm = t.closest('[data-rm]');
      if (rm) { opts.delete(rm.getAttribute('data-rm') || ''); renderOpts(); search.focus(); return; }
      const b = t.closest('[data-act]');
      if (!b) { return; }
      const act = b.getAttribute('data-act');
      if (act === 'modify') { e.stopPropagation(); modifyMenu(); return; }
      close(act === 'ok');
    });
    back.addEventListener('mousedown', e => { if (e.target === back) { e.preventDefault(); } });
    back.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); });
    back.addEventListener('keydown', e => {
      e.stopPropagation();
      const t = /** @type {HTMLElement} */ (e.target);
      if (e.key === 'Escape') { e.preventDefault(); close(false); return; }
      if (e.key === 'Enter') {
        if (t === msgEl && !(e.ctrlKey || e.metaKey)) { return; }
        if (t.matches('button') && !(e.ctrlKey || e.metaKey)) { return; }
        e.preventDefault(); close(true); return;
      }
      if (t === search && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'PageDown' || e.key === 'PageUp')) {
        e.preventDefault();
        const vis = visible();
        if (!vis.length) { return; }
        const step = e.key.startsWith('Page') ? 8 : 1;
        const at = vis.findIndex(r => Number(r.dataset.i) === sel);
        const next = at < 0 ? 0 : Math.max(0, Math.min(vis.length - 1, at + (e.key.endsWith('Down') ? step : -step)));
        setSel(Number(vis[next].dataset.i));
        return;
      }
      if (e.key === 'Tab') {
        const f = /** @type {HTMLElement[]} */ ([...back.querySelectorAll('input, textarea, button')]).filter(x => x.offsetParent && !(/** @type {HTMLButtonElement} */ (x).disabled));
        const i = f.indexOf(/** @type {HTMLElement} */ (document.activeElement));
        e.preventDefault();
        f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
      }
    });

    document.body.appendChild(back);
    renderOpts();
    setSel(sel);
    search.focus();
  }

  function onData(m) {
    reachCache = new Map();
    data = m;
    applyLogView();   // el ancho de la fecha depende del formato (absoluto o relativo), que viene con los datos
    renderOpBar();
    // La pestaña Settings refleja opciones que vienen con los datos (First Parent, Long Edges)
    if (ui.tab === 'settings') { setTimeout(renderSettings); }
    // Al cambiar los repos del log, la clave de una rama cambia («0,2|refs/heads/x» ↔ «refs/heads/x»)
    const remap = key => {
      if (!key || key === 'HEAD' || !key.includes('/') || m.tree.some(n => n.key === key)) { return key; }
      const full = key.slice(key.indexOf('|') + 1);
      const n = m.tree.find(x => x.full === full);
      return n ? n.key : (full.startsWith('refs/') ? null : key);  // las carpetas no cambian
    };
    selectedTreeKey = remap(selectedTreeKey);
    selectedTreeKeys = new Set([...selectedTreeKeys].map(remap).filter(Boolean));
    // Autores para el filtro User: solo de logs sin filtro de usuario, para no perder los demás
    if (!m.logFilters || !m.logFilters.authors.length) {
      knownAuthors = new Map();
      for (const c of m.commits) { knownAuthors.set(c.author, (knownAuthors.get(c.author) || 0) + 1); }
    }
    // HEAD de cada repo: ids de sus commits y los que están en HEAD separado
    headIds = new Set(m.repos.map(r => r.head.hash).filter(Boolean));
    detachedHeads = new Set(m.repos.filter(r => r.head.hash && !r.head.branch).map(r => r.head.hash));
    refsByHash = new Map();
    for (const r of m.refs) {
      if (!refsByHash.has(r.hash)) { refsByHash.set(r.hash, []); }
      refsByHash.get(r.hash).push(r);
    }
    childrenByHash = new Map();
    for (const c of m.commits) {
      for (const p of c.parents) {
        if (!childrenByHash.has(p)) { childrenByHash.set(p, c.hash); }
      }
    }
    inCurrentBranch = null;
    // Lo pendiente de Paths, hasta que llegue un log con ese filtro (no uno que ya venía de antes)
    if (pathsPending && !pathsTimer && (m.logFilterSeq || 0) >= pathsSeq) { pathsPending = null; }
    renderFilters();
    renderTree();
    applySearch(false);
    const refiltered = filterChanging;
    filterChanging = false;
    // La selección múltiple se conserva con los commits que sigan en el log
    selSet = new Set([...selSet].filter(h => indexByHash.has(h)));
    const keepMulti = selSet.size > 1 && !!selected && selSet.has(selected);
    if (!selected || !indexByHash.has(selected)) {
      // El commit seleccionado ya no está (o no había): arriba del todo, en el HEAD o el primero
      if (refiltered) { listEl.scrollTop = 0; }
      const first = view.find(c => headIds.has(c.hash)) || view[0];
      select(first ? first.hash : null, { scroll: true });
    } else if (refiltered) {
      // Al poner o quitar un filtro, el foco se queda en el mismo commit, centrado
      centerOn(selected);
      select(selected, { scroll: false, force: true, multi: keepMulti });
    } else {
      select(selected, { scroll: false, force: true, multi: keepMulti });
    }
  }

  // -------------------------------------------------------------------------
  // Log: búsqueda + virtualización
  // -------------------------------------------------------------------------

  /**
   * Columna de repos del log: estrecha (solo el color) o desplegada con los nombres. El
   * ancho se ajusta al nombre más largo y se aplica con CSSOM (la CSP no deja style="").
   */
  function applyRepoColumn() {
    const wide = !!(data && data.multi && ui.repoNames);
    listEl.classList.toggle('repo-wide', wide);
    // Con el log oculto (otra pestaña, p. ej. al cambiarlo desde Settings) no se puede medir:
    // se hace al volver a la pestaña Log (switchTab)
    if (wide && listEl.offsetParent) {
      // Ancho justo para el nombre más largo: se mide con la misma fuente que la franja
      const probe = document.createElement('span');
      probe.className = 'repo-mark repo-probe';
      listEl.appendChild(probe);
      let w = 0;
      for (const r of data.repos) { probe.textContent = r.name; w = Math.max(w, probe.getBoundingClientRect().width); }
      probe.remove();
      listEl.style.setProperty('--repo-col', `${Math.min(Math.ceil(w), 140)}px`);
    }
  }

  function applySearch(keepScroll = true) {
    if (!data) { return; }
    applyRepoColumn();
    const q = search.trim().toLowerCase();
    view = !q ? data.commits : data.commits.filter(c =>
      (c.sha || c.hash).startsWith(q) ||
      c.subject.toLowerCase().includes(q) ||
      c.author.toLowerCase().includes(q) ||
      c.email.toLowerCase().includes(q)
    );
    indexByHash = new Map(view.map((c, i) => [c.hash, i]));
    const total = view.length + (data.hasMore && !q ? 1 : 0);
    inner.style.height = `${total * ROW_H}px`;
    if (!keepScroll) { /* conserva scroll del navegador */ }
    renderRows(true);
  }

  // La CSP del webview bloquea los atributos de estilo inline; las posiciones viajan
  // como data-top / data-pad y se aplican aquí mediante CSSOM, que sí está permitido.
  function applyPositions(root) {
    for (const el of root.querySelectorAll('[data-top]')) { el.style.top = el.dataset.top + 'px'; }
    for (const el of root.querySelectorAll('[data-pad]')) { el.style.paddingLeft = el.dataset.pad + 'px'; }
  }

  let lastRange = '';
  function renderRows(force = false) {
    if (!data) { return; }
    const top = listEl.scrollTop;
    const h = listEl.clientHeight || 400;
    const start = Math.max(0, Math.floor(top / ROW_H) - 8);
    const end = Math.min(view.length, Math.ceil((top + h) / ROW_H) + 8);
    const key = `${start}:${end}:${selected}`;
    if (!force && key === lastRange) { return; }
    lastRange = key;

    const showGraph = !search.trim();
    let html = '';
    for (let i = start; i < end; i++) {
      html += rowHtml(view[i], i, showGraph);
    }
    if (data.hasMore && showGraph && end >= view.length) {
      html += `<div class="load-more" data-top="${view.length * ROW_H}"><button class="link-btn" data-act="load-more">Load more commits</button></div>`;
    }
    if (!view.length) {
      html = `<div class="empty">${search ? 'No commits match this search.' : 'This branch has no commits yet.'}</div>`;
    }
    inner.innerHTML = html;
    applyPositions(inner);
    // Color de cada etiqueta de rama (CSSOM: la CSP no deja style=""); va en una variable
    // para que la fila seleccionada pueda seguir usando su propio color de texto
    for (const el of inner.querySelectorAll('.ref[data-rc]')) {
      /** @type {HTMLElement} */ (el).style.setProperty('--ref-c', /** @type {HTMLElement} */ (el).dataset.rc || '');
    }
  }

  function rowHtml(c, i, showGraph) {
    const isHead = headIds.has(c.hash);
    const cls = ['row'];
    if (c.hash === selected || selSet.has(c.hash)) { cls.push('selected'); }
    if (isHead) { cls.push('head'); }
    const lv = ui.logView;
    if (lv.mine && data.repos[c.repo] && data.repos[c.repo].me && c.author === data.repos[c.repo].me) { cls.push('mine'); }
    if (lv.merges && c.parents.length > 1) { cls.push('merge'); }
    if (lv.current && !currentBranchCommits().has(c.hash)) { cls.push('unreachable'); }
    // Con varios repos, una franja de color a la izquierda indica de cuál es cada commit
    // Pulsar la franja la despliega con el nombre del repo, como en JetBrains
    const mark = !data.multi ? ''
      : `<span class="repo-mark rc${c.repo % 10}" title="${esc(repoName(c.repo))} — click to ${ui.repoNames ? 'hide' : 'show'} repository names">${ui.repoNames ? esc(repoName(c.repo)) : ''}</span>`;
    return `<div class="${cls.join(' ')}" data-top="${i * ROW_H}" data-h="${c.hash}">${mark}` +
      // Sin la columna del mensaje, el mensaje sale al pasar el ratón por el grafo y las etiquetas
      `<div class="c-subject"${ui.logView.subject ? '' : ` title="${esc(c.subject)}"`}>${showGraph ? graphSvg(c.g, isHead) : ''}` +
      `<span class="subject" title="${esc(c.subject)}">${esc(c.subject)}</span>${refsHtml(c.hash)}</div>` +
      `<div class="c-author" title="${esc(c.email)}">${esc(c.author)}</div>` +
      `<div class="c-hash">${esc((c.sha || c.hash).slice(0, 8))}</div>` +
      `<div class="c-date">${esc(formatDate(c.time))}</div>` +
      '</div>';
  }

  /**
   * Color del icono de una rama en el árbol. Con «branchGraphColors», su color del grafo
   * (branchColorOf: el elegido en jbGit.branchColors o el automático por nombre). No depende
   * del log cargado ni de los filtros, así que no cambia al filtrar. Si no, el de la carpeta con
   * color que la contiene (fc, «@remote» para las que cuelgan directamente de origin). Se
   * aplica por CSSOM tras pintar (data-gc / data-fc).
   */
  function graphColorAttr(r, fc = '') {
    if (ui.branchGraphColors) { return ` data-gc="${esc(branchColorOf(branchColorKey(r)))}"`; }
    return fc ? ` data-fc="${esc(fc)}"` : '';
  }

  function laneX(k) { return GRAPH_PAD + k * LANE_W + LANE_W / 2; }
  /** Color de un carril: índice de la paleta o un #rrggbb elegido para esa rama (jbGit.branchColors). */
  function color(n) { return typeof n === 'string' ? n : PALETTE[n % PALETTE.length]; }
  const PALETTE_NAMES = ['Blue', 'Teal', 'Red', 'Yellow', 'Purple', 'Pink', 'Green', 'Orange', 'Sky', 'Olive'];
  /** Nombre de rama para su color: las remotas sin el remoto (origin/feature/x → feature/x). */
  function branchColorKey(r) {
    if (r.type !== 'remote') { return r.name; }
    return r.branch || r.name.slice(r.name.indexOf('/') + 1);
  }
  /** El mismo color automático que autoBranchColor (extension.ts): main/master amarillo (MAIN_COLOR = 3), el resto por hash. */
  function autoBranchColor(name) {
    if (name === 'main' || name === 'master') { return PALETTE[3]; }
    let h = 2166136261;
    for (let i = 0; i < name.length; i++) { h = Math.imul(h ^ name.charCodeAt(i), 16777619); }
    const c = 1 + ((h >>> 0) % 9);
    return PALETTE[c === 3 ? 0 : c];
  }
  function branchColors() { return (settings && settings.branchColors) || {}; }
  function branchColorOf(name) { return branchColors()[name] || autoBranchColor(name); }
  /** Cambia (hex) o quita (null) el color de una rama; la extensión repinta el grafo al cambiar el ajuste. */
  function setBranchColor(name, hex) {
    const map = { ...branchColors() };
    if (hex) { map[name] = hex.toLowerCase(); } else { delete map[name]; }
    if (settings) { settings.branchColors = map; }
    vscode.postMessage({ type: 'setSetting', key: 'branchColors', value: map });
    if (data) { renderTree(); renderRows(true); }
  }
  /** Submenú Graph Color de una rama: automático, los colores de la paleta o uno propio. */
  function graphColorMenu(r) {
    const name = branchColorKey(r);
    const cur = branchColors()[name];
    return [
      { label: 'Automatic', checked: !cur, swatch: autoBranchColor(name), act: () => setBranchColor(name, null) },
      { sep: true },
      ...PALETTE.map((hex, i) => ({ label: PALETTE_NAMES[i], checked: !!cur && cur === hex.toLowerCase(), swatch: hex, act: () => setBranchColor(name, hex) })),
      { sep: true },
      { label: 'Custom', checked: !!cur && !PALETTE.some(h => h.toLowerCase() === cur), swatch: cur && !PALETTE.some(h => h.toLowerCase() === cur) ? cur : '', act: () => customBranchColor(name) },
    ];
  }
  /** Custom…: lleva a Settings ▸ Branch Colors con la rama en la lista y abre su selector de color. */
  function customBranchColor(name) {
    if (!branchColors()[name]) { setBranchColor(name, branchColorOf(name)); }
    switchTab('settings');
    renderSettings();
    const row = /** @type {HTMLElement | null} */ (settingsEl.querySelector(`.bc-row[data-bc-name="${CSS.escape(name)}"]`));
    if (row) {
      row.scrollIntoView({ block: 'center' });
      const input = /** @type {HTMLInputElement | null} */ (row.querySelector('input[type=color]'));
      if (input) { input.focus(); try { input.showPicker(); } catch { input.click(); } }
    }
  }

  function graphSvg(g, isHead) {
    const w = GRAPH_PAD * 2 + g.width * LANE_W;
    const mid = ROW_H / 2;
    let paths = '';
    let jumps = '';
    for (const e of g.edges) {
      let x1, y1, x2, y2;
      if (e.kind === 'down' || e.kind === 'up') {
        // Arista larga cortada (como JetBrains): un trozo con flecha; al pulsarla se salta al otro extremo
        const x = laneX(e.from);
        const tip = e.kind === 'down' ? mid + 5 : mid - 5;
        const line = e.kind === 'down' ? `M${x} 0L${x} ${tip}` : `M${x} ${tip}L${x} ${ROW_H}`;
        const head = `M${x - 3.5} ${mid}L${x} ${tip}L${x + 3.5} ${mid}`;
        paths += `<path d="${line}${head}" stroke="${color(e.color)}"/>`;
        jumps += `<rect class="g-jump" data-jump="${esc(e.jump || '')}" x="${x - LANE_W / 2}" y="0" width="${LANE_W}" height="${ROW_H}" fill="transparent">` +
          `<title>${e.kind === 'down' ? 'Jump to parent commit' : 'Jump to child commit'}</title></rect>`;
        continue;
      }
      if (e.kind === 'pass') { x1 = x2 = laneX(e.from); y1 = 0; y2 = ROW_H; }
      else if (e.kind === 'in') { x1 = laneX(e.from); y1 = 0; x2 = laneX(e.to); y2 = mid; }
      else { x1 = laneX(e.from); y1 = mid; x2 = laneX(e.to); y2 = ROW_H; }
      paths += `<path d="M${x1} ${y1}L${x2} ${y2}" stroke="${color(e.color)}"/>`;
    }
    const cx = laneX(g.col);
    const dot = isHead
      ? `<circle cx="${cx}" cy="${mid}" r="5" fill="var(--vscode-editor-background, #1e1e1e)" stroke="${color(g.color)}" stroke-width="2.2"/>`
      : `<circle cx="${cx}" cy="${mid}" r="4" fill="${color(g.color)}"/>`;
    return `<svg width="${w}" height="${ROW_H}" viewBox="0 0 ${w} ${ROW_H}"><g fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths}</g>${dot}${jumps}</svg>`;
  }

  /** Agrupa "origin/main" + "main" en una sola etiqueta como hace JetBrains. */
  function groupedRefs(hash) {
    const refs = refsByHash.get(hash) || [];
    const locals = refs.filter(r => r.type === 'local');
    const remotes = refs.filter(r => r.type === 'remote');
    const tags = refs.filter(r => r.type === 'tag');
    const used = new Set();
    const out = [];
    for (const l of locals) {
      const twins = remotes.filter(r => r.branch === l.name);
      twins.forEach(t => used.add(t.full));
      const label = twins.length ? `${twins.map(t => t.remote).join(' & ')} & ${l.name}` : l.name;
      out.push({ cls: l.current ? 'local current' : 'local', label, icon: ICON.branch, color: l.current ? '' : treeIconColor(l) });
    }
    for (const r of remotes) {
      if (!used.has(r.full)) { out.push({ cls: 'remote', label: r.name, icon: ICON.branch, color: treeIconColor(r) }); }
    }
    for (const t of tags) { out.push({ cls: 'tag', label: t.name, icon: ICON.tag }); }
    if (detachedHeads.has(hash)) { out.unshift({ cls: 'local current', label: 'HEAD', icon: ICON.head }); }
    return out;
  }

  function refsHtml(hash) {
    let g = groupedRefs(hash);
    // Show Tag Names: sin ella, los tags no salen en las filas (siguen en los detalles)
    if (!ui.logView.tags) { g = g.filter(r => r.cls !== 'tag'); }
    if (!g.length) { return ''; }
    // Compact References View: solo la primera etiqueta y «+N» con el resto en el tooltip
    if (ui.logView.compact && g.length > 1) {
      const rest = g.slice(1).map(r => r.label).join(', ');
      return `<span class="refs">${refHtml(g[0])}<span class="ref more" title="${esc(rest)}">+${g.length - 1}</span></span>`;
    }
    return `<span class="refs">${g.map(refHtml).join('')}</span>`;
  }

  /** Una etiqueta del log; si no cabe se recorta con «…» y el nombre entero va en el tooltip. */
  function refHtml(r) {
    return `<span class="ref ${r.cls}"${r.color ? ` data-rc="${esc(r.color)}"` : ''} title="${esc(r.label)}">${r.icon}<span class="ref-l">${esc(r.label)}</span></span>`;
  }

  /**
   * El mismo color que el icono de la rama en el árbol de la izquierda: su color del grafo
   * (Settings ▸ Branches ▸ Color branch icons…) o, si no, el de la carpeta con color más
   * cercana que la contiene (como walk: bajo un remoto se empieza con «@remote»). '' = el
   * color normal (amarillo las locales, morado las remotas). La rama actual no se toca: en
   * el árbol lleva su propio icono.
   */
  function treeIconColor(r) {
    if (ui.branchGraphColors) { return branchColorOf(branchColorKey(r)); }
    const colors = folderColors();
    const path = r.type === 'remote' ? branchColorKey(r) : r.name;
    let fc = r.type === 'remote' ? '@remote' : '';
    for (const seg of path.split('/').slice(0, -1)) {
      if (colorCss(colors[seg.toLowerCase()])) { fc = seg.toLowerCase(); }
    }
    return fc ? colorCss(colors[fc]) : '';
  }

  /** Commits cargados alcanzables desde el HEAD de algún repo (se calcula una vez por log). */
  function currentBranchCommits() {
    if (inCurrentBranch) { return inCurrentBranch; }
    const byId = new Map(data.commits.map(c => [c.hash, c]));
    const seen = new Set();
    const stack = [...headIds];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id) || !byId.has(id)) { continue; }
      seen.add(id);
      stack.push(...byId.get(id).parents);
    }
    inCurrentBranch = seen;
    return seen;
  }

  // ----- ojo del Log (View Options) ---------------------------------------------

  /** Columnas visibles y panel de detalles según ui.logView (CSSOM, sin style=""). */
  function applyLogView() {
    const lv = ui.logView;
    const cols = ['minmax(0, 1fr)'];
    // Anchos pensados para 13 px que crecen con la letra. El mensaje siempre conserva un mínimo
    // (con letra grande, si no, autor y fecha se lo comían entero); la fecha mide lo que su texto
    const k = FS / 13;
    const px = n => `${Math.round(n * k)}px`;
    cols[0] = `minmax(${px(110)}, 1fr)`;
    if (lv.author) { cols.push(`minmax(${px(50)}, ${px(160)})`); }
    if (lv.hash) { cols.push(px(76)); }
    if (lv.date) { cols.push(`${dateColumnWidth()}px`); }
    listEl.style.setProperty('--log-cols', cols.join(' '));
    listEl.classList.toggle('no-author', !lv.author);
    listEl.classList.toggle('no-date', !lv.date);
    listEl.classList.toggle('no-hash', !lv.hash);
    listEl.classList.toggle('no-subject', !lv.subject);
    detailsEl.classList.toggle('hidden', !lv.details);
    /** @type {HTMLElement} */ (document.querySelector('.splitter[data-target="details"]')).classList.toggle('hidden', !lv.details);
    // Con los detalles ocultos, la flecha para volver a sacarlos va al final de la barra del log
    $('#btn-details-expand').classList.toggle('hidden', lv.details);
  }

  /** Ancho de la columna Date: lo que mide la fecha más larga posible con la letra actual. */
  function dateColumnWidth() {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) { return Math.round(130 * FS / 13); }
    ctx.font = `${FS}px ${getComputedStyle(document.body).fontFamily}`;
    const now = Date.now() / 1000;
    // Absoluta (dos cifras en todo) o relativa (las más largas: horas y días)
    const samples = [formatDate(Date.UTC(2026, 11, 28, 22, 58) / 1000), formatDate(now - 23 * 3600), formatDate(now - 28 * 86400), formatDate(now - 50 * 60)];
    return Math.ceil(Math.max(...samples.map(t => ctx.measureText(t).width))) + 22;   // + padding de la celda
  }

  function logViewMenu() {
    const lv = ui.logView;
    const set = (k, v) => () => {
      lv[k] = v;
      saveUi();
      applyLogView();
      renderRows(true);
    };
    const flip = k => set(k, !lv[k]);
    const multi = !!(data && data.multi);
    return [
      { label: 'Show Branches', checked: !ui.branchesHidden, act: () => { ui.branchesHidden = !ui.branchesHidden; applyLayout(); saveUi(); } },
      { label: 'Show Details', checked: lv.details, act: flip('details') },
      { header: 'Show Columns' },
      ...(multi ? [{ label: 'Repository', checked: ui.repoNames, act: () => { ui.repoNames = !ui.repoNames; saveUi(); applySearch(); } }] : []),
      { label: 'Commit Message', checked: lv.subject, act: flip('subject') },
      { label: 'Author', checked: lv.author, act: flip('author') },
      { label: 'Hash', checked: lv.hash, act: flip('hash') },
      { label: 'Date', checked: lv.date, act: flip('date') },
      { header: 'References' },
      { label: 'Show Tag Names', checked: lv.tags, act: flip('tags') },
      { label: 'Compact References View', checked: lv.compact, act: flip('compact') },
      { header: 'Highlight' },
      { label: 'My Commits', checked: lv.mine, act: flip('mine') },
      { label: 'Merge Commits', checked: lv.merges, act: flip('merges') },
      { label: 'Current Branch', key: 'dims the rest', checked: lv.current, act: flip('current') },
      { header: 'Graph' },
      { label: 'Show Only First Parent', checked: !!(data && data.firstParent), disabled: !data, act: () => { filterChanging = true; vscode.postMessage({ type: 'logOption', key: 'firstParent', value: !data.firstParent }); } },
      { label: 'Show Long Edges', checked: !!(data && data.longEdges), disabled: !data, act: () => { filterChanging = true; vscode.postMessage({ type: 'logOption', key: 'longEdges', value: !data.longEdges }); } },
    ];
  }

  function formatDate(t) {
    const d = new Date(t * 1000);
    if (data && data.dateFormat === 'relative') {
      const diff = (Date.now() - d.getTime()) / 1000;
      const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
      if (diff < 3600) { return rtf.format(-Math.max(1, Math.round(diff / 60)), 'minute'); }
      if (diff < 86400) { return rtf.format(-Math.round(diff / 3600), 'hour'); }
      if (diff < 86400 * 30) { return rtf.format(-Math.round(diff / 86400), 'day'); }
    }
    return `${d.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' })}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
  }

  /** Desplaza el log para que el commit quede en el centro de la vista. */
  // Commit que había que centrar con el log oculto (no tiene alto): se centra al volver a él
  let pendingCenter = null;
  function centerOn(hash) {
    const i = indexByHash.get(hash);
    if (i == null) { return; }
    if (!listEl.clientHeight) { pendingCenter = hash; renderRows(true); return; }
    pendingCenter = null;
    listEl.scrollTop = Math.max(0, i * ROW_H - (listEl.clientHeight - ROW_H) / 2);
    renderRows(true);
  }

  /** opts.multi: conserva selSet (selección múltiple); si no, la selección queda en este commit. */
  function select(hash, opts = {}) {
    const changed = hash !== selected;
    selected = hash;
    if (!opts.multi) { selSet = new Set(hash ? [hash] : []); selAnchor = hash; }
    if (opts.scroll && hash != null && indexByHash.has(hash)) {
      const i = indexByHash.get(hash);
      const top = i * ROW_H;
      if (top < listEl.scrollTop) { listEl.scrollTop = top; }
      else if (top + ROW_H > listEl.scrollTop + listEl.clientHeight) { listEl.scrollTop = top + ROW_H - listEl.clientHeight; }
    }
    renderRows(true);
    if (!hash) { details = null; filesEl.innerHTML = ''; infoEl.innerHTML = ''; $('#details-title').textContent = ''; return; }
    if (changed || opts.force) {
      if (changed) { infoEl.innerHTML = '<div class="empty">Loading…</div>'; filesEl.innerHTML = ''; $('#details-title').textContent = ''; }
      clearTimeout(detailsTimer);
      detailsTimer = setTimeout(() => vscode.postMessage({ type: 'selectCommit', hash }), changed ? 60 : 0);
    }
  }

  /** Ctrl/Cmd+clic añade o quita un commit; Shift+clic (o Shift+flechas) selecciona el tramo desde el ancla. */
  function selectMulti(hash, shift) {
    if (shift && selAnchor && indexByHash.has(selAnchor)) {
      const a = indexByHash.get(selAnchor), b = indexByHash.get(hash);
      selSet = new Set(view.slice(Math.min(a, b), Math.max(a, b) + 1).map(c => c.hash));
    } else {
      if (selSet.has(hash) && selSet.size > 1) { selSet.delete(hash); } else { selSet.add(hash); }
      selAnchor = hash;
    }
    const cur = selSet.has(hash) ? hash : [...selSet][selSet.size - 1];
    select(cur, { multi: true });
  }
  /** Commits seleccionados visibles, en el orden del log (el más nuevo primero). */
  function selectedCommits() { return view.filter(c => selSet.has(c.hash)); }

  listEl.addEventListener('scroll', () => requestAnimationFrame(() => renderRows()));
  new ResizeObserver(() => renderRows(true)).observe(listEl);

  listEl.addEventListener('mousedown', e => {
    // Flecha de una arista larga: salta al commit del otro extremo y lo centra
    const jump = /** @type {Element} */ (e.target).closest('.g-jump');
    if (jump) {
      const to = jump.getAttribute('data-jump');
      if (to && indexByHash.has(to)) {
        e.preventDefault();
        listEl.focus();
        select(to);
        centerOn(to);
        return;
      }
    }
    if (/** @type {HTMLElement} */ (e.target).closest('.repo-mark')) {
      ui.repoNames = !ui.repoNames;
      saveUi();
      applyRepoColumn();
      renderRows(true);
    }
    const row = /** @type {HTMLElement} */ (e.target).closest('.row');
    if (!row || e.button !== 0) { return; }
    const h = row.getAttribute('data-h');
    // En macOS, Ctrl+clic es el clic derecho: allí se usa Cmd+clic
    const toggle = e.metaKey || (e.ctrlKey && !/Mac/i.test(navigator.platform));
    if (toggle || e.shiftKey) { e.preventDefault(); listEl.focus(); selectMulti(h, e.shiftKey); }
    else { select(h); }
  });
  listEl.addEventListener('click', e => {
    const btn = /** @type {HTMLElement} */ (e.target).closest('[data-act="load-more"]');
    if (btn) { /** @type {HTMLButtonElement} */ (btn).textContent = 'Loading…'; vscode.postMessage({ type: 'loadMore' }); }
  });
  listEl.addEventListener('contextmenu', e => {
    e.preventDefault();
    const row = /** @type {HTMLElement} */ (e.target).closest('.row');
    if (!row) { return; }
    const hash = row.getAttribute('data-h');
    listEl.focus();
    // Sobre una selección múltiple, el menú es el de varios commits
    if (selSet.has(hash) && selectedCommits().length > 1) { showMenu(multiCommitMenu(selectedCommits()), e.clientX, e.clientY); return; }
    select(hash);
    const c = view[indexByHash.get(hash)];
    if (c) { showMenu(commitMenu(c), e.clientX, e.clientY); }
  });
  listEl.addEventListener('keydown', e => {
    if (!view.length) { return; }
    if (runShortcut(e, 'log', () => {
      const many = selectedCommits();
      return many.length > 1 ? multiCommitMenu(many) : selected && indexByHash.has(selected) ? commitMenu(view[indexByHash.get(selected)]) : [];
    })) { return; }
    let i = selected != null && indexByHash.has(selected) ? indexByHash.get(selected) : -1;
    const page = Math.max(1, Math.floor(listEl.clientHeight / ROW_H) - 1);
    if (e.key === 'ArrowDown') { i = Math.min(view.length - 1, i + 1); }
    else if (e.key === 'ArrowUp') { i = Math.max(0, i - 1); }
    else if (e.key === 'PageDown') { i = Math.min(view.length - 1, i + page); }
    else if (e.key === 'PageUp') { i = Math.max(0, i - page); }
    else if (e.key === 'ArrowLeft' && i >= 0) {
      const ch = childrenByHash.get(view[i].hash);
      if (ch && indexByHash.has(ch)) { i = indexByHash.get(ch); }
    }
    else if (e.key === 'ArrowRight' && i >= 0) {
      const p = view[i].parents.find(x => indexByHash.has(x));
      if (p) { i = indexByHash.get(p); }
    }
    else if (e.key === 'Home') { i = 0; }
    else if (e.key === 'End') { i = view.length - 1; }
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      if (i < 0) { return; }
      e.preventDefault();
      const r = listEl.getBoundingClientRect();
      const many = selectedCommits();
      showMenu(many.length > 1 ? multiCommitMenu(many) : commitMenu(view[i]), r.left + 40, r.top + (i + 1) * ROW_H - listEl.scrollTop);
      return;
    }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      selSet = new Set(view.map(c => c.hash));
      select(selected || view[0].hash, { multi: true });
      return;
    }
    else { return; }
    e.preventDefault();
    if (e.shiftKey && !['ArrowLeft', 'ArrowRight'].includes(e.key)) {
      if (!selAnchor) { selAnchor = selected; }
      selectMulti(view[i].hash, true);
      const top = i * ROW_H;
      if (top < listEl.scrollTop) { listEl.scrollTop = top; }
      else if (top + ROW_H > listEl.scrollTop + listEl.clientHeight) { listEl.scrollTop = top + ROW_H - listEl.clientHeight; }
      return;
    }
    select(view[i].hash, { scroll: true });
  });

  const logSearch = /** @type {HTMLInputElement} */ ($('#log-search'));
  logSearch.addEventListener('input', () => {
    search = logSearch.value;
    applySearch();
    // Si el commit seleccionado sigue en la lista, se queda centrado en él; si no, arriba del todo
    if (selected && indexByHash.has(selected)) { centerOn(selected); }
    else { listEl.scrollTop = 0; if (view[0]) { select(view[0].hash); } }
  });
  logSearch.addEventListener('keydown', e => {
    if (e.key === 'Escape') { logSearch.value = ''; logSearch.dispatchEvent(new Event('input')); }
    if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); listEl.focus(); }
  });

  // Iconos SVG en vez de caracteres (‹ › ⟳), cuyo tamaño y alineación dependen de la fuente
  $('#btn-collapse').innerHTML = ICON.chevronLeft;
  $('#btn-expand').innerHTML = ICON.chevron;
  // Lo mismo para los detalles, en el lado derecho (= Show Details del ojo)
  $('#btn-details-collapse').innerHTML = ICON.chevron;
  $('#btn-details-expand').innerHTML = ICON.chevronLeft;
  const setDetails = on => { ui.logView.details = on; saveUi(); applyLogView(); renderRows(true); if (settingsEl && !$('#view-settings').classList.contains('hidden')) { renderSettings(); } };
  $('#btn-details-collapse').addEventListener('click', () => setDetails(false));
  $('#btn-details-expand').addEventListener('click', () => setDetails(true));
  $('#btn-refresh').innerHTML = ICON.refresh;
  $('#btn-log-view').innerHTML = ICON.eye;
  $('#btn-log-view').addEventListener('click', e => {
    const r = /** @type {HTMLElement} */ (e.currentTarget).getBoundingClientRect();
    showMenu(logViewMenu(), r.left, r.bottom + 2);
  });

  $('#btn-refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

  // -------------------------------------------------------------------------
  // Barra vertical de acciones Git (a la izquierda del panel de ramas)
  // -------------------------------------------------------------------------

  // La barra cambia con la pestaña. En Log hay dos grupos: sincronizar con el remoto y,
  // como en JetBrains, acciones sobre la rama seleccionada.
  const TAB_ACTIONS = {
    log: [
      { act: 'fetch', icon: ICON.fetch },
      { act: 'pull', icon: ICON.pull, cls: 'act-pull' },
      { act: 'push', icon: ICON.push, cls: 'act-push' },
      null,
      { act: 'newBranch', icon: ICON.newBranch },
      { act: 'favorite', icon: ICON.starOutline, cls: 'act-fav' },
      { act: 'merge', icon: ICON.merge },
      { act: 'delete', icon: ICON.trash },
      null,
      { act: 'goSettings', icon: ICON.gear },
    ],
    changes: [
      { act: 'chRefresh', icon: ICON.refresh },
      { act: 'chRollback', icon: ICON.undo },
      { act: 'chView', icon: ICON.eye },
      null,
      { act: 'chStage', icon: ICON.plus, cls: 'act-push' },
      { act: 'chUnstage', icon: ICON.minus },
      null,
      { act: 'chStash', icon: ICON.stash },
      null,
      { act: 'goSettings', icon: ICON.gear },
    ],
    settings: [],   // Settings no tiene barra lateral
    stash: [
      { act: 'stRefresh', icon: ICON.refresh },
      { act: 'stUnstash', icon: ICON.unstash, cls: 'act-pull' },
      { act: 'stView', icon: ICON.eye },
      { act: 'stDrop', icon: ICON.trash },
      null,
      { act: 'goSettings', icon: ICON.gear },
    ],
  };
  const actionsEl = $('#git-actions');
  function renderActionBar(tab) {
    actionsEl.innerHTML = TAB_ACTIONS[tab].map(a => a
      ? `<button class="icon-btn ${a.cls || ''}" data-act="${a.act}">${a.icon}</button>`
      : '<div class="sep"></div>').join('');
    updateActionBar();
  }

  /** Rama o tag seleccionado en el árbol (null si no hay o es una carpeta / HEAD). */
  function selectedRef() {
    const all = selectedRefs();
    return all.length === 1 ? all[0] : null;
  }
  /** Ramas y tags seleccionados en el árbol (sin carpetas ni HEAD). */
  function selectedRefs() {
    return data ? data.tree.filter(r => selectedTreeKeys.has(r.key)) : [];
  }
  /** Lo que necesita la extensión para actuar sobre una rama: en qué repos y cuál. */
  const refPayload = r => ({ full: r.full, name: r.name, type: r.type, repos: r.repos });
  const repoName = i => (data && data.repos[i] ? data.repos[i].name : '');
  /** Rama actual de esos repos: su nombre si es la misma en todos, o '' si no hay o difiere. */
  function currentOf(repoIds) {
    const names = [...new Set(repoIds.map(i => data.repos[i] && data.repos[i].head.branch))];
    return names.length === 1 && names[0] ? names[0] : '';
  }
  const hasCurrent = repoIds => repoIds.some(i => data.repos[i] && data.repos[i].head.branch);
  const curLabel = repoIds => currentOf(repoIds) ? `'${currentOf(repoIds)}'` : 'Current Branch';

  /** Estado de cada botón: título, si está activo y qué mensaje envía (msg) o qué ejecuta (run). */
  function actionState(act) {
    // Ruedita al final de cada barra: abre la pestaña Settings de la extensión
    if (act === 'goSettings') { return { title: 'Settings', on: true, run: () => switchTab('settings') }; }
    // chXxx y stXxx son los botones de Local Changes y Stash ('checkout' y 'stash' no)
    if (/^ch[A-Z]/.test(act)) { return changesActionState(act); }
    if (/^st[A-Z]/.test(act)) { return stashActionState(act); }
    const inc = data ? data.repos.filter(r => r.included) : [];
    const incoming = inc.reduce((s, r) => s + r.behind, 0);
    const outgoing = inc.reduce((s, r) => s + r.ahead, 0);
    const sel = selectedRef();
    const multi = multiState();
    if (multi && multi[act]) { return multi[act]; }
    // Con ramas locales seleccionadas, Pull y Push actúan sobre ellas; si no, sobre la rama actual
    if ((act === 'pull' || act === 'push') && selectedRefs().some(r => r.type === 'local')) {
      return multiBranchActions(selectedRefs())[act === 'pull' ? 'update' : 'push'];
    }
    const isBranch = !!sel && sel.type !== 'tag';
    const other = isBranch && !sel.current;
    const repo = { type: 'repoAction', action: act };
    const branch = action => ({ type: 'branchAction', action, ref: refPayload(sel) });
    const plural = n => `${n} commit${n === 1 ? '' : 's'}`;
    switch (act) {
      case 'fetch': return { title: 'Fetch', on: !!data, msg: repo };
      case 'pull': return { title: incoming ? `Pull (${plural(incoming)} incoming)` : 'Pull', on: !!data, msg: repo };
      case 'push': return { title: outgoing ? `Push… (${plural(outgoing)} outgoing)` : 'Push…', on: !!data, msg: repo };
      case 'newBranch': return sel
        ? { title: `New Branch from '${sel.name}'…`, on: true, msg: branch('newBranchFrom') }
        : { title: 'New Branch…', on: !!data, msg: repo };
      case 'favorite': return isBranch
        ? { title: isFavorite(sel) ? `Unmark '${sel.name}' as Favorite` : `Mark '${sel.name}' as Favorite`, on: true, msg: { type: 'toggleFavorite', ref: sel.full, repos: sel.repos } }
        : { title: 'Mark Selected Branch as Favorite', on: false, msg: null };
      case 'merge': {
        // Abre un selector con búsqueda para elegir la rama que se mergea en la actual
        const ids = inc.map(r => r.idx);
        const cur = hasCurrent(ids) ? curLabel(ids) : '';
        return { title: cur ? `Merge into ${cur}…` : 'Merge (HEAD is detached)', on: !!cur, run: () => vscode.postMessage({ type: 'pickMerge', preselect: sel && sel.type !== 'tag' ? sel.key : '' }) };
      }
      case 'delete':
        if (sel && sel.type === 'tag') { return { title: `Delete Tag '${sel.name}'`, on: true, msg: { type: 'tagAction', action: 'delete', name: sel.name, repos: sel.repos } }; }
        if (other && sel.protected) { return { title: `'${sel.name}' is protected and cannot be deleted`, on: false, msg: null }; }
        return { title: other ? `Delete '${sel.name}'` : 'Delete Selected Branch', on: other, msg: other && branch('delete') };
    }
    return { title: act, on: false, msg: null };
  }

  /**
   * Varias ramas seleccionadas en el árbol: Pull y Push actúan sobre las locales (Update /
   * Push de cada una), la estrella las marca todas y la papelera las borra. Merge, Compare y
   * New Branch necesitan una sola rama.
   */
  function multiState() {
    const sels = selectedRefs();
    if (sels.length < 2) { return null; }
    const st = multiBranchActions(sels);
    const off = title => ({ title, on: false, msg: null });
    return {
      pull: st.update, push: st.push, favorite: st.favorite, delete: st.delete,
      newBranch: off('New Branch (select a single branch)'),
    };
  }
  /** Acciones sobre varias ramas, comunes a la barra y al menú contextual. */
  function multiBranchActions(sels) {
    const branches = sels.filter(r => r.type !== 'tag');
    const locals = branches.filter(r => r.type === 'local');
    // Borrar: los tags siempre (solo el local) y las ramas que no sean la actual ni una protegida
    const tags = sels.filter(r => r.type === 'tag');
    const deletable = [...branches.filter(r => !r.current && !r.protected), ...tags];
    const delWhat = deletable.length === 1 ? `'${deletable[0].name}'`
      : deletable.every(r => r.type === 'tag') ? `${deletable.length} Tags`
      : deletable.some(r => r.type === 'tag') ? `${deletable.length} Branches and Tags` : `${deletable.length} Branches`;
    const n = (k, list = branches) => list.length === 1 ? `'${list[0].name}'` : `${k} Branches`;
    const many = (action, list) => ({ type: 'branchesAction', action, refs: list.map(refPayload) });
    const allFav = branches.length > 0 && branches.every(isFavorite);
    return {
      update: { title: locals.length ? `Update ${n(locals.length, locals)}` : 'Update (select local branches)', on: locals.length > 0, msg: many('update', locals) },
      push: { title: locals.length ? `Push ${n(locals.length, locals)}…` : 'Push (select local branches)', on: locals.length > 0, msg: many('push', locals) },
      favorite: { title: `${allFav ? 'Unmark' : 'Mark'} ${n(branches.length)} as Favorite`, on: branches.length > 0, msg: { type: 'toggleFavorite', refs: branches.map(r => ({ full: r.full, repos: r.repos })) } },
      delete: { title: deletable.length ? `Delete ${delWhat}` + (deletable.length < sels.length ? ' (current and protected branches skipped)' : '') : 'Delete (current and protected branches cannot be deleted)', on: deletable.length > 0, msg: many('delete', deletable) },
    };
  }
  function multiBranchMenu(sels) {
    const st = multiBranchActions(sels);
    const item = (s, sc) => ({ label: s.title, sc: `branches.${sc}`, disabled: !s.on, act: () => vscode.postMessage(s.msg) });
    // Con dos ramas exactamente: compararlas entre sí (el botón Compare ya no está en la barra)
    const pair = sels.filter(r => r.type !== 'tag');
    const both = pair.length === 2 && pair[0].repos.some(i => pair[1].repos.includes(i));
    const compare = pair.length === 2 && sels.length === 2
      ? [{ label: `Compare '${pair[0].name}' with '${pair[1].name}'${both ? '' : ' (not in the same repository)'}`, sc: 'branches.compare', disabled: !both, act: () => vscode.postMessage({ type: 'branchesAction', action: 'compare', refs: pair.map(refPayload) }) }, { sep: true }]
      : [];
    return [...compare, item(st.update, 'update'), item(st.push, 'push'), { sep: true }, item(st.favorite, 'favorite'),
      { label: 'Copy Branch Names', sc: 'branches.copyName', act: () => copyText(sels.map(r => r.name).join('\n')) },
      { sep: true }, item(st.delete, 'delete')];
  }

  /** Refresca títulos y botones desactivados según la rama actual y la seleccionada. */
  function updateActionBar() {
    for (const b of actionsEl.querySelectorAll('button[data-act]')) {
      const st = actionState(/** @type {HTMLElement} */ (b).dataset.act);
      b.setAttribute('title', st.title);
      b.setAttribute('aria-label', st.title);
      /** @type {HTMLButtonElement} */ (b).disabled = !st.on;
    }
    // La estrella se rellena si la rama seleccionada ya es favorita
    const favs = selectedRefs().filter(r => r.type !== 'tag');
    const fav = actionsEl.querySelector('[data-act="favorite"]');
    const filled = favs.length > 0 && favs.every(isFavorite);
    if (fav && fav.classList.contains('filled') !== filled) {
      fav.classList.toggle('filled', filled);
      fav.innerHTML = filled ? ICON.star : ICON.starOutline;
    }
  }

  actionsEl.addEventListener('click', e => {
    const b = /** @type {HTMLElement} */ (e.target).closest('button[data-act]');
    if (!b) { return; }
    const st = actionState(/** @type {HTMLElement} */ (b).dataset.act);
    if (!st.on) { return; }
    if (st.run) { st.run(); } else if (st.msg) { vscode.postMessage(st.msg); }
  });

  // -------------------------------------------------------------------------
  // Filtro por rama
  // -------------------------------------------------------------------------

  /** Filtro de rama (null: quitarlo); roots, además, cambia los repos de Paths. */
  function setFilter(ref, roots = null) {
    filterChanging = true;
    vscode.postMessage({ type: 'filter', ref, ...(roots ? { roots } : {}) });
  }

  // ----- filtros del log: Branch, User, Date y Paths (como en JetBrains) ----------

  const filtersEl = $('#log-filters');
  // Orden de los botones: Paths, Branch, User y Date
  const FILTER_LABEL = { paths: 'Paths', branch: 'Branch', user: 'User', date: 'Date' };
  let knownAuthors = new Map();  // autor → nº de commits, del último log sin filtro de usuario
  const DATE_PRESETS = [
    ['Last 24 Hours', '24 hours ago'],
    ['Last 7 Days', '7 days ago'],
    ['Last 30 Days', '30 days ago'],
    ['Last Year', '1 year ago'],
  ];

  const logFilters = () => (data && data.logFilters) || { authors: [], paths: [], roots: [] };
  /** Ruta de un archivo o carpeta del filtro Paths, como «repo/ruta» (o solo «ruta» con un repo). */
  function pathLabel(p) {
    const r = data.repos.find(x => p === x.root || p.startsWith(x.root + '/') || p.startsWith(x.root + '\\'));
    if (!r) { return p; }
    const rel = p.slice(r.root.length + 1).replace(/\\/g, '/');
    return data.multi ? `${r.name}/${rel}` : rel;
  }
  /** Primer «me» de los repos (user.name), para el filtro User. */
  const meName = () => (data ? (data.repos.find(r => r.me) || {}).me || '' : '');
  // Cada cambio lleva un número; los 'data' traen el del último que aplicó la extensión (logFilterSeq)
  let logFilterSeq = 0;
  // (al recargar la página se sigue por el de la extensión, no desde 0)
  const sendLogFilter = (key, value) => {
    filterChanging = true;
    logFilterSeq = Math.max(logFilterSeq, (data && data.logFilterSeq) || 0) + 1;
    vscode.postMessage({ type: 'logFilter', key, value, seq: logFilterSeq });
  };
  const pickLogFilter = key => vscode.postMessage({ type: 'pickLogFilter', key });
  // Filtro Paths marcado en el menú que el log aún no refleja: los clics seguidos se mandan juntos
  // (pathsTimer) y, hasta que llega el 'data' con el filtro nuevo, el menú se abre con esto
  let pathsPending = null;  // { roots, paths }
  let pathsTimer = 0;       // envío pendiente (0: ya se mandó)
  let pathsSeq = 0;         // número con el que se mandó: el 'data' que lo traiga ya lo refleja
  function flushPaths() {
    if (!pathsTimer) { return; }
    clearTimeout(pathsTimer);
    pathsTimer = 0;
    sendLogFilter('paths', pathsPending);
    pathsSeq = logFilterSeq;
  }
  /** Otro cambio del filtro Paths (Clear, doble clic en una rama) manda sobre lo pendiente. */
  function dropPaths() {
    clearTimeout(pathsTimer);
    pathsTimer = 0;
    pathsPending = null;
  }

  /** Texto del filtro activo («me», «2 users», «Last 7 Days»…) o '' si no está activo. */
  function filterValue(k) {
    const f = logFilters();
    if (k === 'branch') {
      if (!data || !data.filterRef) { return ''; }
      if (data.filterRef === 'HEAD') { return 'HEAD'; }
      const n = data.tree.find(x => x.key === data.filterRef);
      return n ? (n.common ? n.name : `${n.name} (${n.repoNames})`) : data.filterRef.replace(/^.*\|/, '').replace(/^refs\/(heads|remotes|tags)\//, '');
    }
    if (k === 'user') {
      if (!f.authors.length) { return ''; }
      if (f.authors.length === 1) { return f.authors[0] === meName() ? 'me' : f.authors[0]; }
      return `${f.authors.length} users`;
    }
    if (k === 'date') { return f.since || f.until ? (f.dateLabel || 'custom') : ''; }
    if (k === 'paths') {
      const items = [...f.roots.map(r => (data.repos.find(x => x.root === r) || { name: r }).name), ...f.paths.map(pathLabel)];
      return items.length === 1 ? items[0] : items.length ? `${items.length} paths` : '';
    }
    return '';
  }

  function renderFilters() {
    filtersEl.innerHTML = Object.keys(FILTER_LABEL).map(k => {
      const v = filterValue(k);
      const label = FILTER_LABEL[k];
      return `<span class="filter${v ? ' active' : ''}">` +
        `<button class="filter-btn" data-open="${k}" title="${v ? `${label}: ${esc(v)}` : `Filter by ${label}`}">` +
        `<span class="fl">${label}${v ? ':' : ''}</span>${v ? `<span class="fv">${esc(v)}</span>` : ''}${ICON.chevronDown}</button>` +
        (v ? `<button class="filter-clear" data-clear="${k}" title="Clear ${label} filter" aria-label="Clear ${label} filter">${ICON.close}</button>` : '') +
        '</span>';
    }).join('');
  }

  function branchFilterMenu() {
    const cur = data.filterRef;
    // Las ramas comunes a todos los repos salen solas; las demás, con sus repos a la derecha
    const item = r => ({ label: r.name, key: r.common ? '' : r.repoNames, checked: cur === r.key, act: () => setFilter(r.key) });
    const favFirst = (a, b) => (isFavorite(b) ? 1 : 0) - (isFavorite(a) ? 1 : 0) || (a.common === b.common ? 0 : a.common ? -1 : 1) || a.name.localeCompare(b.name);
    const locals = data.tree.filter(r => r.type === 'local').sort(favFirst);
    const remotes = data.tree.filter(r => r.type === 'remote').sort(favFirst);
    const tags = data.tree.filter(r => r.type === 'tag').sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
    // Una sola lista con secciones (sin submenús, que con muchas ramas tapaban el menú)
    return [
      { label: 'HEAD (Current Branch)', checked: cur === 'HEAD', act: () => setFilter('HEAD') },
      ...(locals.length ? [{ header: 'Local' }, ...locals.map(item)] : []),
      ...(remotes.length ? [{ header: 'Remote' }, ...remotes.map(item)] : []),
      ...(tags.length ? [{ header: 'Tags' }, ...tags.map(item)] : []),
    ];
  }

  function userFilterMenu() {
    const cur = logFilters().authors;
    const toggle = name => () => sendLogFilter('authors', cur.includes(name) ? cur.filter(x => x !== name) : [...cur, name]);
    const me = meName();
    const top = [...knownAuthors.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]).filter(n => n !== me).slice(0, 50);
    const extra = cur.filter(n => n !== me && !top.includes(n));
    return clean([
      me && { label: `me (${me})`, checked: cur.includes(me), act: toggle(me) },
      me && { sep: true },
      ...[...top, ...extra].map(n => ({ label: n, checked: cur.includes(n), act: toggle(n) })),
      { sep: true },
      { label: 'Select…', act: () => pickLogFilter('authors') },
    ]);
  }

  function dateFilterMenu() {
    const f = logFilters();
    return [
      ...DATE_PRESETS.map(([label, since]) => ({
        label, checked: f.since === since && !f.until,
        act: () => sendLogFilter('date', { since, label }),
      })),
      { sep: true },
      { label: 'Select…', act: () => pickLogFilter('date') },
    ];
  }

  /** Paths: los repositorios (marcables) y archivos o carpetas concretos, como en JetBrains. */
  function pathsFilterMenu() {
    // Repos y rutas forman un solo grupo marcable (el menú sigue abierto entre clics). Al log va
    // solo el estado final: varios clics seguidos se juntan en un único filtro (un solo git log).
    const { roots, paths } = pathsPending || logFilters();
    const send = vals => {
      pathsPending = { roots: vals.filter(v => v.root).map(v => v.root), paths: vals.filter(v => v.path).map(v => v.path) };
      clearTimeout(pathsTimer);
      pathsTimer = setTimeout(flushPaths, 250);
    };
    return clean([
      ...data.repos.map(r => ({ label: r.name, key: r.rel && r.rel !== r.name ? r.rel : '', checked: roots.includes(r.root), multi: send, value: { root: r.root } })),
      { sep: true },
      // Lo pendiente va antes: la extensión añade lo elegido al filtro que tenga
      { label: 'Select Files or Folders…', act: () => { flushPaths(); pickLogFilter('paths'); } },
      paths.length > 0 && { sep: true },
      ...paths.map(p => ({ label: pathLabel(p), checked: true, multi: send, value: { path: p } })),
    ]);
  }

  filtersEl.addEventListener('click', e => {
    const t = /** @type {HTMLElement} */ (e.target);
    const clear = t.closest('[data-clear]');
    if (clear) {
      const k = clear.getAttribute('data-clear');
      if (k === 'branch') { setFilter(null); }
      else if (k === 'paths') { dropPaths(); sendLogFilter('paths', { roots: [], paths: [] }); }
      else { sendLogFilter(k === 'user' ? 'authors' : k, k === 'date' ? null : []); }
      return;
    }
    const b = t.closest('[data-open]');
    if (!b || !data) { return; }
    const k = b.getAttribute('data-open');
    const menu = k === 'branch' ? branchFilterMenu() : k === 'user' ? userFilterMenu() : k === 'date' ? dateFilterMenu() : pathsFilterMenu();
    const r = b.getBoundingClientRect();
    const search = k === 'branch' ? 'Search branches and tags' : k === 'user' ? 'Search users' : undefined;
    showMenu(menu, r.left, r.bottom + 2, { search });
  });

  // -------------------------------------------------------------------------
  // Árbol de ramas
  // -------------------------------------------------------------------------

  function buildFolders(refs, nameOf, keyPrefix) {
    const root = { children: new Map(), leaves: [] };
    for (const r of refs) {
      const parts = nameOf(r).split('/');
      let node = root;
      let key = keyPrefix;
      for (let i = 0; i < parts.length - 1; i++) {
        key += '/' + parts[i];
        if (!node.children.has(parts[i])) { node.children.set(parts[i], { key, children: new Map(), leaves: [] }); }
        node = node.children.get(parts[i]);
      }
      node.leaves.push({ ref: r, label: parts[parts.length - 1] });
    }
    return root;
  }

  /** Ramas favoritas: las guarda la extensión por repositorio y llegan en cada mensaje 'data'. */
  const isFavorite = r => !!r && r.type !== 'tag' && !!r.favorite;
  const toggleFavorite = r => vscode.postMessage({ type: 'toggleFavorite', ref: r.full, repos: r.repos });

  /** Rama principal (main o master): va arriba del todo en Local y en cada remoto. */
  const MAIN_BRANCHES = ['main', 'master'];
  function isMainBranch(name) { return MAIN_BRANCHES.includes(name); }
  /** Orden: main antes que master y, con varios repos, la común antes que las de algunos repos. */
  function byMain(nameOf) {
    return (a, b) => MAIN_BRANCHES.indexOf(nameOf(a)) - MAIN_BRANCHES.indexOf(nameOf(b)) || (b.common ? 1 : 0) - (a.common ? 1 : 0);
  }

  function renderTree() {
    if (!data) { return; }
    const q = branchSearch.trim().toLowerCase();
    const match = r => !q || r.name.toLowerCase().includes(q);
    // Con varios repos, las ramas comunes salen una vez y las demás con sus repos al lado
    const locals = data.tree.filter(r => r.type === 'local' && match(r));
    const remotes = data.tree.filter(r => r.type === 'remote' && match(r));
    const tags = data.tree.filter(r => r.type === 'tag' && match(r));
    const open = key => q ? true : ui.expanded.has(key);

    let html = '';
    const node = (depth, inner, attrs = '', cls = '') =>
      `<div class="tnode ${cls}" data-pad="${6 + depth * 14}" ${attrs}>${inner}</div>`;
    // Color del icono según jbGit.folderColors (por nombre de carpeta; «@remote» para las nubes
    // de cada remoto). Se aplica tras pintar con CSSOM (applyFolderColors): nada de style=""
    const folder = (key, label, depth, icon = ICON.folder, count = '', fc = depth > 0 ? label.toLowerCase() : '') =>
      node(depth, `${twisty(open(key))}<span class="ico-folder"${fc ? ` data-fc="${esc(fc)}"` : ''}>${icon}</span><span class="label">${esc(label)}</span>${count ? `<span class="hint">${count}</span>` : ''}`,
        `data-key="${esc(key)}" data-folder="1"`, selectedTreeKeys.has(key) ? 'selected' : '');

    // fc: carpeta con color más cercana que contiene la rama (para su icono si no se usa el del grafo)
    const leaf = (r, label, depth, fc = '') => {
      const isCur = !!r.current;
      const cls = [selectedTreeKeys.has(r.key) ? 'selected' : '', isCur ? 'current' : '', data.filterRef === r.key ? 'filtered' : ''].join(' ');
      const icon = r.type === 'tag' ? `<span class="ico-tag">${ICON.tag}</span>`
        : isCur ? `<span class="ico-head" title="Current Branch">${ICON.current}</span>`
        : isFavorite(r) ? `<span class="ico-fav" title="Favorite">${ICON.star}</span>`
        : `<span class="${isCur ? 'ico-head' : r.type === 'local' ? 'ico-local' : 'ico-remote'}"${graphColorAttr(r, fc)}>${ICON.branch}</span>`;
      // Commits por subir (push, ↑) en verde y por bajar (pull, ↓) en azul
      const sync = [];
      // Con varios repos es la suma de todos; el tooltip lo reparte por repo
      const perRepo = k => (r.sync && r.sync.length > 1 ? '\n' + r.sync.filter(x => x[k]).map(x => `${repoName(x.repo)}: ${x[k]}`).join('\n') : '');
      if (r.ahead) { sync.push(`<span class="sync-push" title="${r.ahead} outgoing commit${r.ahead === 1 ? '' : 's'}${esc(perRepo('ahead'))}">↑${r.ahead}</span>`); }
      if (r.behind) { sync.push(`<span class="sync-pull" title="${r.behind} incoming commit${r.behind === 1 ? '' : 's'}${esc(perRepo('behind'))}">↓${r.behind}</span>`); }
      const where = r.common ? '' : `<span class="hint repo-hint" title="${esc(r.repoNames)}">(${esc(r.repoNames)})</span>`;
      // La rama actual lleva la marca HEAD al lado (en lugar de un nodo HEAD aparte)
      const head = isCur && r.type === 'local' ? '<span class="head-badge" title="HEAD: the checked-out branch">HEAD</span>' : '';
      return node(depth, `<span class="twisty"></span>${icon}<span class="label" title="${esc(r.name)}${r.common ? (data.multi ? ` — in all ${data.repos.filter(x => x.included).length} repositories` : '') : ` (${esc(r.repoNames)})`}">${esc(label)}</span>${head}${r.protected ? `<span class="ico-lock" title="Protected branch: it cannot be deleted">${ICON.lock}</span>` : ''}${sync.length ? `<span class="hint">${sync.join(' ')}</span>` : ''}${where}`,
        `data-key="${esc(r.key)}" data-ref="${esc(r.key)}"`, cls);
    };

    // En cada nivel: primero las favoritas, luego el resto de ramas y al final las
    // subcarpetas (bugfix/, release/…)
    const walk = (n, depth, fc = '') => {
      const byFav = (a, b) => (isFavorite(b.ref) ? 1 : 0) - (isFavorite(a.ref) ? 1 : 0) || a.label.localeCompare(b.label);
      for (const l of n.leaves.sort(byFav)) { html += leaf(l.ref, l.label, depth, fc); }
      const dirs = [...n.children.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const colors = folderColors();
      for (const [name, child] of dirs) {
        html += folder(child.key, name, depth);
        // Una subcarpeta sin color propio hereda el de la carpeta con color que la contiene
        if (open(child.key)) { walk(child, depth + 1, colorCss(colors[name.toLowerCase()]) ? name.toLowerCase() : fc); }
      }
    };

    html += folder('local', 'Local', 0, ICON.folder, String(locals.length));
    if (open('local')) {
      // HEAD separado (sin rama) en algún repo: una fila HEAD al principio de Local, ya que
      // no hay rama a la que ponerle la marca
      const detached = data.repos.filter(x => x.included && x.head.hash && !x.head.branch);
      if (detached.length && !q) {
        const headCls = [selectedTreeKeys.has('HEAD') ? 'selected' : '', data.filterRef === 'HEAD' ? 'filtered' : ''].join(' ');
        const at = detached.map(x => (data.multi ? `${x.name}: ` : '') + x.head.hash.replace(/^\d+:/, '').slice(0, 8)).join(', ');
        html += node(1, `<span class="twisty"></span><span class="ico-head">${ICON.head}</span><span class="label" title="HEAD is not on a branch">HEAD (detached at ${esc(at)})</span>`, 'data-key="HEAD" data-ref="HEAD"', headCls);
      }
      // La rama actual va arriba del todo, fuera de su carpeta y con su nombre completo
      for (const r of locals.filter(x => x.current)) { html += leaf(r, r.name, 1); }
      // Después, main / master (si no son la actual): siempre arriba, como en JetBrains
      const mains = locals.filter(x => !x.current && isMainBranch(x.name));
      for (const r of mains.sort(byMain(x => x.name))) { html += leaf(r, r.name, 1); }
      walk(buildFolders(locals.filter(x => !x.current && !isMainBranch(x.name)), r => r.name, 'local'), 1);
    }

    if (remotes.length || !q) {
      html += folder('remote', 'Remote', 0, ICON.remote, String(remotes.length));
      if (open('remote')) {
        const byRemote = new Map();
        for (const r of remotes) {
          if (!byRemote.has(r.remote)) { byRemote.set(r.remote, []); }
          byRemote.get(r.remote).push(r);
        }
        for (const [remote, list] of [...byRemote.entries()].sort()) {
          const key = 'remote/' + remote;
          html += folder(key, remote, 1, ICON.remote, '', '@remote');
          if (open(key)) {
            // origin/main y origin/master arriba del todo en su remoto
            for (const r of list.filter(x => isMainBranch(x.branch)).sort(byMain(x => x.branch))) { html += leaf(r, r.branch, 2, '@remote'); }
            walk(buildFolders(list.filter(x => !isMainBranch(x.branch)), r => r.branch, key), 2, '@remote');
          }
        }
      }
    }

    if (tags.length) {
      html += folder('tags', 'Tags', 0, ICON.tag, String(tags.length));
      if (open('tags')) {
        const sorted = [...tags].sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
        // Los que no se han subido al remoto van aparte, en la carpeta Local
        const unpushed = sorted.filter(t => t.unpushed);
        if (unpushed.length) {
          html += folder('tags/local', 'Local', 1, ICON.folder, String(unpushed.length));
          if (open('tags/local')) { for (const t of unpushed) { html += leaf(t, t.name, 2); } }
        }
        for (const t of sorted.filter(x => !x.unpushed)) { html += leaf(t, t.name, 1); }
      }
    }
    treeEl.innerHTML = html;
    applyPositions(treeEl);
    applyFolderColors(treeEl);
    for (const el of treeEl.querySelectorAll('[data-gc]')) {
      const gc = /** @type {HTMLElement} */ (el).dataset.gc || '';
      /** @type {HTMLElement} */ (el).style.color = color(/^\d+$/.test(gc) ? Number(gc) : gc);
    }
    updateActionBar();
  }

  treeEl.addEventListener('click', e => {
    const n = /** @type {HTMLElement} */ (e.target).closest('.tnode');
    if (!n) {
      // Clic en una zona vacía: se quita la selección (Pull y Push vuelven a la rama actual)
      selectedTreeKeys = new Set(); selectedTreeKey = null;
      markTreeSelection(); updateActionBar();
      return;
    }
    const key = n.getAttribute('data-key');
    if (n.hasAttribute('data-folder')) {
      selectedTreeKey = key;
      selectedTreeKeys = new Set([key]);
      if (ui.expanded.has(key)) { ui.expanded.delete(key); } else { ui.expanded.add(key); }
      saveUi();
      renderTree();
      return;
    }
    // Un clic solo selecciona la rama (para la barra de acciones); el filtro va con doble clic.
    // Ctrl/Cmd+clic añade o quita ramas y Shift+clic selecciona un rango, como en JetBrains.
    const isRef = k => k && k !== 'HEAD' && !k.startsWith('local') && !k.startsWith('remote') && !k.startsWith('tags');
    const refKeys = new Set([...selectedTreeKeys].filter(isRef));
    if ((e.ctrlKey || e.metaKey) && key !== 'HEAD') {
      if (refKeys.has(key)) { refKeys.delete(key); } else { refKeys.add(key); }
      selectedTreeKeys = refKeys;
      selectedTreeKey = key;
    } else if (e.shiftKey && key !== 'HEAD' && isRef(selectedTreeKey)) {
      const nodes = [...treeEl.querySelectorAll('.tnode[data-ref]')].map(x => x.getAttribute('data-ref')).filter(k => k !== 'HEAD');
      const a = nodes.indexOf(selectedTreeKey), b = nodes.indexOf(key);
      selectedTreeKeys = new Set(a < 0 || b < 0 ? [key] : nodes.slice(Math.min(a, b), Math.max(a, b) + 1));
    } else {
      selectedTreeKeys = new Set([key]);
      selectedTreeKey = key;
    }
    // Sin repintar el árbol: si el nodo cambia entre los dos clics, el navegador no lanza dblclick
    markTreeSelection();
    updateActionBar();
  });
  function markTreeSelection() {
    for (const x of treeEl.querySelectorAll('.tnode')) { x.classList.toggle('selected', selectedTreeKeys.has(x.getAttribute('data-key'))); }
  }
  treeEl.addEventListener('dblclick', e => {
    const n = /** @type {HTMLElement} */ (e.target).closest('.tnode[data-ref]');
    if (!n || !data) { return; }
    const ref = n.getAttribute('data-ref');
    const node = data.tree.find(x => x.key === ref);
    // Rama de solo algunos repos: también se filtra Paths por esos repos
    const roots = node && !node.common ? node.repos.map(i => data.repos[i].root) : null;
    // Si el filtro de rama cambia Paths (roots), manda sobre lo pendiente del menú; si no, eso se
    // manda antes, para no perderlo
    const sendFilter = (/** @type {string | null} */ r, /** @type {string[] | null} */ newRoots) => {
      if (newRoots) { dropPaths(); } else { flushPaths(); }
      setFilter(r, newRoots);
    };
    if (data.filterRef === ref) {
      // Quitar el filtro; si Paths sigue siendo el que puso la rama, también se quita
      const cur = logFilters().roots;
      const same = branchRoots && cur.length === branchRoots.length && branchRoots.every(r => cur.includes(r));
      branchRoots = null;
      sendFilter(null, same ? [] : null);
    } else {
      branchRoots = roots;
      sendFilter(ref, roots);
    }
  });
  treeEl.addEventListener('contextmenu', e => {
    e.preventDefault();
    const n = /** @type {HTMLElement} */ (e.target).closest('.tnode[data-ref]');
    if (!n || !data) { return; }
    const key = n.getAttribute('data-ref');
    // Clic derecho fuera de la selección: se selecciona solo esa rama
    if (!selectedTreeKeys.has(key)) { selectedTreeKeys = new Set([key]); selectedTreeKey = key; }
    markTreeSelection();
    updateActionBar();
    const sels = selectedRefs();
    if (sels.length > 1) { showMenu(multiBranchMenu(sels), e.clientX, e.clientY); return; }
    const r = data.tree.find(x => x.key === key);
    if (!r) { return; }
    showMenu(r.type === 'tag' ? tagMenu(r, true) : branchMenu(r, true), e.clientX, e.clientY);
  });

  const branchSearchEl = /** @type {HTMLInputElement} */ ($('#branch-search'));
  branchSearchEl.addEventListener('input', () => { branchSearch = branchSearchEl.value; renderTree(); });
  branchSearchEl.addEventListener('keydown', e => {
    if (e.key === 'Escape') { branchSearchEl.value = ''; branchSearch = ''; renderTree(); }
  });

  // -------------------------------------------------------------------------
  // Panel de detalles
  // -------------------------------------------------------------------------

  function renderDetails() {
    const d = details;
    if (!d) { return; }
    $('#details-title').textContent = `${d.files.length} file${d.files.length === 1 ? '' : 's'} changed`;

    // Árbol de archivos con carpetas compactadas (a/b/c → una sola fila)
    const root = { dirs: new Map(), files: [] };
    for (const f of d.files) {
      const parts = f.path.split('/');
      let n = root;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!n.dirs.has(parts[i])) { n.dirs.set(parts[i], { dirs: new Map(), files: [] }); }
        n = n.dirs.get(parts[i]);
      }
      n.files.push({ f, name: parts[parts.length - 1] });
    }
    let html = `<div class="tnode" data-pad="6">${twisty(true)}<span class="ico-folder">${ICON.folder}</span><span class="label">${esc(d.repoName || '')}</span><span class="hint">${d.files.length} file${d.files.length === 1 ? '' : 's'}</span></div>`;
    const walk = (n, depth, prefix) => {
      for (const [name, child] of [...n.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        let label = name;
        let c = child;
        while (c.files.length === 0 && c.dirs.size === 1) {
          const [nn, cc] = [...c.dirs.entries()][0];
          label += '/' + nn;
          c = cc;
        }
        const key = 'f:' + prefix + label;
        const isOpen = !ui.expanded.has('collapsed:' + key);
        const count = countFiles(c);
        html += `<div class="tnode" data-fkey="${esc(key)}" data-pad="${6 + depth * 14}">${twisty(isOpen)}<span class="ico-folder">${ICON.folder}</span><span class="label">${esc(label)}</span><span class="hint">${count} file${count === 1 ? '' : 's'}</span></div>`;
        if (isOpen) { walk(c, depth + 1, prefix + label + '/'); }
      }
      for (const { f, name } of n.files.sort((a, b) => a.name.localeCompare(b.name))) {
        const idx = d.files.indexOf(f);
        const tip = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
        html += `<div class="tnode" data-file="${idx}" data-pad="${6 + depth * 14}" title="${esc(tip)}"><span class="twisty"></span><span class="st-${f.status}">${ICON.file}</span><span class="label st-${f.status}">${esc(name)}</span>${f.oldPath ? `<span class="hint">renamed</span>` : ''}</div>`;
      }
    };
    walk(root, 1, '');
    if (!d.files.length) { html += '<div class="empty">No file changes in this commit.</div>'; }
    filesEl.innerHTML = html;
    applyPositions(filesEl);

    // Mensaje y metadatos
    const lines = d.message.split('\n');
    const subject = lines.shift() || '';
    const body = lines.join('\n').replace(/^\n+/, '');
    const when = t => new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    const short = id => id.replace(/^\d+:/, '').slice(0, 8);
    const parentLinks = d.parents.map(p => `<button class="link-btn hash" data-goto="${p}">${short(p)}</button>`).join(', ');
    const refs = groupedRefs(d.hash);
    infoEl.innerHTML =
      `<p class="msg-subject">${esc(subject)}</p>` +
      (body ? `<p class="msg-body">${esc(body)}</p>` : '') +
      '<div class="meta">' +
      (data && data.multi ? `<div>Repository: ${esc(d.repoName)}</div>` : '') +
      `<div><span class="hash">${short(d.hash)}</span> ${esc(d.author)} &lt;${esc(d.email)}&gt; on ${esc(when(d.time))}</div>` +
      (d.committer !== d.author || d.committerEmail !== d.email || Math.abs(d.commitTime - d.time) > 60
        ? `<div>Committed by ${esc(d.committer)} on ${esc(when(d.commitTime))}</div>` : '') +
      (d.parents.length ? `<div>${d.parents.length > 1 ? 'Parents' : 'Parent'}: ${parentLinks}</div>` : '<div>Root commit</div>') +
      (refs.length ? `<div class="refs-line">${refs.map(r => `<span class="ref ${r.cls}">${r.icon}${esc(r.label)}</span>`).join('')}</div>` : '') +
      '</div>';
  }

  function countFiles(n) {
    let k = n.files.length;
    for (const c of n.dirs.values()) { k += countFiles(c); }
    return k;
  }

  filesEl.addEventListener('click', e => {
    const t = /** @type {HTMLElement} */ (e.target).closest('.tnode');
    if (!t) { return; }
    filesEl.querySelectorAll('.tnode.selected').forEach(x => x.classList.remove('selected'));
    t.classList.add('selected');
    const fkey = t.getAttribute('data-fkey');
    if (fkey) {
      const k = 'collapsed:' + fkey;
      if (ui.expanded.has(k)) { ui.expanded.delete(k); } else { ui.expanded.add(k); }
      renderDetails();
    }
  });
  filesEl.addEventListener('dblclick', e => {
    const t = /** @type {HTMLElement} */ (e.target).closest('.tnode[data-file]');
    if (t) { openFileDiff(Number(t.getAttribute('data-file'))); }
  });
  filesEl.addEventListener('keydown', e => {
    const t = filesEl.querySelector('.tnode.selected[data-file]');
    if (runShortcut(e, 'commitFiles', () => (t && details ? commitFileMenu(Number(t.getAttribute('data-file'))) : []))) { return; }
    if (t && e.key === 'Enter') { openFileDiff(Number(t.getAttribute('data-file'))); }
  });
  filesEl.tabIndex = 0;
  filesEl.addEventListener('contextmenu', e => {
    e.preventDefault();
    const t = /** @type {HTMLElement} */ (e.target).closest('.tnode[data-file]');
    if (!t || !details) { return; }
    filesEl.querySelectorAll('.tnode.selected').forEach(x => x.classList.remove('selected'));
    t.classList.add('selected');
    showMenu(commitFileMenu(Number(t.getAttribute('data-file'))), e.clientX, e.clientY);
  });
  /** Menú de un archivo de los detalles del commit (también lo usan sus atajos). */
  function commitFileMenu(i) {
    const f = details.files[i];
    return [
      { label: 'Show Diff', sc: 'commitFiles.showDiff', key: 'Double-click', act: () => openFileDiff(i) },
      { label: 'Open Repository Version', sc: 'commitFiles.openRepoVersion', disabled: f.status === 'D', act: () => vscode.postMessage({ type: 'openFile', hash: details.hash, path: f.path }) },
      { label: 'Show History', sc: 'commitFiles.showHistory', act: () => vscode.postMessage({ type: 'showHistory', repo: details.repo, path: f.path, folder: false, hash: details.hash }) },
      { sep: true },
      { label: 'Copy Path', sc: 'commitFiles.copyPath', act: () => navigator.clipboard.writeText(f.path) },
    ];
  }

  function openFileDiff(i) {
    if (!details) { return; }
    vscode.postMessage({ type: 'openFileDiff', hash: details.hash, parent: details.parents[0] || null, file: details.files[i] });
  }

  infoEl.addEventListener('click', e => {
    const b = /** @type {HTMLElement} */ (e.target).closest('[data-goto]');
    if (b) { gotoCommit(b.getAttribute('data-goto')); }
  });

  function gotoCommit(hash) {
    if (indexByHash.has(hash)) { select(hash, { scroll: true }); listEl.focus(); }
  }

  // -------------------------------------------------------------------------
  // Menús
  // -------------------------------------------------------------------------

  const post = (type, extra) => vscode.postMessage({ type, ...extra });

  function commitMenu(c) {
    const head = data.repos[c.repo].head;
    const cur = head.branch;
    const isHead = c.hash === head.hash;
    const isMerge = c.parents.length > 1;
    const refs = refsByHash.get(c.hash) || [];
    const branches = refs.filter(r => r.type !== 'tag')
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'local' ? -1 : 1));
    const tags = refs.filter(r => r.type === 'tag');
    const act = action => () => post('commitAction', { action, hash: c.hash });
    const child = childrenByHash.get(c.hash);
    const parent = c.parents.find(p => indexByHash.has(p));

    return clean([
      { label: 'Copy Revision Number', sc: 'log.copyHash', act: act('copyHash') },
      { label: 'Create Patch…', sc: 'log.createPatch', act: act('createPatch') },
      { label: 'Cherry-Pick', sc: 'log.cherryPick', disabled: isHead || isMerge, act: act('cherryPick') },
      { sep: true },
      { label: 'Checkout Revision', sc: 'log.checkout', disabled: isHead && !cur, act: act('checkout') },
      { label: 'Compare with Local', sc: 'log.compareWithLocal', act: act('compareWithLocal') },
      { sep: true },
      { label: cur ? `Reset '${cur}' to Here…` : 'Reset Current Branch to Here…', sc: 'log.reset', disabled: isHead || !head.hash, act: act('reset') },
      { label: 'Revert Commit', sc: 'log.revert', disabled: isMerge, act: act('revert') },
      { label: 'Undo Commit…', sc: 'log.undoCommit', disabled: !(isHead && c.parents.length === 1), act: act('undoCommit') },
      { label: 'Drop Commit…', sc: 'log.drop', disabled: isMerge || !inCurrent(c), act: () => post('commitsAction', { action: 'drop', hashes: [c.hash] }) },
      { sep: true },
      ...branches.map(r => ({ label: `Branch '${r.name}'`, submenu: branchMenu(r) })),
      ...tags.map(t => ({ label: `Tag '${t.name}'`, submenu: tagMenu(t) })),
      { label: 'New Branch…', sc: 'log.newBranch', act: act('newBranch') },
      { label: 'New Tag…', sc: 'log.newTag', act: act('newTag') },
      { sep: true },
      { label: 'Go to Child Commit', key: '←', disabled: !child || !indexByHash.has(child), act: () => gotoCommit(child) },
      { label: 'Go to Parent Commit', key: '→', disabled: !parent, act: () => gotoCommit(parent) },
    ]);
  }

  /** ¿Está el commit en la rama actual de su repo? (alcanzable desde su HEAD por el log cargado) */
  function inCurrent(c) {
    const head = data.repos[c.repo] && data.repos[c.repo].head;
    if (!head || !head.branch || !head.hash) { return false; }
    // Se recorre todo el log cargado (no solo lo que deja ver la búsqueda)
    if (!reachCache.has('')) { reachCache.set('', new Map(data.commits.map(x => [x.hash, x]))); }
    const all = reachCache.get('');
    // Si el HEAD no está cargado (filtros), que lo decida la extensión
    if (!all.has(head.hash)) { return true; }
    let reach = reachCache.get(head.hash);
    if (!reach) {
      reach = new Set();
      const stack = [head.hash];
      while (stack.length) {
        const h = stack.pop();
        if (reach.has(h) || !all.has(h)) { continue; }
        reach.add(h);
        stack.push(...all.get(h).parents);
      }
      reachCache.set(head.hash, reach);
    }
    if (reach.has(c.hash)) { return true; }
    // Con filtros de autor, fecha, rutas o First Parent faltan commits intermedios: decide la extensión
    const f = data.logFilters || {};
    return !!((f.authors && f.authors.length) || f.since || f.until || (f.paths && f.paths.length) || data.firstParent);
  }

  /**
   * Menú con varios commits seleccionados (como JetBrains): Cherry-Pick (de varios repos,
   * cada uno en el suyo), Compare Versions (dos commits), Squash / Fixup / Drop (de un solo
   * repo y en su rama actual; la extensión comprueba el resto).
   */
  function multiCommitMenu(cs) {
    const n = cs.length;
    const one = new Set(cs.map(c => c.repo)).size === 1;
    const anyMerge = cs.some(c => c.parents.length > 1);
    const hashes = cs.map(c => c.hash);
    const act = action => () => post('commitsAction', { action, hashes });
    const notOne = one ? '' : ' (not in the same repository)';
    const rewritable = one && !anyMerge && cs.every(inCurrent);
    const why = !one ? notOne : anyMerge ? ' (merge commits selected)' : !rewritable ? ' (not in the current branch)' : '';
    return clean([
      { label: 'Copy Revision Numbers', sc: 'log.copyHash', act: act('copyHashes') },
      { label: `Cherry-Pick ${n} Commits`, sc: 'log.cherryPick', disabled: anyMerge || cs.some(c => headIds.has(c.hash)), act: act('cherryPick') },
      { sep: true },
      n === 2 && { label: `Compare Versions${notOne}`, sc: 'log.compareVersions', disabled: !one, act: act('compare') },
      { sep: true },
      { label: `Squash ${n} Commits…${why}`, sc: 'log.squash', disabled: !rewritable, act: act('squash') },
      { label: `Fixup ${n} Commits${why}`, sc: 'log.fixup', disabled: !rewritable, act: act('fixup') },
      { label: `Drop ${n} Commits…${why}`, sc: 'log.drop', disabled: !rewritable, act: act('drop') },
    ]);
  }

  /**
   * Menú de una rama. Sirve para las del árbol (una rama común actúa en todos sus repos)
   * y para las de un commit concreto (solo en el repo de ese commit).
   */
  /** fromTree: abierto desde el árbol de ramas, donde Ctrl+C copia el nombre. */
  function branchMenu(r, fromTree = false) {
    const isCur = !!r.current;
    const local = r.type === 'local';
    // Desde el log, las refs no traen «protected»: se mira en el árbol
    const prot = r.protected ?? (r.type === 'remote' && !!(data.tree || []).find(n => n.full === r.full && n.protected));
    const ref = refPayload(r);
    const act = action => () => post('branchAction', { action, ref });
    const both = !isCur && hasCurrent(r.repos);
    const cur = curLabel(r.repos);
    // Los atajos son del árbol de ramas: en el submenú de un commit no se muestran
    const sc = id => (fromTree ? `branches.${id}` : undefined);

    return clean([
      !isCur && { label: 'Checkout', sc: sc('checkout'), act: act('checkout') },
      { label: `New Branch from '${r.name}'…`, sc: sc('newBranchFrom'), act: act('newBranchFrom') },
      { label: isFavorite(r) ? 'Unmark as Favorite' : 'Mark as Favorite', sc: sc('favorite'), act: () => toggleFavorite(r) },
      { label: 'Graph Color', submenu: graphColorMenu(r) },
      both && local && { label: `Checkout and Rebase onto ${cur}`, sc: sc('checkoutAndRebase'), act: act('checkoutAndRebase') },
      { sep: true },
      both && { label: `Compare with ${cur}`, sc: sc('compare'), act: act('compare') },
      { label: 'Show Diff with Working Tree', sc: sc('diffWorkingTree'), act: act('diffWorkingTree') },
      { sep: true },
      both && { label: `Rebase ${cur} onto '${r.name}'`, sc: sc('rebaseOnto'), act: act('rebaseOnto') },
      both && { label: `Merge '${r.name}' into ${cur}`, sc: sc('merge'), act: act('merge') },
      { sep: true },
      local && { label: 'Update', sc: sc('update'), disabled: !(r.hasUpstream ?? !!r.upstream), act: act('update') },
      local && { label: 'Push…', sc: sc('push'), act: act('push') },
      { sep: true },
      local && { label: 'Rename…', sc: sc('rename'), act: act('rename') },
      { label: 'Copy Branch Name', sc: sc('copyName'), act: () => copyText(r.name) },
      // Borrar siempre lo último del menú
      { sep: true },
      !isCur && { label: prot ? 'Delete (protected branch)' : 'Delete', sc: sc('delete'), disabled: !!prot, act: act('delete') },
    ]);
  }

  const copyText = t => { if (t) { navigator.clipboard.writeText(t); } };
  /** Ctrl/Cmd+C en el árbol de ramas: los nombres seleccionados, uno por línea (HEAD = rama actual). */
  function copyBranchNames() {
    let names = selectedRefs().map(r => r.name);
    if (!names.length && selectedTreeKeys.has('HEAD') && data) {
      names = [...new Set(data.repos.filter(r => r.included).map(r => r.head.branch || r.head.hash.replace(/^\d+:/, '').slice(0, 8)))];
    }
    copyText(names.join('\n'));
  }

  function tagMenu(t, fromTree = false) {
    const act = action => () => post('tagAction', { action, name: t.name, repos: t.repos });
    const sc = id => (fromTree ? `branches.${id}` : undefined);
    return [
      { label: 'Push Tag', sc: sc('pushTag'), act: act('push') },
      { label: 'Copy Tag Name', sc: sc('copyName'), act: () => copyText(t.name) },
      { sep: true },
      { label: 'Delete Tag', sc: sc('deleteTag'), act: act('delete') },
    ];
  }

  /** Quita elementos falsy y separadores sobrantes. */
  function clean(items) {
    const out = [];
    for (const it of items) {
      if (!it) { continue; }
      if (it.sep && (!out.length || out[out.length - 1].sep)) { continue; }
      out.push(it);
    }
    while (out.length && out[out.length - 1].sep) { out.pop(); }
    return out;
  }

  const menuRoot = $('#menu-root');
  /** @type {HTMLElement[]} */
  let menus = [];

  function closeMenus(fromLevel = 0) {
    while (menus.length > fromLevel) { menus.pop().remove(); }
  }

  /** opts.search: texto de ayuda del buscador que filtra el menú mientras se escribe. */
  // ----- atajos de teclado configurables (Settings ▸ Keyboard Shortcuts) -------------
  //
  // Cada acción de un menú contextual puede llevar `sc` (id de este registro). Con el foco
  // en esa vista, el atajo ejecuta el mismo elemento del menú que saldría con el clic
  // derecho sobre la selección actual (y no hace nada si está desactivado), y el menú
  // muestra el atajo al lado. jbGit.shortcuts guarda solo lo que cambia el usuario
  // (id → combinación, o '' para quitar uno por defecto).

  const SHORTCUT_SCOPES = { log: 'Log', branches: 'Branches', commitFiles: 'Commit Details (files)', changes: 'Local Changes', stash: 'Stash', stashFiles: 'Stash Files' };
  /** [id, nombre, atajo por defecto] */
  const SHORTCUT_ACTIONS = [
    ['log.copyHash', 'Copy Revision Number(s)', 'Ctrl+C'],
    ['log.createPatch', 'Create Patch…'],
    ['log.cherryPick', 'Cherry-Pick'],
    ['log.checkout', 'Checkout Revision'],
    ['log.compareWithLocal', 'Compare with Local'],
    ['log.compareVersions', 'Compare Versions (two commits)'],
    ['log.reset', 'Reset Current Branch to Here…'],
    ['log.revert', 'Revert Commit'],
    ['log.undoCommit', 'Undo Commit…'],
    ['log.squash', 'Squash Commits…'],
    ['log.fixup', 'Fixup Commits'],
    ['log.drop', 'Drop Commit(s)…'],
    ['log.newBranch', 'New Branch…'],
    ['log.newTag', 'New Tag…'],
    ['branches.checkout', 'Checkout'],
    ['branches.newBranchFrom', 'New Branch from…'],
    ['branches.favorite', 'Mark / Unmark as Favorite'],
    ['branches.checkoutAndRebase', 'Checkout and Rebase onto Current'],
    ['branches.compare', 'Compare with Current / Compare Two Branches'],
    ['branches.diffWorkingTree', 'Show Diff with Working Tree'],
    ['branches.rebaseOnto', 'Rebase Current onto Branch'],
    ['branches.merge', 'Merge into Current'],
    ['branches.update', 'Update'],
    ['branches.push', 'Push…'],
    ['branches.rename', 'Rename…', 'F2'],
    ['branches.delete', 'Delete', 'Delete'],
    ['branches.copyName', 'Copy Branch / Tag Name(s)', 'Ctrl+C'],
    ['branches.pushTag', 'Push Tag'],
    ['branches.deleteTag', 'Delete Tag'],
    ['commitFiles.showDiff', 'Show Diff'],
    ['commitFiles.openRepoVersion', 'Open Repository Version'],
    ['commitFiles.showHistory', 'Show History'],
    ['commitFiles.copyPath', 'Copy Path', 'Ctrl+Shift+C'],
    ['changes.showDiff', 'Show Diff'],
    ['changes.merge', 'Merge… (conflict)'],
    ['changes.acceptYours', 'Accept Yours'],
    ['changes.acceptTheirs', 'Accept Theirs'],
    ['changes.openFile', 'Open File'],
    ['changes.showHistory', 'Show History'],
    ['changes.stage', 'Stage / Add to VCS / Mark as Resolved'],
    ['changes.unstage', 'Unstage'],
    ['changes.rollback', 'Rollback…'],
    ['changes.delete', 'Delete (unversioned)…', 'Delete'],
    ['changes.gitignore', 'Add to .gitignore'],
    ['changes.exclude', 'Add to .git/info/exclude'],
    ['changes.copyPath', 'Copy Path(s)', 'Ctrl+Shift+C'],
    ['stash.pop', 'Pop'],
    ['stash.apply', 'Apply'],
    ['stash.drop', 'Drop…', 'Delete'],
    ['stash.copyMessage', 'Copy Message', 'Ctrl+C'],
    ['stash.clear', 'Clear All Stashes…'],
    ['stashFiles.showDiff', 'Show Diff'],
    ['stashFiles.copyPath', 'Copy Path', 'Ctrl+Shift+C'],
  ];
  const SHORTCUT_DEFAULTS = Object.fromEntries(SHORTCUT_ACTIONS.map(([id, , k]) => [id, k || '']));
  const IS_MAC = /Mac/i.test(navigator.platform);
  /** Teclas que ya usan las listas y los árboles (navegación, selección, menú): no se pueden asignar. */
  const RESERVED_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Tab', 'Shift+Tab', 'Escape', 'Enter',
    'Shift+ArrowUp', 'Shift+ArrowDown', 'Shift+Home', 'Shift+End', 'Shift+PageUp', 'Shift+PageDown', 'Ctrl+A', 'Shift+F10', 'ContextMenu', 'Space', 'Ctrl+Enter']);
  /** Atajos globales de VS Code: el webview también se los pasa a VS Code, así que harían las dos cosas. */
  const VSCODE_KEYS = new Set(['Ctrl+P', 'Ctrl+Shift+P', 'F1', 'Ctrl+B', 'Ctrl+J', 'Ctrl+`', 'Ctrl+W', 'Ctrl+N', 'Ctrl+O', 'Ctrl+S', 'Ctrl+Shift+E', 'Ctrl+Shift+F',
    'Ctrl+Shift+G', 'Ctrl+Shift+D', 'Ctrl+Shift+X', 'Ctrl+Shift+N', 'Ctrl+Shift+W', 'Ctrl+,', 'Ctrl+K', 'Ctrl+Tab', 'Ctrl+Q', 'Ctrl+R', 'F5', 'Ctrl+F', 'Ctrl+Z', 'Ctrl+Y',
    'Ctrl+Shift+Z', 'Ctrl+V', 'Ctrl+X', 'Ctrl+G', 'Ctrl+Shift+M', 'Ctrl+Shift+U', 'Ctrl+Shift+Y', 'F11', 'Alt+9']);

  /** Combinación de una pulsación, como «Ctrl+Shift+C» (Cmd cuenta como Ctrl), o '' si solo es un modificador. */
  function eventKey(e) {
    if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Dead', 'Unidentified'].includes(e.key)) { return ''; }
    const c = e.code || '';
    let k = c.startsWith('Key') ? c.slice(3) : c.startsWith('Digit') ? c.slice(5) : /^F\d{1,2}$/.test(e.key) ? e.key
      : e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key;
    if (k === 'Backquote') { k = '`'; }
    const mods = [(e.ctrlKey || e.metaKey) && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
    return [...mods, k].join('+');
  }
  /** Para mostrar: en macOS, ⌘ / ⌥ / ⇧. */
  function keyLabel(k) {
    if (!k) { return ''; }
    return IS_MAC ? k.replace(/Ctrl\+/g, '⌘').replace(/Alt\+/g, '⌥').replace(/Shift\+/g, '⇧') : k;
  }
  function shortcutOf(id) {
    const user = (settings && settings.shortcuts) || {};
    return id in user ? user[id] : (SHORTCUT_DEFAULTS[id] || '');
  }
  /**
   * Si la pulsación es el atajo de una acción de esta vista, ejecuta su elemento en el
   * menú de la selección actual (items(): ese menú) y devuelve true.
   */
  function runShortcut(e, scope, items) {
    const k = eventKey(e);
    if (!k || RESERVED_KEYS.has(k)) { return false; }
    const ids = SHORTCUT_ACTIONS.map(([id]) => id).filter(id => id.startsWith(scope + '.') && shortcutOf(id) === k);
    if (!ids.length) { return false; }
    e.preventDefault();
    e.stopPropagation();
    const it = (items() || []).find(x => x && ids.includes(x.sc));
    if (it && !it.disabled && it.act) { it.act(); }
    return true;
  }

  /**
   * Clic en un elemento de un grupo marcable (it.multi: la función del grupo; it.value: el valor de
   * la opción). El menú no se cierra (solo al pinchar fuera o con Esc). Clic marca o desmarca esta
   * opción; Ctrl/Cmd+clic deja marcada solo esta. El grupo recibe de una vez los valores marcados.
   * rows: las filas del menú ({ it, mi }); idx: la de este elemento.
   */
  function toggleMultiItem(it, idx, rows, e) {
    const only = e.ctrlKey || e.metaKey;
    const group = rows.filter(r => r.it.multi === it.multi);
    if (only) { group.forEach(r => { r.it.checked = r.it === it; }); } else { it.checked = !it.checked; }
    for (const r of only ? group : [rows[idx]]) {
      r.mi.setAttribute('aria-checked', String(r.it.checked));
      const c = r.mi.querySelector('.mi-check');
      if (c) { c.innerHTML = r.it.checked ? ICON.check : ''; }
    }
    it.multi(group.filter(r => r.it.checked).map(r => r.it.value));
  }

  function showMenu(items, x, y, opts = {}) {
    closeMenus();
    openMenu(items, x, y, 0, null, opts);
    const search = menus[0].querySelector('.menu-search');
    (search || menus[0]).focus();
  }

  function openMenu(items, x, y, level, anchor, opts = {}) {
    closeMenus(level);
    const el = document.createElement('div');
    el.className = 'menu' + (opts.search ? ' searchable' : '');
    el.tabIndex = -1;
    el.setAttribute('role', 'menu');
    let active = -1;
    const rows = [];
    const blocks = [];  // cabeceras, separadores y elementos en orden, para el buscador

    let searchEl = null;
    if (opts.search) {
      searchEl = document.createElement('input');
      searchEl.type = 'text';
      searchEl.className = 'menu-search';
      searchEl.placeholder = opts.search;
      searchEl.spellcheck = false;
      searchEl.addEventListener('input', () => filterRows(searchEl.value));
      el.appendChild(searchEl);
    }

    items.forEach((it, i) => {
      if (it.header) {
        const h = document.createElement('div');
        h.className = 'mi-header';
        h.textContent = it.header;
        el.appendChild(h);
        blocks.push({ kind: 'header', el: h });
        return;
      }
      if (it.sep) {
        const s = document.createElement('div');
        s.className = 'mi-sep';
        el.appendChild(s);
        blocks.push({ kind: 'sep', el: s });
        return;
      }
      const mi = document.createElement('div');
      mi.className = 'mi' + (it.disabled ? ' disabled' : '');
      mi.setAttribute('role', 'checked' in it ? 'menuitemcheckbox' : 'menuitem');
      if ('checked' in it) { mi.setAttribute('aria-checked', String(!!it.checked)); }
      const check = 'checked' in it ? `<span class="mi-check">${it.checked ? ICON.check : ''}</span>` : '';
      const swatch = 'swatch' in it ? '<span class="mi-swatch"></span>' : '';
      const icon = it.icon ? `<span class="mi-icon">${it.icon}</span>` : '';
      const text = it.labelHtml ? `<span class="mi-text">${it.labelHtml}</span>` : it.color ? `<span class="mi-text">${esc(it.label)}</span>` : esc(it.label);
      mi.innerHTML = `<span class="mi-label">${check}${swatch}${icon}${text}</span>` +
        ((it.sc && shortcutOf(it.sc)) ? `<span class="mi-key">${esc(keyLabel(shortcutOf(it.sc)))}</span>` : it.key ? `<span class="mi-key">${esc(it.key)}</span>` : '') +
        (it.submenu ? `<span class="mi-arrow">${ICON.chevron}</span>` : '');
      // Muestra de color (CSSOM: la CSP no deja usar style="")
      const sw = /** @type {HTMLElement | null} */ (mi.querySelector('.mi-swatch'));
      if (sw) { sw.style.background = it.swatch || 'transparent'; sw.classList.toggle('no-color', !it.swatch); }
      // it.color: el icono y el texto de la opción en ese color (p. ej. los colores de los tags)
      if (it.color) { for (const el of mi.querySelectorAll('.mi-icon, .mi-text')) { /** @type {HTMLElement} */ (el).style.color = it.color; } }
      // labelHtml: texto con partes de colores (data-c), p. ej. el nombre de una paleta
      for (const el of mi.querySelectorAll('[data-c]')) { /** @type {HTMLElement} */ (el).style.color = /** @type {HTMLElement} */ (el).dataset.c || ''; }
      const idx = rows.length;
      rows.push({ it, mi });
      blocks.push({ kind: 'item', el: mi, idx });
      mi.addEventListener('mouseenter', () => { setActive(idx); if (it.submenu) { openSub(idx); } else { closeMenus(level + 1); } });
      mi.addEventListener('click', e => {
        e.stopPropagation();
        if (it.disabled) { return; }
        if (it.submenu) { openSub(idx); return; }
        if (it.multi) { toggleMultiItem(it, idx, rows, e); return; }
        closeMenus();
        it.act && it.act();
      });
      el.appendChild(mi);
    });

    function setActive(i) {
      if (active >= 0) { rows[active].mi.classList.remove('active'); }
      active = i;
      if (active >= 0) {
        rows[active].mi.classList.add('active');
        rows[active].mi.scrollIntoView({ block: 'nearest' });
      }
    }
    /** Buscador: oculta lo que no coincide, y las cabeceras y separadores que se quedan vacíos. */
    let emptyEl = null;
    function filterRows(q) {
      q = q.trim().toLowerCase();
      for (const r of rows) {
        const text = `${r.it.label} ${r.it.key || ''}`.toLowerCase();
        r.mi.classList.toggle('hidden', !!q && !text.includes(q));
      }
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (b.kind === 'item') { continue; }
        let any = false;
        for (let j = i + 1; j < blocks.length && blocks[j].kind === 'item'; j++) {
          if (!blocks[j].el.classList.contains('hidden')) { any = true; break; }
        }
        b.el.classList.toggle('hidden', b.kind === 'sep' ? !!q : !any);
      }
      const visible = rows.filter(r => !r.mi.classList.contains('hidden'));
      if (!emptyEl) { emptyEl = document.createElement('div'); emptyEl.className = 'mi-empty'; emptyEl.textContent = 'No matches'; el.appendChild(emptyEl); }
      emptyEl.classList.toggle('hidden', visible.length > 0);
      setActive(visible.length && q ? rows.indexOf(visible[0]) : -1);
    }
    function openSub(i) {
      const r = rows[i];
      if (r.it.disabled || !r.it.submenu) { return; }
      const rect = r.mi.getBoundingClientRect();
      openMenu(r.it.submenu, rect.right + 2, rect.top - 5, level + 1, el);
    }
    function move(d) {
      if (!rows.length) { return; }
      let i = active;
      for (let n = 0; n < rows.length; n++) {
        i = (i + d + rows.length) % rows.length;
        if (!rows[i].it.disabled && !rows[i].mi.classList.contains('hidden')) { break; }
      }
      setActive(i);
    }

    el.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'ArrowRight' && active >= 0 && rows[active].it.submenu && e.target !== searchEl) {
        e.preventDefault(); openSub(active); const sub = menus[level + 1]; if (sub) { sub.focus(); sub.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })); }
      }
      else if (e.key === 'ArrowLeft' && level > 0) { e.preventDefault(); closeMenus(level); anchor && anchor.focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeMenus(); listEl.focus(); }
      else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); rows[active].mi.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: e.ctrlKey, metaKey: e.metaKey })); }
    });

    menuRoot.appendChild(el);
    menus.push(el);

    // Mantener dentro de la ventana
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x;
    let top = y;
    if (left + r.width > vw - 4) {
      // Submenú: al otro lado del menú padre si cabe; si no cabe en ninguno, pegado al borde
      const other = level > 0 && anchor ? anchor.getBoundingClientRect().left - r.width - 2 : -1;
      left = other >= 4 ? other : vw - r.width - 4;
    }
    if (top + r.height > vh - 4) { top = Math.max(4, vh - r.height - 4); }
    el.style.left = `${Math.max(4, left)}px`;
    el.style.top = `${Math.max(4, top)}px`;
  }

  document.addEventListener('mousedown', e => {
    if (!(/** @type {HTMLElement} */ (e.target).closest('.menu'))) { closeMenus(); }
  });
  window.addEventListener('blur', () => closeMenus());
  window.addEventListener('resize', () => closeMenus());
  // Evitar el menú nativo del webview fuera de nuestras zonas
  document.addEventListener('contextmenu', e => {
    if (!(/** @type {HTMLElement} */ (e.target).closest('input, #commit-info'))) { e.preventDefault(); }
  });

  // -------------------------------------------------------------------------
  // Pestañas: Log y Local Changes
  // -------------------------------------------------------------------------

  const tabsEl = $('#tabs');
  function switchTab(tab) {
    ui.tab = tab;
    saveUi();
    tabsEl.querySelectorAll('.tab').forEach(t => {
      const on = /** @type {HTMLElement} */ (t).dataset.tab === tab;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', String(on));
    });
    for (const v of TAB_IDS) { $('#view-' + v).classList.toggle('hidden', tab !== v); }
    closeMenus();
    renderActionBar(tab);
    // Settings no tiene barra de acciones
    actionsEl.classList.toggle('hidden', tab === 'settings');
    if (tab === 'log') {
      // Lo que se cambió con el log oculto (desde Settings) y necesita medidas
      applyRepoColumn();
      if (pendingCenter) { centerOn(pendingCenter); } else { renderRows(true); }
    }
    // El mínimo de la lista se mide (fuente): solo se puede con la pestaña visible
    if (tab === 'changes') { applyChangesWidth(); }
    if (tab === 'settings') { renderSettings(); }
  }
  tabsEl.addEventListener('click', e => {
    const t = /** @type {HTMLElement} */ (e.target).closest('.tab');
    if (t) { switchTab(/** @type {HTMLElement} */ (t).dataset.tab); }
  });

  // ----- orden de las pestañas (arrastrar, o clic derecho) -------------------------

  /** Pestañas que existen en el HTML, en su orden por defecto. */
  const TAB_IDS = [...tabsEl.querySelectorAll('.tab')].map(t => /** @type {HTMLElement} */ (t).dataset.tab);
  // Orden guardado, sin las que ya no existan y con las nuevas al final
  ui.tabOrder = [...ui.tabOrder.filter(id => TAB_IDS.includes(id)), ...TAB_IDS.filter(id => !ui.tabOrder.includes(id))];
  if (!TAB_IDS.includes(ui.tab)) { ui.tab = ui.tabOrder[0]; }

  function applyTabOrder() {
    for (const id of ui.tabOrder) { tabsEl.appendChild(tabsEl.querySelector(`.tab[data-tab="${id}"]`)); }
  }
  function moveTab(id, toIndex) {
    const order = ui.tabOrder.filter(x => x !== id);
    order.splice(Math.max(0, Math.min(order.length, toIndex)), 0, id);
    ui.tabOrder = order;
    applyTabOrder();
    saveUi();
  }

  let dragTab = null;
  const clearDrop = () => tabsEl.querySelectorAll('.drop-before, .drop-after').forEach(t => t.classList.remove('drop-before', 'drop-after'));
  tabsEl.querySelectorAll('.tab').forEach(t => t.setAttribute('draggable', 'true'));
  tabsEl.addEventListener('dragstart', e => {
    const t = /** @type {HTMLElement} */ (e.target).closest('.tab');
    if (!t) { return; }
    dragTab = t.dataset.tab;
    t.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragTab);
  });
  /** Pestaña sobre la que se soltaría y si va delante o detrás, según la mitad del ratón. */
  const dropTarget = e => {
    const t = /** @type {HTMLElement} */ (e.target).closest('.tab');
    if (!t || !dragTab) { return null; }
    const r = t.getBoundingClientRect();
    return { t, before: e.clientX < r.left + r.width / 2 };
  };
  tabsEl.addEventListener('dragover', e => {
    if (!dragTab) { return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearDrop();
    const d = dropTarget(e);
    if (d && d.t.dataset.tab !== dragTab) { d.t.classList.add(d.before ? 'drop-before' : 'drop-after'); }
  });
  tabsEl.addEventListener('drop', e => {
    if (!dragTab) { return; }
    e.preventDefault();
    const d = dropTarget(e);
    if (d && d.t.dataset.tab !== dragTab) {
      const rest = ui.tabOrder.filter(x => x !== dragTab);
      const i = rest.indexOf(d.t.dataset.tab);
      moveTab(dragTab, d.before ? i : i + 1);
    }
    clearDrop();
  });
  tabsEl.addEventListener('dragleave', e => { if (!tabsEl.contains(/** @type {Node} */ (e.relatedTarget))) { clearDrop(); } });
  tabsEl.addEventListener('dragend', () => {
    tabsEl.querySelectorAll('.dragging').forEach(t => t.classList.remove('dragging'));
    clearDrop();
    dragTab = null;
  });
  tabsEl.addEventListener('contextmenu', e => {
    const t = /** @type {HTMLElement} */ (e.target).closest('.tab');
    if (!t) { return; }
    e.preventDefault();
    const id = t.dataset.tab;
    const i = ui.tabOrder.indexOf(id);
    showMenu([
      { label: 'Move Left', disabled: i === 0, act: () => moveTab(id, i - 1) },
      { label: 'Move Right', disabled: i === ui.tabOrder.length - 1, act: () => moveTab(id, i + 1) },
      { sep: true },
      { label: 'Reset Tab Order', act: () => { ui.tabOrder = [...TAB_IDS]; applyTabOrder(); saveUi(); } },
      { label: 'Reset Panel Sizes', act: resetPanelSizes },
    ], e.clientX, e.clientY);
  });
  applyTabOrder();

  // -------------------------------------------------------------------------
  // Local Changes: cambios sin commitear agrupados como en JetBrains
  // -------------------------------------------------------------------------

  /** @type {any} */
  let changes = null;          // último mensaje 'changes'
  let chSel = new Set();       // claves "grupo:ruta" seleccionadas
  let chAnchor = null;         // última clave clicada, para Shift+clic
  const changesTreeEl = $('#changes-tree');
  const commitBoxEl = $('#commit-box');
  const commitMsg = /** @type {HTMLTextAreaElement} */ ($('#commit-msg'));
  const commitAmend = /** @type {HTMLInputElement} */ ($('#commit-amend'));
  const GROUPS = [
    { id: 'conflicts', label: 'Merge Conflicts' },
    { id: 'staged', label: 'Staged' },
    { id: 'unstaged', label: 'Changes' },
    { id: 'untracked', label: 'Unversioned Files' },
  ];
  const STATUS_NAME = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Conflict', '?': 'Unversioned' };
  const stClass = st => 'st-' + (st === '?' ? 'Q' : st);
  const chKey = c => `${c.repo}:${c.group}:${c.path}`;


  function onChanges(m) {
    changes = m;
    renderOpBar();
    const keys = new Set(m.files.map(chKey));
    chSel = new Set([...chSel].filter(k => keys.has(k)));
    renderChanges(true);
  }

  function selectedChanges() {
    return changes ? changes.files.filter(c => chSel.has(chKey(c))) : [];
  }

  /** forcePreview: los cambios se han refrescado, así que el diff mostrado puede haber cambiado. */
  /** Fila de un archivo cambiado. showDir: mostrar su carpeta en gris (lista plana). */
  function changeRow(c, depth, showDir) {
    const k = chKey(c);
    const slash = c.path.lastIndexOf('/');
    const hint = c.oldPath ? `← ${c.oldPath}` : showDir && slash >= 0 ? c.path.slice(0, slash) : '';
    return `<div class="tnode${chSel.has(k) ? ' selected' : ''}" data-ck="${esc(k)}" data-pad="${6 + depth * 14}" title="${esc(c.path)} — ${STATUS_NAME[c.status] || c.status}">` +
      `<span class="twisty"></span><span class="${stClass(c.status)}">${ICON.file}</span><span class="label ${stClass(c.status)}">${esc(c.path.slice(slash + 1))}</span>${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</div>`;
  }

  function renderChanges(forcePreview) {
    const files = changes ? changes.files : [];
    const count = new Set(files.map(c => c.path)).size;
    const countEl = $('#changes-count');
    countEl.textContent = count ? String(count) : '';
    countEl.classList.toggle('hidden', !count);

    let html = '';
    changesFolders = new Map();
    // Si falla un repo se avisa, pero se siguen mostrando los cambios de los demás
    if (changes && changes.error) {
      html = `<div class="empty error">${esc(changes.error)}</div>`;
    }
    if (!files.length && !(changes && changes.error)) {
      html = `<div class="empty">${changes ? 'No local changes.' : ''}</div>`;
    }
    for (const g of GROUPS) {
      const list = files.filter(c => c.group === g.id).sort((a, b) => a.path.localeCompare(b.path));
      if (!list.length) { continue; }
      const open = !ui.expanded.has('chg-closed:' + g.id);
      html += `<div class="tnode group" data-group="${g.id}" data-pad="6">${twisty(open)}<span class="label">${g.label}</span><span class="hint">${list.length} file${list.length === 1 ? '' : 's'}</span></div>`;
      if (!open) { continue; }
      html += fileTreeRows(list, 1, `chg:${g.id}:`, ui.changesGroupBy, changeRow, changesFolders, !!(data && data.multi));
    }
    changesTreeEl.innerHTML = html;
    applyPositions(changesTreeEl);
    updateActionBar();
    updateCommitButtons();
    updatePreview(forcePreview === true);
  }

  /**
   * Botones de la barra izquierda en Local Changes. Si hay archivos seleccionados
   * actúan solo sobre ellos; si no, sobre todos los cambios.
   */
  function changeTargets() {
    const sel = selectedChanges();
    return { sel, list: sel.length ? sel : (changes ? changes.files : []) };
  }
  function changesActionState(act) {
    const { sel, list } = changeTargets();
    const scope = (items, verb) => !items.length ? verb
      : sel.length ? `${verb} ${items.length === 1 ? `'${items[0].path}'` : `${items.length} Selected Files`}`
      : `${verb} All`;
    switch (act) {
      case 'chRefresh': return { title: 'Refresh', on: true, msg: { type: 'refresh' } };
      case 'chView': return { title: 'View Options', on: true, run: () => openViewMenu('changes', 'chView') };
      case 'chStage': {
        const items = list.filter(c => c.group !== 'staged');
        return { title: scope(items, 'Stage'), on: items.length > 0, run: () => changeAction('stage', items) };
      }
      case 'chUnstage': {
        const items = list.filter(c => c.group === 'staged');
        return { title: scope(items, 'Unstage'), on: items.length > 0, run: () => changeAction('unstage', items) };
      }
      case 'chRollback': {
        const items = list.filter(c => c.group === 'staged' || c.group === 'unstaged');
        return { title: scope(items, 'Rollback') + '…', on: items.length > 0, run: () => changeAction('rollback', items) };
      }
      // Con selección guarda solo esos archivos; sin ella, todos (también los sin seguimiento)
      case 'chStash':
        return {
          title: sel.length ? scope(sel, 'Stash') + '…' : 'Stash All Changes…',
          on: list.length > 0,
          msg: { type: 'repoAction', action: 'stash', changes: sel },
        };
    }
    return { title: act, on: false };
  }

  // ----- vista previa del archivo seleccionado ------------------------------------

  const previewTitleEl = $('#preview-title');
  const previewBodyEl = $('#preview-body');
  const PREVIEW_MAX_LINES = 5000;
  let previewKey = null;   // cambio que se está mostrando
  /** @type {any} */
  let preview = null;      // último mensaje 'changePreview' de previewKey

  /** El archivo a mostrar: el último clicado si está seleccionado, o el único seleccionado. */
  function previewTarget() {
    const sel = selectedChanges();
    if (!sel.length) { return { change: null, count: 0 }; }
    const c = sel.find(x => chKey(x) === chAnchor) || (sel.length === 1 ? sel[0] : null);
    return { change: c, count: sel.length };
  }

  /** force: volver a pedir el diff aunque sea el mismo archivo (los cambios se han refrescado). */
  function updatePreview(force) {
    const { change, count } = previewTarget();
    const key = change ? chKey(change) : null;
    if (key !== previewKey || force) {
      if (key !== previewKey) { preview = null; }
      previewKey = key;
      if (change) { vscode.postMessage({ type: 'previewChange', change }); }
    }
    renderPreview(change, count);
  }

  function onChangePreview(m) {
    if (m.key !== previewKey) { return; }
    preview = m;
    renderPreview(previewTarget().change, selectedChanges().length);
  }

  /** Fila del diff. blk: índice del bloque al que pertenece; btn: si lleva el botón de rollback. */
  /**
   * Botones del primer renglón de cada bloque: rollback y, en Changes / Staged, stage o
   * unstage de solo ese bloque (blkStage: 'stage', 'unstage' o '').
   */
  let blkStage = '';
  const blkButtons = blk =>
    (blkStage ? `<button class="blk-btn" data-blk="${blk}" data-blk-act="${blkStage}" title="${blkStage === 'stage' ? 'Stage this change' : 'Unstage this change'}" aria-label="${blkStage === 'stage' ? 'Stage this change' : 'Unstage this change'}">${blkStage === 'stage' ? ICON.plus : ICON.minus}</button>` : '') +
    `<button class="blk-btn" data-blk="${blk}" data-blk-act="rollback" title="Rollback this change" aria-label="Rollback this change">${ICON.undo}</button>`;
  const dl = (cls, o, n, code, blk = -1, btn = false, html = null) =>
    `<div class="dl ${cls}"${blk >= 0 ? ` data-blk="${blk}"` : ''}><span class="ln">${o}</span><span class="ln">${n}</span>` +
    `<span class="rb">${btn ? blkButtons(blk) : ''}</span>` +
    `<span class="code">${html ?? (esc(code) || ' ')}</span></div>`;
  let previewBlocks = [];

  /**
   * Resalta lo que cambia entre una línea borrada y su añadida (lo que queda entre el prefijo
   * y el sufijo comunes), como el visor de comparación y JetBrains. Si apenas se parecen
   * (lo común es menos del 40 % de la línea), no se resalta nada: toda la línea ha cambiado.
   * Devuelve [html antiguo, html nuevo] o null.
   */
  function intraLine(a, b) {
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) { p++; }
    let s = 0;
    while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) { s++; }
    const longest = Math.max(a.length, b.length);
    if (!longest || (p + s) / longest < 0.4 || (p === a.length && p === b.length)) { return null; }
    const mark = t => {
      const mid = t.slice(p, t.length - s);
      return esc(t.slice(0, p)) + (mid ? `<span class="ch">${esc(mid)}</span>` : '') + esc(t.slice(t.length - s));
    };
    return [mark(a), mark(b)];
  }  // líneas «-»/«+» de cada bloque, para que la extensión compruebe que no ha cambiado

  /**
   * Diff unificado de git → filas con número de línea antiguo y nuevo. Cada racha de
   * líneas «-»/«+» es un bloque con su botón de rollback (misma numeración que
   * parseDiffBlocks en git.ts). canRollback: false para archivos borrados.
   */
  function diffRows(text, canRollback) {
    const out = [];
    let o = 0, n = 0, inHunk = false, header = '', inBlock = false;
    previewBlocks = [];
    // Las líneas de un bloque se guardan hasta que termina, para emparejar cada «-» con su
    // «+» y resaltar lo que cambia dentro de la línea
    let pend = [];
    const flush = () => {
      const dels = pend.filter(x => x.t === '-'), adds = pend.filter(x => x.t === '+');
      for (let i = 0; i < Math.min(dels.length, adds.length); i++) {
        const h = intraLine(dels[i].code, adds[i].code);
        if (h) { dels[i].html = h[0]; adds[i].html = h[1]; }
      }
      for (const x of pend) {
        out.push(x.t === '+' ? dl('add', '', x.n, x.code, x.k, x.btn, x.html) : dl('del', x.o, '', x.code, x.k, x.btn, x.html));
      }
      pend = [];
    };
    for (const l of text.split('\n')) {
      if (out.length + pend.length >= PREVIEW_MAX_LINES) {
        // Corte a mitad de un bloque: sin sus botones, porque sus líneas están incompletas y la
        // extensión rechazaría el rollback o el stage («The file has changed…»)
        if (inBlock) { for (const x of pend) { x.btn = false; } }
        break;
      }
      if (l.startsWith('@@')) {
        flush();
        const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l);
        if (m) { o = Number(m[1]); n = Number(m[2]); }
        // Sin la cabecera técnica de git: solo un separador entre bloques (las líneas
        // intermedias sin cambios no se muestran)
        if (inHunk || out.length) { out.push('<div class="dl gap" aria-hidden="true"></div>'); }
        inHunk = true;
        inBlock = false;
        continue;
      }
      if (!inHunk) { header += l + '\n'; continue; }
      if (l.startsWith('\\')) { continue; } // «\ No newline at end of file»: aviso de git que no se muestra
      const t = l[0], code = l.slice(1);
      if (t === '+' || t === '-') {
        const start = !inBlock;
        if (start) { previewBlocks.push([]); inBlock = true; }
        const k = previewBlocks.length - 1;
        previewBlocks[k].push(l);
        pend.push(t === '+' ? { t, n: n++, code, k, btn: start && canRollback, html: null } : { t, o: o++, code, k, btn: start && canRollback, html: null });
      }
      else if (t === ' ') { flush(); inBlock = false; out.push(dl('', o++, n++, code)); }
      else if (l.startsWith('diff --git')) { flush(); inHunk = false; inBlock = false; header = l + '\n'; }
    }
    flush();
    if (!out.length) {
      const msg = /^Binary files/m.test(header) ? 'Binary file changed.'
        : /^rename from/m.test(header) ? 'Renamed without content changes.'
        : /^(old|new) mode/m.test(header) ? 'Only the file mode changed.'
        : 'No content changes.';
      return `<div class="empty">${msg}</div>`;
    }
    return out.join('');
  }

  /** Archivo completo: todo añadido (sin seguimiento) o con marcadores de conflicto resaltados. */
  function fileRows(text, conflict) {
    const lines = text.split('\n');
    if (lines.length && lines[lines.length - 1] === '') { lines.pop(); }
    return lines.slice(0, PREVIEW_MAX_LINES).map((l, i) => {
      const marker = conflict && /^(<{7}|={7}|>{7}|\|{7})( |$)/.test(l);
      return dl(conflict ? (marker ? 'conflict' : '') : 'add', '', i + 1, l);
    }).join('');
  }

  function renderPreview(change, count) {
    previewTitleEl.textContent = change ? change.path : count > 1 ? `${count} files selected` : '';
    let html;
    if (!change) {
      html = `<div class="empty">${count > 1 ? 'Select a single file to see its changes.' : changes && changes.files.length ? 'Select a file to see its changes.' : ''}</div>`;
    } else if (!preview) {
      html = '<div class="empty">Loading…</div>';
    } else if (preview.error) {
      html = `<div class="empty error">${esc(preview.error)}</div>`;
    } else if (preview.binary) {
      html = '<div class="empty">Binary file.</div>';
    } else if (preview.directory) {
      html = `<div class="empty">${preview.directory === 'repo' ? 'Nested Git repository (a folder with its own .git).' : 'Directory.'}</div>`;
    } else {
      blkStage = preview.kind === 'diff' && change.status !== 'D' ? (change.group === 'unstaged' ? 'stage' : change.group === 'staged' ? 'unstage' : '') : '';
      html = `<div class="diff${blkStage ? ' two-btn' : ''}">${preview.kind === 'diff' ? diffRows(preview.text, change.status !== 'D') : fileRows(preview.text, change.group === 'conflicts')}</div>`;
      const lines = preview.text.split('\n').length;
      if (preview.truncated || lines > PREVIEW_MAX_LINES) {
        html += '<div class="empty">The preview is truncated. Double-click the file to open the full diff.</div>';
      }
    }
    // Conservar el scroll si se vuelve a pintar el mismo archivo (p. ej. tras guardar)
    const keep = previewBodyEl.dataset.key === (change ? chKey(change) : '');
    const top = previewBodyEl.scrollTop, left = previewBodyEl.scrollLeft;
    previewBodyEl.innerHTML = html;
    previewBodyEl.dataset.key = change ? chKey(change) : '';
    if (keep) { previewBodyEl.scrollTop = top; previewBodyEl.scrollLeft = left; }
  }

  // Botón de rollback de un bloque, y resaltado del bloque al pasar por encima
  previewBodyEl.addEventListener('click', e => {
    const b = /** @type {HTMLElement} */ (e.target).closest('.blk-btn');
    const { change } = previewTarget();
    if (!b || !change) { return; }
    const k = Number(b.getAttribute('data-blk'));
    const act = b.getAttribute('data-blk-act');
    vscode.postMessage({ type: act === 'rollback' ? 'rollbackBlock' : 'stageBlock', change, block: k, lines: previewBlocks[k] || [] });
  });
  const hoverBlock = (k, on) => previewBodyEl.querySelectorAll(`.dl[data-blk="${k}"]`).forEach(r => r.classList.toggle('blk-hover', on));
  previewBodyEl.addEventListener('mouseover', e => {
    const b = /** @type {HTMLElement} */ (e.target).closest('.blk-btn');
    if (b) { hoverBlock(b.getAttribute('data-blk'), true); }
  });
  previewBodyEl.addEventListener('mouseout', e => {
    const b = /** @type {HTMLElement} */ (e.target).closest('.blk-btn');
    if (b) { hoverBlock(b.getAttribute('data-blk'), false); }
  });

  const changeAction = (action, list) => vscode.postMessage({ type: 'changeAction', action, changes: list });
  // Un conflicto se abre en el editor de merge (como el «Merge…» de JetBrains); el resto, en un diff
  const openChange = c => (c.group === 'conflicts'
    ? changeAction('merge', [c])
    : vscode.postMessage({ type: 'openChange', change: c }));

  function selectChange(k, e) {
    const c = changes.files.find(x => chKey(x) === k);
    if (!c) { return; }
    if (e && (e.ctrlKey || e.metaKey)) {
      if (chSel.has(k)) { chSel.delete(k); } else { chSel.add(k); }
    } else if (e && e.shiftKey && chAnchor) {
      const keys = [...changesTreeEl.querySelectorAll('.tnode[data-ck]')].map(n => n.getAttribute('data-ck'));
      const a = keys.indexOf(chAnchor), b = keys.indexOf(k);
      if (a >= 0 && b >= 0) { chSel = new Set(keys.slice(Math.min(a, b), Math.max(a, b) + 1)); }
    } else {
      chSel = new Set([k]);
    }
    if (!(e && e.shiftKey)) { chAnchor = k; }
    renderChanges();
  }

  changesTreeEl.addEventListener('click', e => {
    const n = /** @type {HTMLElement} */ (e.target).closest('.tnode');
    if (!changes) { return; }
    // Clic en una zona vacía: sin selección, los botones vuelven a actuar sobre todo
    if (!n) { if (chSel.size) { chSel.clear(); renderChanges(); } return; }
    if (n.hasAttribute('data-fold')) { toggleFold(n.getAttribute('data-fold')); renderChanges(); return; }
    const g = n.getAttribute('data-group');
    if (g) {
      const key = 'chg-closed:' + g;
      if (ui.expanded.has(key)) { ui.expanded.delete(key); } else { ui.expanded.add(key); }
      saveUi();
      renderChanges();
      return;
    }
    selectChange(n.getAttribute('data-ck'), e);
  });
  changesTreeEl.addEventListener('dblclick', e => {
    const n = /** @type {HTMLElement} */ (e.target).closest('.tnode[data-ck]');
    const c = n && changes.files.find(x => chKey(x) === n.getAttribute('data-ck'));
    if (c) { openChange(c); }
  });
  changesTreeEl.addEventListener('keydown', e => {
    if (!changes) { return; }
    if (runShortcut(e, 'changes', () => (selectedChanges().length ? changeMenu(selectedChanges()) : []))) { return; }
    const keys = [...changesTreeEl.querySelectorAll('.tnode[data-ck]')].map(n => n.getAttribute('data-ck'));
    const cur = selectedChanges();
    // ↑/↓/←/→ los lleva keyNav (común a todos los árboles)
    if (e.key === 'Enter' && cur.length === 1) {
      openChange(cur[0]);
    } else if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      e.preventDefault();
      const el = changesTreeEl.querySelector('.tnode.selected');
      if (el && cur.length) { const r = el.getBoundingClientRect(); showMenu(changeMenu(cur), r.left + 40, r.bottom); }
    }
  });

  /** folder: { repo, dir } si el menú se abrió con clic derecho sobre una carpeta (Group By Directory). */
  function changeMenu(sel, folder) {
    const one = sel.length === 1;
    const n = items => (sel.length === 1 ? '' : ` (${items.length})`);
    const stageable = sel.filter(c => c.group !== 'staged');
    const unstageable = sel.filter(c => c.group === 'staged');
    const rollbackable = sel.filter(c => c.group === 'staged' || c.group === 'unstaged');
    const untracked = sel.filter(c => c.group === 'untracked');
    const stageLabel = stageable.every(c => c.group === 'untracked') ? 'Add to VCS'
      : stageable.every(c => c.group === 'conflicts') ? 'Mark as Resolved' : 'Stage';
    // Conflictos: resolverlos en el editor de merge o quedarse con un lado entero
    const conflicts = sel.filter(c => c.group === 'conflicts');
    const op = conflicts.length && data && data.repos[conflicts[0].repo] ? data.repos[conflicts[0].repo].op : null;
    const side = name => (op && conflicts.every(c => c.repo === conflicts[0].repo) ? ` ('${name}')` : '');
    return clean([
      one && conflicts.length === 1 && { label: 'Merge…', sc: 'changes.merge', key: 'Double-click', act: () => changeAction('merge', conflicts) },
      conflicts.length > 0 && { label: `Accept Yours${side(op && op.ours)}${n(conflicts)}`, sc: 'changes.acceptYours', act: () => changeAction('acceptOurs', conflicts) },
      conflicts.length > 0 && { label: `Accept Theirs${side(op && op.theirs)}${n(conflicts)}`, sc: 'changes.acceptTheirs', act: () => changeAction('acceptTheirs', conflicts) },
      conflicts.length > 0 && { sep: true },
      one && (sel[0].group === 'staged' || sel[0].group === 'unstaged') && { label: 'Show Diff', sc: 'changes.showDiff', key: 'Double-click', act: () => openChange(sel[0]) },
      { label: 'Open File', sc: 'changes.openFile', disabled: sel.every(c => c.status === 'D'), act: () => changeAction('open', sel.filter(c => c.status !== 'D')) },
      // Historial: de un archivo con seguimiento (uno nuevo no tiene), o de la carpeta pulsada
      !folder && one && sel[0].group !== 'untracked' && { label: 'Show History', sc: 'changes.showHistory', disabled: sel[0].status === 'A' && sel[0].group === 'staged', act: () => post('showHistory', { repo: sel[0].repo, path: sel[0].oldPath || sel[0].path, folder: false }) },
      folder && untracked.length !== sel.length && { label: 'Show History for Folder', sc: 'changes.showHistory', key: `${folder.dir}/`, act: () => post('showHistory', { repo: folder.repo, path: folder.dir, folder: true }) },
      { sep: true },
      stageable.length > 0 && { label: `${stageLabel}${n(stageable)}`, sc: 'changes.stage', act: () => changeAction('stage', stageable) },
      unstageable.length > 0 && { label: `Unstage${n(unstageable)}`, sc: 'changes.unstage', act: () => changeAction('unstage', unstageable) },
      rollbackable.length > 0 && { label: `Rollback${n(rollbackable)}…`, sc: 'changes.rollback', act: () => changeAction('rollback', rollbackable) },
      untracked.length === sel.length && { label: `Delete${n(untracked)}…`, sc: 'changes.delete', act: () => changeAction('delete', untracked) },
      untracked.length === sel.length && { sep: true },
      untracked.length === sel.length && !folder && { label: `Add to .gitignore${n(untracked)}`, sc: 'changes.gitignore', act: () => ignoreFiles(untracked, 'gitignore') },
      untracked.length === sel.length && !folder && { label: `Add to .git/info/exclude${n(untracked)}`, sc: 'changes.exclude', act: () => ignoreFiles(untracked, 'exclude') },
      // Sobre una carpeta se ignora la carpeta entera (también lo que se cree en ella después)
      untracked.length === sel.length && folder && { label: `Add Folder to .gitignore`, sc: 'changes.gitignore', key: `/${folder.dir}/`, act: () => ignoreFolder(folder.repo, folder.dir, 'gitignore') },
      untracked.length === sel.length && folder && { label: `Add Folder to .git/info/exclude`, sc: 'changes.exclude', key: `/${folder.dir}/`, act: () => ignoreFolder(folder.repo, folder.dir, 'exclude') },
      { sep: true },
      { label: one ? 'Copy Path' : 'Copy Paths', sc: 'changes.copyPath', act: () => navigator.clipboard.writeText(sel.map(c => c.path).join('\n')) },
    ]);
  }

  /** Escapa una ruta para usarla literalmente como patrón de .gitignore. */
  const ignoreEscape = p => p.replace(/[\\*?[\]!#]/g, c => '\\' + c).replace(/ $/, '\\ ');

  /** Añade los archivos (y solo esos) a .gitignore o a .git/info/exclude. */
  const ignoreFiles = (files, target) =>
    vscode.postMessage({ type: 'ignore', target, items: files.map(f => ({ repo: f.repo, pattern: '/' + ignoreEscape(f.path) })) });
  /** Añade una carpeta entera («/ruta/»). */
  const ignoreFolder = (repo, dir, target) =>
    vscode.postMessage({ type: 'ignore', target, items: [{ repo, pattern: '/' + ignoreEscape(dir) + '/' }] });

  function groupMenu(g) {
    const list = changes.files.filter(c => c.group === g);
    return clean([
      g === 'staged' && { label: 'Unstage All', act: () => changeAction('unstage', list) },
      g === 'staged' && { label: 'Rollback All…', act: () => changeAction('rollback', list) },
      g === 'unstaged' && { label: 'Stage All', act: () => changeAction('stage', list) },
      g === 'unstaged' && { label: 'Rollback All…', act: () => changeAction('rollback', list) },
      g === 'untracked' && { label: 'Add All to VCS', act: () => changeAction('stage', list) },
      g === 'untracked' && { label: 'Delete All…', act: () => changeAction('delete', list) },
      g === 'untracked' && { sep: true },
      g === 'untracked' && { label: 'Add All to .gitignore', act: () => ignoreFiles(list, 'gitignore') },
      g === 'untracked' && { label: 'Add All to .git/info/exclude', act: () => ignoreFiles(list, 'exclude') },
      g === 'conflicts' && { label: 'Mark All as Resolved', act: () => changeAction('stage', list) },
    ]);
  }

  changesTreeEl.addEventListener('contextmenu', e => {
    e.preventDefault();
    const n = /** @type {HTMLElement} */ (e.target).closest('.tnode');
    if (!n || !changes) { return; }
    const g = n.getAttribute('data-group');
    if (g) { showMenu(groupMenu(g), e.clientX, e.clientY); return; }
    // Clic derecho en una carpeta: selecciona todo lo que contiene, como en JetBrains
    const fold = n.getAttribute('data-fold');
    if (fold) {
      const inside = changesFolders.get(fold) || [];
      if (!inside.length) { return; }
      chSel = new Set(inside.map(chKey));
      renderChanges();
      const m = /^chg:[a-z]+:(?:r\d+:)?dir:(.+)$/.exec(fold);
      showMenu(changeMenu(selectedChanges(), m ? { repo: inside[0].repo, dir: m[1] } : undefined), e.clientX, e.clientY);
      return;
    }
    const k = n.getAttribute('data-ck');
    if (!chSel.has(k)) { selectChange(k, null); }
    showMenu(changeMenu(selectedChanges()), e.clientX, e.clientY);
  });

  // ----- caja de commit --------------------------------------------------------

  commitMsg.value = ui.commitDraft;
  function updateCommitButtons() {
    const has = !!changes && changes.files.length > 0;
    const ok = (has || commitAmend.checked) && (!!commitMsg.value.trim() || commitAmend.checked);
    /** @type {HTMLButtonElement} */ ($('#commit-btn')).disabled = !ok;
    /** @type {HTMLButtonElement} */ ($('#commit-push-btn')).disabled = !ok;
    $('#commit-btn').textContent = commitAmend.checked ? 'Amend Commit' : 'Commit';
    $('#commit-push-btn').textContent = commitAmend.checked ? 'Amend and Push…' : 'Commit and Push…';
  }
  commitMsg.addEventListener('input', () => {
    updateCommitButtons();
    // En cada tecla, sin esperar: si el Log cambia de sitio (o se cierra su pestaña) la página se
    // descarta enseguida y un guardado pendiente se perdería con las últimas letras
    ui.commitDraft = commitMsg.value;
    saveUi();
  });
  commitAmend.addEventListener('change', () => {
    // Como JetBrains: al marcar Amend se carga el mensaje del último commit
    const last = changes ? changes.lastMessage : '';
    if (commitAmend.checked && !commitMsg.value.trim()) { commitMsg.value = last; }
    else if (!commitAmend.checked && commitMsg.value === last) { commitMsg.value = ''; }
    ui.commitDraft = commitMsg.value;
    saveUi();
    updateCommitButtons();
  });
  const doCommit = push => {
    if (/** @type {HTMLButtonElement} */ ($('#commit-btn')).disabled) { return; }
    vscode.postMessage({ type: 'commit', message: commitMsg.value, amend: commitAmend.checked, push });
  };
  $('#commit-btn').addEventListener('click', () => doCommit(false));
  $('#commit-push-btn').addEventListener('click', () => doCommit(true));
  commitMsg.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doCommit(e.altKey); }
  });

  // -------------------------------------------------------------------------
  // Agrupación de archivos (ojo «View Options»), común a Local Changes y Stash
  // -------------------------------------------------------------------------

  /**
   * Filas de una lista de archivos según «Group By», como en JetBrains:
   * - repository: un nodo por repositorio (también con uno solo, como JetBrains);
   * - directory: árbol de carpetas, juntando en un nodo las cadenas de carpetas con una
   *   sola subcarpeta (src/main/java);
   * - sin ninguno: lista plana con la carpeta en gris.
   * fileRow(f, depth, showDir) pinta cada archivo; folders recibe, por clave de carpeta,
   * los archivos que contiene (para plegar y para el clic derecho).
   */
  function fileTreeRows(files, depth, prefix, groupBy, fileRow, folders, multi = false) {
    const plural = n => `${n} file${n === 1 ? '' : 's'}`;
    const folderRow = (key, icon, label, count, d) => {
      const open = !ui.expanded.has('closed:' + key);
      return { open, html: `<div class="tnode folder" data-fold="${esc(key)}" data-pad="${6 + d * 14}">${twisty(open)}` +
        `<span class="ico-folder">${icon}</span><span class="label">${esc(label)}</span><span class="hint">${plural(count)}</span></div>` };
    };
    const byName = (a, b) => a.path.localeCompare(b.path);
    let html = '';
    if (groupBy.repository || multi) {
      // Un nodo por repo; las claves de sus carpetas llevan «r<idx>:» para no mezclarse
      const ids = [...new Set(files.map(f => f.repo))].sort((a, b) => repoName(a).localeCompare(repoName(b)));
      for (const idx of ids) {
        const own = files.filter(f => f.repo === idx);
        const key = `${prefix}repo${idx}`;
        folders.set(key, own);
        const r = folderRow(key, ICON.repo, repoName(idx) || 'Repository', own.length, depth);
        html += r.html;
        if (r.open) { html += filesRows(own, depth + 1, `${prefix}r${idx}:`); }
      }
      return html;
    }
    return html + filesRows(files, depth, prefix);

    /** Archivos de un repo: en árbol de carpetas o en lista plana. */
    function filesRows(files, depth, prefix) {
    let html = '';
    if (!groupBy.directory) {
      for (const f of [...files].sort(byName)) { html += fileRow(f, depth, true); }
      return html;
    }
    const root = { dirs: new Map(), files: [] };
    for (const f of files) {
      let node = root;
      const parts = f.path.split('/');
      for (const p of parts.slice(0, -1)) {
        if (!node.dirs.has(p)) { node.dirs.set(p, { dirs: new Map(), files: [] }); }
        node = node.dirs.get(p);
      }
      node.files.push(f);
    }
    const all = n => [...n.files, ...[...n.dirs.values()].flatMap(all)];
    const walk = (node, d, base) => {
      for (const [name, child] of [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        let label = name, c = child, full = base ? `${base}/${name}` : name;
        while (!c.files.length && c.dirs.size === 1) {
          const [n2, c2] = [...c.dirs.entries()][0];
          label += '/' + n2; full += '/' + n2; c = c2;
        }
        const key = prefix + 'dir:' + full;
        const inside = all(c);
        folders.set(key, inside);
        const r = folderRow(key, ICON.folder, label, inside.length, d);
        html += r.html;
        if (r.open) { walk(c, d + 1, full); }
      }
      for (const f of [...node.files].sort(byName)) { html += fileRow(f, d, false); }
    };
    walk(root, depth, '');
    return html;
    }
  }

  /** Pliega o despliega una carpeta del árbol (clave data-fold). */
  function toggleFold(key) {
    if (ui.expanded.has('closed:' + key)) { ui.expanded.delete('closed:' + key); } else { ui.expanded.add('closed:' + key); }
    saveUi();
  }

  /** Menú del ojo: Group By (Directory / Repository) y desplegar o plegar todo. */
  function openViewMenu(which, act) {
    const gb = which === 'changes' ? ui.changesGroupBy : ui.stashGroupBy;
    const folders = which === 'changes' ? changesFolders : stashFolders;
    const rerender = () => { saveUi(); if (which === 'changes') { renderChanges(); } else { renderStashFiles(); } };
    const toggle = k => () => { gb[k] = !gb[k]; rerender(); };
    const items = [
      { label: 'Group By', submenu: [
        { label: 'Directory', checked: !!gb.directory, act: toggle('directory') },
        { label: 'Repository', checked: !!gb.repository, act: toggle('repository') },
      ] },
      { sep: true },
      { label: 'Expand All', act: () => { for (const k of [...ui.expanded]) { if (k.startsWith('closed:' + (which === 'changes' ? 'chg:' : 'stf:'))) { ui.expanded.delete(k); } } rerender(); } },
      { label: 'Collapse All', disabled: !folders.size, act: () => { for (const k of folders.keys()) { ui.expanded.add('closed:' + k); } rerender(); } },
    ];
    const b = actionsEl.querySelector(`[data-act="${act}"]`);
    const r = b ? b.getBoundingClientRect() : { right: 30, top: 40 };
    showMenu(items, r.right + 2, r.top);
  }

  let changesFolders = new Map();
  let stashFolders = new Map();

  // -------------------------------------------------------------------------
  // Pestaña Settings: ajustes de la extensión (jbGit.*, en la configuración de VS Code)
  // y las opciones de vista del webview (las mismas que los ojos de cada pestaña)
  // -------------------------------------------------------------------------

  // ----- operaciones a medias (rebase, merge, cherry-pick, revert) --------------------

  /**
   * Barra de aviso bajo las pestañas, como la de JetBrains: una línea por repo con una
   * operación parada, con sus conflictos pendientes y Continue / Skip / Abort. Continue
   * se desactiva mientras queden conflictos; «Resolve» lleva a Local Changes.
   */
  function renderOpBar() {
    const bar = $('#op-bar');
    const ops = data ? data.repos.filter(r => r.op) : [];
    bar.classList.toggle('hidden', !ops.length);
    if (!ops.length) { bar.innerHTML = ''; return; }
    const conflictsOf = idx => (changes ? changes.files.filter(f => f.repo === idx && f.group === 'conflicts').length : 0);
    bar.innerHTML = ops.map(r => {
      const op = r.op;
      const n = conflictsOf(r.idx);
      const step = op.step && op.total ? ` (${op.step}/${op.total})` : '';
      const what = op.kind === 'rebase' ? `Rebasing '${esc(op.theirs)}' onto '${esc(op.ours)}'${step}`
        : op.kind === 'merge' ? `Merging '${esc(op.theirs)}' into '${esc(op.ours)}'`
        : op.kind === 'cherry-pick' ? `Cherry-picking ${esc(op.theirs)}`
        : `Reverting ${esc(op.theirs)}`;
      const where = data.multi ? ` <span class="muted">in ${esc(r.name)}</span>` : '';
      const state = n ? `<span class="op-conflicts">${n} conflict${n === 1 ? '' : 's'}</span>` : '<span class="op-ok">All conflicts resolved</span>';
      const btn = (act, label, extra = '') => `<button class="btn ${act === 'continue' ? '' : 'secondary'}" data-op="${act}" data-repo="${r.idx}"${extra}>${label}</button>`;
      return `<div class="op-line"><span class="op-icon">${ICON.warning}</span><span class="op-text">${what}${where}</span>${state}` +
        '<span class="spacer"></span>' +
        (n ? btn('resolve', 'Resolve…') : '') +
        btn('continue', 'Continue', n ? ' disabled title="Resolve all conflicts first"' : '') +
        (op.kind !== 'merge' ? btn('skip', 'Skip') : '') +
        btn('abort', 'Abort') + '</div>';
    }).join('');
  }
  $('#op-bar').addEventListener('click', e => {
    const b = /** @type {HTMLButtonElement} */ (/** @type {HTMLElement} */ (e.target).closest('button[data-op]'));
    if (!b || b.disabled) { return; }
    const repo = Number(b.dataset.repo);
    if (b.dataset.op === 'resolve') {
      // Lleva a Local Changes con los conflictos de ese repo seleccionados
      switchTab('changes');
      if (changes) {
        const list = changes.files.filter(f => f.repo === repo && f.group === 'conflicts');
        chSel = new Set(list.map(chKey));
        renderChanges();
        if (list.length === 1) { changeAction('merge', list); }
      }
      return;
    }
    vscode.postMessage({ type: 'opAction', repo, action: b.dataset.op });
  });

  // ----- colores de carpetas ---------------------------------------------------------

  const DEFAULT_FOLDER_COLORS = { bugfix: 'red', feature: 'blue', release: 'yellow', hotfix: 'orange', '@remote': 'foreground' };
  /** Colores con nombre: siguen el tema activo (los grises se mezclan con el color del texto). */
  const COLOR_TOKENS = {
    red: ['Red', 'var(--vscode-charts-red, #f14c4c)'],
    orange: ['Orange', 'var(--vscode-charts-orange, #d18616)'],
    yellow: ['Yellow', 'var(--vscode-charts-yellow, #cca700)'],
    green: ['Green', 'var(--vscode-charts-green, #89d185)'],
    blue: ['Blue', 'var(--vscode-charts-blue, #3794ff)'],
    purple: ['Purple', 'var(--vscode-charts-purple, #b180d7)'],
    foreground: ['Text color', 'var(--vscode-foreground)'],
    'gray-light': ['Light gray', 'color-mix(in srgb, var(--vscode-foreground) 75%, transparent)'],
    gray: ['Gray', 'var(--muted)'],
    'gray-dark': ['Dark gray', 'color-mix(in srgb, var(--vscode-foreground) 38%, transparent)'],
  };
  /** Paletas predefinidas para la pestaña Settings. */
  /** Paletas de Folder Colors: Default primero y luego de más colorida a menos (en este orden salen en el selector). */
  const FOLDER_PALETTES = {
    Default: { bugfix: 'red', feature: 'blue', release: 'yellow', hotfix: 'orange', '@remote': 'foreground' },
    Vivid: { bugfix: '#ff4d4d', feature: '#2e9bff', release: '#ffd000', hotfix: '#ff8c00', '@remote': '#ffffff' },
    Nature: { bugfix: '#d9734e', feature: '#6aa84f', release: '#e0b84c', hotfix: '#a64d79', '@remote': '#9fc5e8' },
    Pastel: { bugfix: '#f2a7a7', feature: '#a7c7f2', release: '#f2e2a7', hotfix: '#f2c6a7', '@remote': '#d9d9d9' },
    'Grey Scale': { bugfix: 'foreground', feature: 'gray-light', release: 'gray-dark', hotfix: 'gray', '@remote': 'foreground' },
  };
  /** Paleta que coincide con los colores actuales de las carpetas, o 'Custom' si se han tocado a mano. */
  function currentPalette() {
    const cur = folderColors();
    const same = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);
    return Object.keys(FOLDER_PALETTES).find(p => same(FOLDER_PALETTES[p], cur)) || 'Custom';
  }
  /**
   * Nombre de una paleta con cada letra de uno de sus colores (bugfix, feature, release,
   * hotfix…), para ver su estilo; los colores van en data-c y se aplican por CSSOM.
   */
  function paletteLabelHtml(name, map) {
    const cols = Object.entries(map).filter(([k]) => k !== '@remote').map(([, v]) => colorCss(v)).filter(Boolean);
    if (!cols.length) { return esc(name); }
    return [...name].map((ch, i) => (ch === ' ' ? ' ' : `<span data-c="${esc(cols[i % cols.length])}">${esc(ch)}</span>`)).join('');
  }
  function applyDataColors(root) {
    for (const el of root.querySelectorAll('[data-c]')) { /** @type {HTMLElement} */ (el).style.color = /** @type {HTMLElement} */ (el).dataset.c || ''; }
  }
  /** Lista de paletas: cada nombre con sus colores; Custom solo se marca (sale al tocar algo a mano). */
  function paletteMenu() {
    const cur = currentPalette();
    return [
      ...Object.keys(FOLDER_PALETTES).map(p => ({ label: p, labelHtml: paletteLabelHtml(p, FOLDER_PALETTES[p]), checked: cur === p, act: () => { setFolderColors({ ...FOLDER_PALETTES[p] }); renderSettings(); } })),
      { sep: true },
      { label: 'Custom', labelHtml: paletteLabelHtml('Custom', folderColors()), checked: cur === 'Custom', disabled: cur !== 'Custom', act: () => {} },
    ];
  }
  /** Color de los tags (jbGit.tagColor, amarillo por defecto): la variable --c-tag, por CSSOM. */
  /**
   * Fuente de la interfaz (Settings ▸ General ▸ Fonts): --jb-font y --jb-font-size; vacías = la
   * de VS Code. El código usa siempre la del editor de VS Code (--jb-code-* no se fijan nunca).
   */
  function applyFonts() {
    const s = settings || {};
    const r = document.documentElement.style;
    const set = (name, v) => { if (v) { r.setProperty(name, v); } else { r.removeProperty(name); } };
    set('--jb-font', (s.fontFamily || '').trim());
    set('--jb-font-size', s.fontSize ? `${s.fontSize}px` : '');
    // Las filas del log se posicionan en JS (virtualización y grafo): su alto sigue a la letra
    const vs = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--vscode-font-size'));
    const fs = Number(s.fontSize) || (Number.isFinite(vs) && vs > 0 ? vs : 13);
    const rowH = Math.round(fs) + 11;
    r.setProperty('--row-h', `${rowH}px`);   // igual que ROW_H aunque la letra tenga decimales
    if (fs !== FS || rowH !== ROW_H) {
      FS = fs; ROW_H = rowH;
      applyLogView();
      if (data) { applySearch(); }
    }
    applyChangesWidth();   // los botones de commit cambian de ancho con la letra
  }
  function applyTagColor() {
    const v = (settings && settings.tagColor) || 'yellow';
    document.documentElement.style.setProperty('--c-tag', colorCss(v) || colorCss('yellow'));
  }
  function folderColors() { return (settings && settings.folderColors) || DEFAULT_FOLDER_COLORS; }
  function colorCss(v) { return COLOR_TOKENS[v] ? COLOR_TOKENS[v][1] : /^#[0-9a-f]{6}$/i.test(v || '') ? v : ''; }
  /** Pinta los iconos con data-fc según jbGit.folderColors (CSSOM, permitido por la CSP). */
  function applyFolderColors(root) {
    const map = folderColors();
    for (const el of root.querySelectorAll('[data-fc]')) {
      /** @type {HTMLElement} */ (el).style.color = colorCss(map[/** @type {HTMLElement} */ (el).dataset.fc || '']);
    }
  }
  function setFolderColors(map) {
    if (settings) { settings.folderColors = map; }
    vscode.postMessage({ type: 'setSetting', key: 'folderColors', value: map });
    if (data) { renderTree(); renderRows(true); }
  }

  // ----- Settings ▸ Log: vista previa ------------------------------------------------

  /**
   * Log de ejemplo para Settings ▸ Log: 8 commits ficticios con el grafo, las etiquetas y las
   * columnas pintados con las mismas funciones y clases que el log real (graphSvg, refHtml,
   * .row…), así que refleja al momento las opciones: paneles, columnas, referencias, resaltados,
   * formato de fecha, First Parent y Long Edges (la rama bugfix/parser hace de arista larga).
   * Los colores de carril salen de branchColorOf, igual que en el grafo.
   */
  function logPreviewHtml(s) {
    const lv = ui.logView;
    const fp = !!(data && data.firstParent);
    const longEdges = !!(data && data.longEdges);
    const multi = !!(data && data.multi);
    const C = { main: branchColorOf('main'), feat: branchColorOf('feature/signup'), fix: branchColorOf('bugfix/parser') };
    const now = Date.now() / 1000;
    const E = (kind, from, to, c) => ({ kind, from, to, color: c });
    // Aristas por fila: carril 0 main, 1 feature/signup, 2 bugfix/parser
    const fix2 = longEdges ? [E('pass', 2, 2, C.fix)] : [];
    const rows = [
      { sub: "Merge branch 'feature/signup'", au: 'Anna Smith', h: 'a1f3c9e2', ago: 0.4, repo: 0, parents: fp ? [2] : [2, 1], col: 0, c: C.main,
        edges: [E('out', 0, 0, C.main), ...(fp ? [] : [E('out', 0, 1, C.feat)])],
        refs: [{ cls: 'local current', label: 'origin & main', icon: ICON.branch }, { cls: 'tag', label: 'v1.2.0', icon: ICON.tag }] },
      { sub: 'Validate email address', au: 'You', h: '7c20d4b1', ago: 2, repo: 1, parents: [4], col: 1, c: C.feat,
        edges: [...(fp ? [] : [E('in', 1, 1, C.feat)]), E('out', 1, 1, C.feat), E('pass', 0, 0, C.main)],
        refs: [{ cls: 'local', label: 'origin & feature/signup', icon: ICON.branch, color: treeIconColor({ type: 'local', name: 'feature/signup' }) }] },
      { sub: 'Update README', au: 'Anna Smith', h: '5e8b0a77', ago: 5, repo: 0, parents: [6], col: 0, c: C.main,
        edges: [E('in', 0, 0, C.main), E('out', 0, 0, C.main), E('pass', 1, 1, C.feat)] },
      { sub: 'Fix null check in parser', au: 'Marc Dupont', h: 'e93a61f0', ago: 26, repo: 2, parents: [7], col: 2, c: C.fix,
        edges: [E('out', 2, 2, C.fix), E('pass', 0, 0, C.main), E('pass', 1, 1, C.feat)],
        refs: [{ cls: 'remote', label: 'origin/bugfix/parser', icon: ICON.branch, color: treeIconColor({ type: 'remote', name: 'origin/bugfix/parser', branch: 'bugfix/parser' }) }] },
      { sub: 'Add signup form', au: 'You', h: '0b4dd2c8', ago: 30, repo: 1, parents: [5], col: 1, c: C.feat,
        edges: [E('in', 1, 1, C.feat), E('out', 1, 1, C.feat), E('pass', 0, 0, C.main), ...(longEdges ? fix2 : [{ kind: 'down', from: 2, color: C.fix }])] },
      { sub: 'Start signup feature', au: 'You', h: '9a7716e5', ago: 50, repo: 1, parents: [6], col: 1, c: C.feat,
        edges: [E('in', 1, 1, C.feat), E('out', 1, 0, C.feat), E('pass', 0, 0, C.main), ...fix2] },
      { sub: 'Release 1.1', au: 'Anna Smith', h: '3f0c5ab9', ago: 120, repo: 0, parents: [7], col: 0, c: C.main,
        edges: [E('in', 0, 0, C.main), E('out', 0, 0, C.main), ...(longEdges ? fix2 : [{ kind: 'up', from: 2, color: C.fix }])],
        refs: [{ cls: 'tag', label: 'v1.1.0', icon: ICON.tag }] },
      { sub: 'Initial commit', au: 'Anna Smith', h: 'c0ffee42', ago: 400, repo: 0, parents: [], col: 0, c: C.main,
        edges: [E('in', 0, 0, C.main), E('in', 2, 0, C.fix)] },
    ];
    // Commits alcanzables desde HEAD (Highlight ▸ Current Branch), con los padres que haya
    const reach = new Set();
    const stack = [0];
    while (stack.length) { const i = stack.pop(); if (!reach.has(i)) { reach.add(i); stack.push(...rows[i].parents); } }
    const fmt = ago => {
      const t = (now - ago * 3600) * 1000;
      if ((s.dateFormat || 'absolute') === 'relative') {
        const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
        return ago < 1 ? rtf.format(-Math.round(ago * 60), 'minute') : ago < 24 ? rtf.format(-Math.round(ago), 'hour') : rtf.format(-Math.round(ago / 24), 'day');
      }
      const d = new Date(t);
      return `${d.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' })}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
    };
    const REPOS = ['backend', 'frontend', 'parser'];
    const width = 3;
    const html = rows.map((r, i) => {
      const cls = ['row'];
      if (i === 0) { cls.push('head'); }
      if (lv.mine && r.au === 'You') { cls.push('mine'); }
      if (lv.merges && r.parents.length > 1) { cls.push('merge'); }
      if (lv.current && !reach.has(i)) { cls.push('unreachable'); }
      let refs = (r.refs || []).filter(x => lv.tags || x.cls !== 'tag');
      let refsH = '';
      if (refs.length) {
        refsH = lv.compact && refs.length > 1
          ? `<span class="refs">${refHtml(refs[0])}<span class="ref more">+${refs.length - 1}</span></span>`
          : `<span class="refs">${refs.map(refHtml).join('')}</span>`;
      }
      const mark = multi ? `<span class="repo-mark rc${r.repo}">${ui.repoNames ? esc(REPOS[r.repo]) : ''}</span>` : '';
      return `<div class="${cls.join(' ')}" data-top="${i * ROW_H}">${mark}` +
        `<div class="c-subject">${graphSvg({ col: r.col, color: r.c, width, edges: r.edges }, i === 0)}<span class="subject">${esc(r.sub)}</span>${refsH}</div>` +
        `<div class="c-author">${esc(r.au)}</div><div class="c-hash">${r.h}</div><div class="c-date">${esc(fmt(r.ago))}</div></div>`;
    }).join('');
    const stub = (label, n) => `<div class="lp-stub"><div class="lp-stub-title">${label}</div>${Array.from({ length: n }, (_, k) => `<div class="lp-bar lp-w${k % 3}"></div>`).join('')}</div>`;
    return `<aside class="set-preview" aria-label="Preview"><div class="set-card"><div class="set-card-title">Preview</div><div class="set-card-body">` +
      `<div class="lp-frame">${ui.branchesHidden ? '' : stub('Branches', 6)}` +
      `<div class="lp-log log-preview${multi && ui.repoNames ? ' repo-wide' : ''}${lv.author ? '' : ' no-author'}${lv.hash ? '' : ' no-hash'}${lv.date ? '' : ' no-date'}${lv.subject ? '' : ' no-subject'}">${html}</div>` +
      `${lv.details ? stub('Details', 7) : ''}</div>` +
      `</div></div></aside>`;
  }

  /** Lo que la CSP no deja en el HTML de la vista previa: posiciones, columnas y colores de etiqueta. */
  function applyLogPreview() {
    const box = /** @type {HTMLElement | null} */ (settingsEl.querySelector('.log-preview'));
    if (!box) { return; }
    const lv = ui.logView;
    const cols = ['minmax(0, 1fr)'];
    const k = FS / 13;
    const px = n => `${Math.round(n * k)}px`;
    if (lv.author) { cols.push(`minmax(${px(50)}, ${px(96)})`); }
    if (lv.hash) { cols.push(px(66)); }
    // Anchos fijos: cada fila es su propia rejilla y así las columnas quedan alineadas
    if (lv.date) { cols.push(px(settings && settings.dateFormat === 'relative' ? 108 : 128)); }
    box.style.setProperty('--log-cols', cols.join(' '));
    box.style.height = `${8 * ROW_H}px`;
    applyPositions(box);
    for (const el of box.querySelectorAll('.ref[data-rc]')) { /** @type {HTMLElement} */ (el).style.setProperty('--ref-c', /** @type {HTMLElement} */ (el).dataset.rc || ''); }
    if (box.classList.contains('repo-wide')) { box.style.setProperty('--repo-col', '62px'); }
  }

  /** Botón «i» con su explicación (vacío si no hay texto); ver .set-info-wrap en main.css. */
  function infoBtn(label, text) {
    if (!text) { return ''; }
    return `<span class="set-info-wrap"><button class="set-info" data-set-info aria-label="About ${esc(label)}" aria-expanded="false">${ICON.info}</button>` +
      `<span class="set-info-pop" role="tooltip">${esc(text)}</span></span>`;
  }

  function renderSettings() {
    // No repintar mientras se escribe en un campo (se perdería lo escrito)
    if (settingsEl.contains(document.activeElement) && /** @type {HTMLElement} */ (document.activeElement).matches('input[type=text], input[type=number]')) { return; }
    const s = settings || {};
    settingsActs = [];
    // ----- piezas de la página -----
    // item: un ajuste (título, descripción y control). cfg: clave de jbGit.* para la marca de
    // «modificado» y su botón de volver al valor por defecto (CFG_DEFAULTS).
    // Las explicaciones no van debajo del título sino en un botón «i» a su lado (infoBtn): se ven
    // al pasar el ratón y al pulsarlo se quedan abiertas hasta pulsar fuera
    const item = (label, desc, control, cfg = '', extra = '', info = '') => {
      const mod = cfg && isModified(cfg);
      info = info || desc;
      // Reset: la flecha ↺ junto al control (como la de la fuente); sin control, junto al título
      const reset = mod ? `<button class="icon-btn set-reset-icon" data-reset-cfg="${cfg}" title="Reset to the default value" aria-label="Reset ${esc(label)}">${ICON.undo}</button>` : '';
      return `<div class="set-item${mod ? ' modified' : ''}" data-search="${esc((label + ' ' + info + ' ' + extra).toLowerCase())}">` +
        `<div class="set-item-head"><span class="set-item-label">${esc(label)}</span>${infoBtn(label, info)}` +
        (control ? '' : reset) + `</div>` +
        (control ? `<div class="set-item-control">${control}${reset}</div>` : '') + `</div>`;
    };
    // Casilla con su título y descripción (la de un ajuste jbGit.* lleva data-cfg)
    const checkItem = (label, desc, input, cfg = '') => {
      const mod = cfg && isModified(cfg);
      return `<label class="set-item set-item-check${mod ? ' modified' : ''}" data-search="${esc((label + ' ' + desc).toLowerCase())}">${input}` +
        `<span class="set-item-text"><span class="set-item-label">${esc(label)}</span>${infoBtn(label, desc)}</span></label>`;
    };
    const uiCheckItem = (it, desc = '') => {
      settingsActs.push(it.act);
      return checkItem(it.label + (it.key ? ` (${it.key})` : ''), desc, `<input type="checkbox" data-ui="${settingsActs.length - 1}"${it.checked ? ' checked' : ''}${it.disabled ? ' disabled' : ''}>`);
    };
    // card: un grupo de ajustes con título; grid: casillas en columnas
    const card = (title, body, keywords = '', grid = false) =>
      `<div class="set-card" data-search="${esc((title + ' ' + keywords).toLowerCase())}">${title ? `<div class="set-card-title">${esc(title)}</div>` : ''}<div class="set-card-body${grid ? ' grid' : ''}">${body}</div></div>`;
    const page = (id, desc, body, info = '') => {
      const pg = SETTINGS_PAGES.find(x => x.id === id);
      const parent = pg.parent ? SETTINGS_PAGES.find(x => x.id === pg.parent) : null;
      // Con algo cambiado en la sección, «Reset to Defaults» a la derecha del título
      // Una sección con subsecciones (Appearance, Log) no lleva el suyo: cada subsección tiene el propio
      const hasChildren = SETTINGS_PAGES.some(x => x.parent === id);
      const reset = !hasChildren && pageModified(id) ? `<button class="btn secondary set-page-reset" data-page-reset="${id}" title="Reset every setting of ${esc(pg.title)} to its default value">Reset to Defaults</button>` : '';
      return `<div class="set-pagebody${parent ? ' set-subpage' : ''}" data-page="${id}"><div class="set-page-head"><div class="set-page-titles">` +
        (parent ? `<div class="set-crumb">${esc(parent.title)} ›</div>` : '') +
        // El reset va en la línea del título (centrado con él), no junto a la miga «Log ›»
        `<h2>${esc(pg.title)}${infoBtn(pg.title, info)}${reset}</h2>${desc ? `<div class="set-page-desc">${esc(desc)}</div>` : ''}</div></div>${body}</div>`;
    };
    /**
     * Fuente y tamaño en una línea: desplegable con las fuentes instaladas (cada una con su
     * letra), «VS Code default» ('') y «Custom…» (campo de texto); y el tamaño (Default = 0).
     */
    const fontRow = (label, hint, famKey, sizeKey, list, generic, source, famVar, sizeVar) => {
      const fam = (s[famKey] || '').trim();
      // Lo que usa VS Code ahora mismo (sus variables del tema), para la opción por defecto
      const cs = getComputedStyle(document.documentElement);
      const vsFam = (cs.getPropertyValue(famVar) || '').split(',')[0].trim().replace(/^["']|["']$/g, '');
      const vsSize = Math.round(parseFloat(cs.getPropertyValue(sizeVar))) || 13;
      const defLabel = vsFam ? `${vsFam} (default)` : 'Default';
      const opts = list.filter(fontAvailable).map(n => [fontValue(n, generic), n]);
      const known = !fam || opts.some(([v]) => v === fam);
      const mod = isModified(famKey) || isModified(sizeKey);
      const size = Number(s[sizeKey]) || 0;
      // 0 = seguir a VS Code: se muestra con su tamaño actual; ese número no se repite en la lista
      const sizes = [0, ...[9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24].filter(n => n !== vsSize)];
      if (size && !sizes.includes(size)) { sizes.push(size); sizes.sort((a, b) => a - b); }
      return `<div class="set-item set-inline font-line${mod ? ' modified' : ''}" data-search="${esc(('font ' + label + ' ' + hint + ' size').toLowerCase())}">` +
        // Sin título (solo hay una línea, la de la interfaz): cada desplegable con su subtítulo encima
        `<label class="font-col"><span class="font-col-head">Font</span><select class="font-sel" data-font-sel="${famKey}" aria-label="${esc(label)} font">` +
          `<option value=""${!fam ? ' selected' : ''}>${esc(defLabel)}</option>` +
          opts.map(([v, n]) => `<option value="${esc(v)}" data-font="${esc(v)}"${v === fam ? ' selected' : ''}>${esc(n)}</option>`).join('') +
          `<option value="__custom"${known ? '' : ' selected'}>${known ? 'Custom' : `Custom: ${esc(fam)}`}</option></select></label>` +
        `<span class="font-break${known ? ' hidden' : ''}"></span>` +
        `<input type="text" class="font-custom${known ? ' hidden' : ''}" data-cfg="${famKey}" value="${esc(fam)}" placeholder="e.g. Inter, sans-serif" spellcheck="false" aria-label="${esc(label)} custom font">` +
        `<label class="font-col"><span class="font-col-head">Size</span><select class="size-sel" data-cfg="${sizeKey}" aria-label="${esc(label)} font size">${sizes.map(n => `<option value="${n}"${n === size ? ' selected' : ''}>${n ? `${n} px` : `${vsSize} px (default)`}</option>`).join('')}</select></label>` +
        // Reset: botón de icono a la altura de los desplegables (como el ↺ del color de los tags)
        (mod ? `<button class="icon-btn set-reset-icon" data-reset-font="${famKey},${sizeKey}" title="Back to the VS Code font and size" aria-label="Reset ${esc(label)} font">${ICON.undo}</button>` : '') +
        `</div>`;
    };
    const num = (key, min, max, step = 1) => `<input type="number" data-cfg="${key}" min="${min}" max="${max}" step="${step}" value="${esc(s[key] ?? CFG_DEFAULTS[key])}">`;
    const text = (key, placeholder, value = s[key] || '') => `<input type="text" data-cfg="${key}" value="${esc(value)}" placeholder="${esc(placeholder)}" spellcheck="false">`;

    // Opciones del ojo del Log, una tarjeta por cada cabecera del menú
    let logCards = '';
    // Sin Show Branches / Show Details (los primeros, antes de la primera cabecera): ya están
    // las flechas ‹ › de los paneles del Log
    // Cada cabecera del ojo es una columna de la tarjeta del Log (logCols)
    let title = '', group = '';
    const lvCol = (t, body) => `<div class="lv-col"><h4>${esc(t)}</h4>${body}</div>`;
    for (const it of logViewMenu()) {
      if (!title && !it.header) { continue; }
      if (it.header) { if (group) { logCards += lvCol(title, group); } title = it.header; group = ''; continue; }
      if (it.label) { group += uiCheckItem(it); }
    }
    if (group) { logCards += lvCol(title, group); }

    const groupBy = which => {
      const gb = which === 'changes' ? ui.changesGroupBy : ui.stashGroupBy;
      const toggle = k => () => { gb[k] = !gb[k]; saveUi(); if (which === 'changes') { renderChanges(); } else { renderStashFiles(); } };
      return card('Group By', uiCheckItem({ label: 'Directory', checked: !!gb.directory, act: toggle('directory') }) +
        uiCheckItem({ label: 'Repository', checked: !!gb.repository, act: toggle('repository') }), 'group by view options eye', true);
    };


    const pages =
      // Fonts y Repositories, uno al lado del otro (.set-row; en un panel estrecho, uno debajo de otro)
      page('general', '', '<div class="set-row">' +
        card('Fonts',
          fontRow('Interface', '', 'fontFamily', 'fontSize', UI_FONTS, 'sans-serif', 'VS Code', '--vscode-font-family', '--vscode-font-size'), 'font typeface size') +
        card('Repositories',
          item('Repository scan depth', '', num('repositoryScanMaxDepth', 0, 5), 'repositoryScanMaxDepth', '',
            'Folder levels searched for Git repositories below the opened folder and below each repository found.\n0 = only the opened folder.')) +
        '</div>') +
      // Appearance no tiene ajustes propios: al elegirla se ven sus subcategorías una tras otra
      page('appearance', '', '') +
      page('folderColors', '',
        // La paleta, en el título del cuadro: muestra la actual (o Custom) con sus colores
        `<div class="set-card" data-search="folders folder colors palette grey scale pastel vivid nature custom bugfix feature release hotfix">` +
          `<div class="set-card-title set-card-head"><span>Folders</span>` +
          `<button class="color-pick pal-pick" data-fc-palette-pick aria-haspopup="menu" title="Palette" aria-label="Palette: ${esc(currentPalette())}">` +
          `<span class="cp-label">${paletteLabelHtml(currentPalette(), currentPalette() === 'Custom' ? folderColors() : FOLDER_PALETTES[currentPalette()])}</span><span class="cp-arrow">${ICON.chevronDown}</span></button></div>` +
          `<div class="set-card-body">${folderColorsHtml()}</div></div>`) +
      page('branchColors', '', card('',
        // Un solo cuadro: las ramas a la izquierda y los tags en su columna a la derecha
        `<div class="gc-cols"><div class="gc-col"><h4>Branches</h4>${branchColorsHtml()}</div>` +
        // Debajo de Tags, en la misma columna: Colors (sincronizar los colores de las ramas)
        `<div class="gc-col gc-tags"><h4>Tags</h4>${tagColorHtml(s.tagColor || 'yellow')}` +
        `<h4 class="gc-sub">Colors</h4>${uiCheckItem({ label: 'Sync branch colors with the graph', checked: ui.branchGraphColors, act: () => { ui.branchGraphColors = !ui.branchGraphColors; saveUi(); renderTree(); renderRows(true); } },
          'Tree icons and log labels use the graph color.')}</div></div>`, 'graph colors branch tag lane color colour folder sync')) +
      // Log no tiene ajustes propios: al elegirla se ven sus subcategorías una tras otra
      page('log', '', '') +
      page('branches', '',
        card('Protection',
          item('Protected branches', 'Comma-separated. Their remote branch shows a lock, can\'t be deleted and can\'t be force-pushed.', text('protectedBranches', 'main, master', (s.protectedBranches || []).join(', ')), 'protectedBranches'))) +
      page('graph', '',
        // Todas las opciones en una tarjeta a lo ancho, una columna por grupo, y debajo un log de
        // ejemplo que las refleja (logPreviewHtml): así cabe todo sin scroll
        `<div class="set-card lv-card" data-search="log commits columns references highlight graph"><div class="set-card-body lv-cols">` +
          lvCol('Commits',
            item('Date format', '', `<select class="lv-date" data-cfg="dateFormat" title="How commit dates are shown in the log"><option value="absolute"${s.dateFormat !== 'relative' ? ' selected' : ''}>Absolute (17/11/2026, 12:49)</option><option value="relative"${s.dateFormat === 'relative' ? ' selected' : ''}>Relative (2 hours ago)</option></select>`, 'dateFormat', 'how commit dates are shown absolute relative') +
            item('Commits per page', '', num('maxCommits', 100, 10000, 100), 'maxCommits', 'commits loaded at once load more')) +
          logCards + `</div></div>` +
        logPreviewHtml(s)) +
      page('changes', '',
        card('Commit',
          checkItem('Auto-stage changes', 'Tracked changes are staged automatically.',
            `<input type="checkbox" data-cfg="autoStage"${s.autoStage !== false ? ' checked' : ''}>`, 'autoStage')) +
        groupBy('changes')) +
      page('stash', '', groupBy('stash')) +
      page('shortcuts', '', shortcutsHtml(), 'Click a shortcut and press the new key combination (Esc cancels).\nNavigation keys (arrows, Home, End, Page Up/Down, Enter, Tab, Shift+arrows, Ctrl+A, Shift+F10) can\'t be used.');

    if (!SETTINGS_PAGES.some(x => x.id === ui.settingsPage)) { ui.settingsPage = 'general'; }
    // Menú en árbol: las categorías con subcategorías llevan una flecha para plegarlas (como JetBrains)
    const nav = SETTINGS_PAGES.map(pg => {
      const parentOf = SETTINGS_PAGES.some(x => x.parent === pg.id);
      const closed = parentOf && ui.settingsCollapsed.includes(pg.id);
      const twisty = parentOf
        ? `<span class="set-nav-twisty${closed ? ' closed' : ''}" data-set-toggle="${pg.id}" title="${closed ? 'Expand' : 'Collapse'}">${ICON.chevronDown}</span>`
        : (pg.parent ? '' : '<span class="set-nav-twisty blank"></span>');
      const hidden = pg.parent && ui.settingsCollapsed.includes(pg.parent);
      return `<button class="set-nav-item${pg.parent ? ' child' : ''}${hidden ? ' folded' : ''}" data-set-page="${pg.id}"${pg.parent ? ` data-set-parent="${pg.parent}"` : ''}>${twisty}${ICON[pg.icon] || ''}<span class="set-nav-label">${esc(pg.title)}</span><span class="set-nav-count"></span></button>`;
    }).join('');
    const navScroll = settingsEl.querySelector('.set-nav-list') ? settingsEl.querySelector('.set-nav-list').scrollTop : 0;
    const contentEl = settingsEl.querySelector('.set-content');
    const contentScroll = contentEl ? contentEl.scrollTop : 0;
    settingsEl.innerHTML = `<div class="set-layout">` +
      `<nav class="set-nav"><div class="set-search">${ICON.search}<input type="text" data-set-search placeholder="Search settings" spellcheck="false" value="${esc(settingsQuery)}"></div>` +
      `<div class="set-nav-list">${nav}</div>` +
      `<div class="set-nav-foot"><button class="link-btn" data-open-settings>Open in VS Code Settings</button></div></nav>` +
      `<div class="set-content"><div class="set-content-inner">${pages}<div class="set-noresults hidden">No settings match "<span></span>".</div></div></div></div>`;
    /** @type {HTMLElement} */ (settingsEl.querySelector('.set-nav-list')).scrollTop = navScroll;
    applyFolderColors(settingsEl);
    applyBranchColorDots(settingsEl);
    applyDataColors(settingsEl);
    const palBtn = /** @type {HTMLElement | null} */ (settingsEl.querySelector('.pal-pick .cp-label'));
    const pctx = document.createElement('canvas').getContext('2d');
    if (palBtn && pctx) {
      pctx.font = getComputedStyle(palBtn).font;
      palBtn.style.width = `${Math.ceil(Math.max(...[...Object.keys(FOLDER_PALETTES), 'Custom'].map(n => pctx.measureText(n).width))) + 2}px`;
    }
    for (const b of settingsEl.querySelectorAll('.color-pick[data-color]')) {
      /** @type {HTMLElement} */ (b).style.color = /** @type {HTMLElement} */ (b).dataset.color || '';
      // Ancho justo para el nombre de color más largo (medido con la fuente del botón)
      const lbl = /** @type {HTMLElement | null} */ (b.querySelector('.cp-label'));
      const ctx = document.createElement('canvas').getContext('2d');
      if (lbl && ctx) {
        ctx.font = getComputedStyle(lbl).font;
        const w = Math.max(...[...Object.values(COLOR_TOKENS).map(x => x[0]), 'Custom'].map(n => ctx.measureText(n).width));
        lbl.style.width = `${Math.ceil(w) + 2}px`;
      }
    }
    sizeFontSelects();
    applyLogPreview();
    for (const o of settingsEl.querySelectorAll('option[data-font]')) { /** @type {HTMLElement} */ (o).style.fontFamily = /** @type {HTMLElement} */ (o).dataset.font || ''; }
    for (const sel of settingsEl.querySelectorAll('select.font-sel')) {
      const v = /** @type {HTMLSelectElement} */ (sel).value;
      if (v && v !== '__custom') { /** @type {HTMLElement} */ (sel).style.fontFamily = v; }
    }
    applySettingsView();
    /** @type {HTMLElement} */ (settingsEl.querySelector('.set-content')).scrollTop = contentScroll;
    if (scRecording) {
      const b = /** @type {HTMLElement | null} */ (settingsEl.querySelector(`.sc-row[data-sc="${scRecording}"] [data-sc-rec]`));
      if (b) { b.focus(); }
    }
  }

  /**
   * Ancho de los desplegables de Fonts: el de su opción más larga (medida con su fuente) más
   * el hueco de la flecha; los de fuente todos iguales y los de tamaño también, para que
   * queden en columna bajo sus subtítulos.
   */
  function sizeFontSelects() {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) { return; }
    const fit = sels => {
      const list = /** @type {HTMLSelectElement[]} */ ([...settingsEl.querySelectorAll(sels)]);
      if (!list.length) { return; }
      ctx.font = getComputedStyle(list[0]).font;
      const w = Math.ceil(Math.max(...list.flatMap(sel => [...sel.options].map(o => ctx.measureText(o.textContent || '').width)))) + 40;
      for (const sel of list) { sel.style.width = `${w}px`; }
      return w;
    };
    const wf = fit('.font-sel') || 0;
    const ws = fit('.size-sel') || 0;
    // El campo de fuente propia va en su propia línea, bajo las dos columnas
    for (const inp of settingsEl.querySelectorAll('.font-custom')) { /** @type {HTMLElement} */ (inp).style.width = `${wf + 18 + ws}px`; }
  }

  /** Fuentes que se ofrecen en Settings ▸ Appearance ▸ Fonts (solo salen las instaladas). */
  const UI_FONTS = ['system-ui', 'Segoe UI', 'SF Pro Text', 'Helvetica Neue', 'Inter', 'Roboto', 'Ubuntu', 'Cantarell', 'Noto Sans', 'Open Sans', 'Fira Sans',
    'Source Sans 3', 'Source Sans Pro', 'Lato', 'IBM Plex Sans', 'DejaVu Sans', 'Liberation Sans', 'Arial', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Georgia'];
  /** Valor CSS de una fuente de la lista: entre comillas y con su genérica detrás. */
  const fontValue = (name, generic) => (['system-ui', 'monospace', 'sans-serif', 'serif'].includes(name) ? name : `"${name}", ${generic}`);
  /** ¿Está instalada? Se compara el ancho de un texto con la fuente y con cada genérica. */
  const fontAvailable = (() => {
    const cache = new Map();
    const ctx = document.createElement('canvas').getContext('2d');
    return name => {
      if (['system-ui', 'monospace', 'sans-serif', 'serif'].includes(name)) { return true; }
      if (cache.has(name)) { return cache.get(name); }
      let ok = false;
      if (ctx) {
        const t = 'mmmmmmmmmmlli1WQ@#';
        for (const base of ['monospace', 'serif', 'sans-serif']) {
          ctx.font = `20px ${base}`;
          const w0 = ctx.measureText(t).width;
          ctx.font = `20px "${name}", ${base}`;
          if (ctx.measureText(t).width !== w0) { ok = true; break; }
        }
      }
      cache.set(name, ok);
      return ok;
    };
  })();

  /** Categorías de Settings (el menú de la izquierda); parent: subcategoría. */
  const SETTINGS_PAGES = [
    { id: 'general', title: 'General', icon: 'gear' },
    { id: 'appearance', title: 'Appearance', icon: 'palette' },
    { id: 'folderColors', title: 'Folder Colors', icon: 'folder', parent: 'appearance' },
    { id: 'branchColors', title: 'Graph Colors', icon: 'branch', parent: 'appearance' },
    { id: 'log', title: 'Log', icon: 'log' },
    { id: 'branches', title: 'Branches', icon: 'branch', parent: 'log' },
    { id: 'graph', title: 'Graph', icon: 'commit', parent: 'log' },
    { id: 'changes', title: 'Local Changes', icon: 'file' },
    { id: 'stash', title: 'Stash', icon: 'stash' },
    { id: 'shortcuts', title: 'Keyboard Shortcuts', icon: 'keyboard' },
  ];
  /** Valores por defecto de los ajustes jbGit.* (los de package.json), para la marca de «modificado». */
  const CFG_DEFAULTS = { dateFormat: 'absolute', maxCommits: 1000, repositoryScanMaxDepth: 2, autoStage: true, protectedBranches: ['main', 'master'],
    fontFamily: '', fontSize: 0, tagColor: 'yellow' };
  function isModified(key) {
    if (!settings || !(key in CFG_DEFAULTS)) { return false; }
    const v = settings[key] ?? CFG_DEFAULTS[key];
    return JSON.stringify(v) !== JSON.stringify(CFG_DEFAULTS[key]);
  }
  let settingsQuery = '';

  /** Restaura los tamaños de los paneles (clic derecho en las pestañas ▸ Reset Panel Sizes). */
  function resetPanelSizes() {
    ui.branchesWidth = 220; ui.detailsWidth = 340; ui.filesRatio = 0.5; ui.changesWidth = 420; ui.commitHeight = 150; ui.stashFilesWidth = 340;
    ui.branchesHidden = false;
    applyLayout(); saveUi();
  }

  /**
   * Qué ajustes tiene cada sección de Settings, para su botón «Reset to Defaults»: modified()
   * dice si alguno difiere de su valor por defecto y reset() los restaura (jbGit.* con
   * setSetting; las opciones de vista en ui; First Parent y Long Edges con logOption). Una
   * sección con subsecciones (Appearance, Log) junta las de sus hijas.
   */
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const sameMap = (a, b) => same(Object.entries(a || {}).sort(), Object.entries(b || {}).sort());
  const resetCfg = (...keys) => {
    for (const key of keys) {
      if (settings) { settings[key] = CFG_DEFAULTS[key]; }
      vscode.postMessage({ type: 'setSetting', key, value: CFG_DEFAULTS[key] });
    }
  };
  const PAGE_RESETS = {
    general: {
      modified: () => ['fontFamily', 'fontSize', 'repositoryScanMaxDepth'].some(isModified),
      reset: () => { resetCfg('fontFamily', 'fontSize', 'repositoryScanMaxDepth'); applyFonts(); },
    },
    folderColors: {
      modified: () => !sameMap(folderColors(), DEFAULT_FOLDER_COLORS),
      reset: () => {
        if (settings) { settings.folderColors = { ...DEFAULT_FOLDER_COLORS }; }
        vscode.postMessage({ type: 'setSetting', key: 'folderColors', value: { ...DEFAULT_FOLDER_COLORS } });
        if (data) { renderTree(); renderRows(true); }
      },
    },
    branchColors: {
      modified: () => Object.keys(branchColors()).length > 0 || isModified('tagColor') || !ui.branchGraphColors,
      reset: () => {
        if (settings) { settings.branchColors = {}; }
        vscode.postMessage({ type: 'setSetting', key: 'branchColors', value: {} });
        resetCfg('tagColor'); applyTagColor();
        ui.branchGraphColors = true; saveUi();
        if (data) { renderTree(); renderRows(true); }
      },
    },
    branches: { modified: () => isModified('protectedBranches'), reset: () => resetCfg('protectedBranches') },
    graph: {
      modified: () => isModified('dateFormat') || isModified('maxCommits') || !same({ ...LOGVIEW_DEFAULTS, ...ui.logView }, LOGVIEW_DEFAULTS) ||
        ui.repoNames || !!(data && (data.firstParent || data.longEdges)),
      reset: () => {
        resetCfg('dateFormat', 'maxCommits');
        ui.logView = { ...LOGVIEW_DEFAULTS, details: ui.logView.details };   // el panel de detalles va con su flecha
        ui.repoNames = false; saveUi();
        applyLogView(); applySearch();
        for (const key of ['firstParent', 'longEdges']) {
          if (data && data[key]) { filterChanging = true; vscode.postMessage({ type: 'logOption', key, value: false }); }
        }
      },
    },
    changes: {
      modified: () => isModified('autoStage') || !same(ui.changesGroupBy, GROUPBY_DEFAULTS),
      reset: () => { resetCfg('autoStage'); ui.changesGroupBy = { ...GROUPBY_DEFAULTS }; saveUi(); renderChanges(); },
    },
    stash: {
      modified: () => !same(ui.stashGroupBy, GROUPBY_DEFAULTS),
      reset: () => { ui.stashGroupBy = { ...GROUPBY_DEFAULTS }; saveUi(); renderStashFiles(); },
    },
    shortcuts: {
      modified: () => Object.keys((settings && settings.shortcuts) || {}).length > 0,
      reset: () => { saveShortcuts({}); scNote = ''; },
    },
  };
  /** La sección (o alguna de sus subsecciones) tiene algo distinto de su valor por defecto. */
  function pageModified(id) {
    const own = PAGE_RESETS[id];
    return !!(own && own.modified()) || SETTINGS_PAGES.some(x => x.parent === id && pageModified(x.id));
  }
  function resetPage(id) {
    const own = PAGE_RESETS[id];
    if (own && own.modified()) { own.reset(); }
    for (const x of SETTINGS_PAGES) { if (x.parent === id) { resetPage(x.id); } }
  }

  /**
   * Sin búsqueda, solo se ve la categoría elegida. Con búsqueda, todas, con solo los ajustes
   * que coinciden (si coincide el título de una tarjeta, la tarjeta entera); el menú dice
   * cuántos hay en cada categoría y desactiva las que no tienen ninguno.
   */
  function applySettingsView() {
    const q = settingsQuery.trim().toLowerCase();
    const root = /** @type {HTMLElement | null} */ (settingsEl.querySelector('.set-layout'));
    if (!root) { return; }
    root.classList.toggle('searching', !!q);
    root.classList.toggle('set-parent-view', !q && SETTINGS_PAGES.some(x => x.parent === ui.settingsPage));
    const ITEM = '.set-item, .sc-row, .fc-row[data-fc-name], .bc-row, .tag-row';
    const textOf = el => (el.dataset.search || el.dataset.scText || el.dataset.fcName || el.dataset.bcName || el.textContent || '').toLowerCase();
    let total = 0;
    for (const body of settingsEl.querySelectorAll('.set-pagebody')) {
      const id = /** @type {HTMLElement} */ (body).dataset.page;
      let count = 0;
      for (const c of body.querySelectorAll('.set-card')) {
        const cardHit = !!q && textOf(c).includes(q);
        let any = !q || cardHit;
        for (const it of c.querySelectorAll(ITEM)) {
          const on = !q || cardHit || textOf(it).includes(q);
          it.classList.toggle('set-hidden', !on);
          if (on) { any = true; if (q) { count++; } }
        }
        // Las listas de atajos: la cabecera de cada vista solo con alguna fila visible
        for (const list of c.querySelectorAll('.sc-list')) {
          const vis = !!list.querySelector('.sc-row:not(.set-hidden)');
          list.classList.toggle('set-hidden', !vis);
          const h = c.querySelector(`h4.sc-scope[data-sc-scope="${/** @type {HTMLElement} */ (list).dataset.scScope}"]`);
          if (h) { h.classList.toggle('set-hidden', !vis); }
        }
        c.classList.toggle('set-hidden', !any);
        if (any && q && cardHit && !c.querySelector(ITEM)) { count++; }
      }
      // Una categoría con subcategorías (Appearance) las muestra todas, una tras otra
      const parent = (SETTINGS_PAGES.find(x => x.id === id) || {}).parent;
      const show = q ? count > 0 : id === ui.settingsPage || parent === ui.settingsPage;
      body.classList.toggle('set-hidden', !show);
      total += count;
      const nb = /** @type {HTMLElement | null} */ (settingsEl.querySelector(`.set-nav-item[data-set-page="${id}"]`));
      if (nb) {
        // Con la subcategoría elegida plegada, se marca su categoría
        const selPg = SETTINGS_PAGES.find(x => x.id === ui.settingsPage);
        const folded = !!(selPg && selPg.parent === id && ui.settingsCollapsed.includes(id));
        nb.classList.toggle('active', !q && (id === ui.settingsPage || folded));
        nb.classList.toggle('dim', !!q && !count);
        /** @type {HTMLElement} */ (nb.querySelector('.set-nav-count')).textContent = q && count ? String(count) : '';
      }
    }
    const none = /** @type {HTMLElement} */ (settingsEl.querySelector('.set-noresults'));
    none.classList.toggle('hidden', !q || total > 0);
    /** @type {HTMLElement} */ (none.querySelector('span')).textContent = settingsQuery.trim();
  }

  // ----- Settings ▸ Keyboard Shortcuts --------------------------------------------------

  let scRecording = null;   // id de la acción cuyo atajo se está grabando
  let scNote = '';          // aviso tras grabar (p. ej. a qué acción se le quitó)

  function shortcutsHtml() {
    const user = (settings && settings.shortcuts) || {};
    // La explicación va en la «i» del título de la página; aquí solo el aviso tras grabar uno
    let html = scNote ? `<div class="set-card"><div class="set-card-body"><div class="sc-note">${esc(scNote)}</div></div></div>` : '';
    for (const [scope, title] of Object.entries(SHORTCUT_SCOPES)) {
      html += `<div class="set-card" data-search="${esc(('shortcut ' + title).toLowerCase())}"><div class="set-card-title">${esc(title)}</div><div class="set-card-body sc-list">`;
      for (const [id, name] of SHORTCUT_ACTIONS.filter(([x]) => x.startsWith(scope + '.'))) {
        const k = shortcutOf(id);
        const rec = scRecording === id;
        const changed = id in user;
        html += `<div class="sc-row${changed ? ' modified' : ''}" data-sc="${id}" data-sc-text="${esc((title + ' ' + name + ' ' + keyLabel(k) + ' ' + k).toLowerCase())}">` +
          `<span class="sc-name">${esc(name)}</span>` +
          `<button class="sc-key${rec ? ' recording' : ''}${k ? '' : ' none'}" data-sc-rec title="Click to change">${rec ? 'Press a key combination… (Esc cancels)' : k ? esc(keyLabel(k)) : 'None'}</button>` +
          (k && !rec ? `<button class="icon-btn" data-sc-clear title="Remove shortcut" aria-label="Remove shortcut">${ICON.close}</button>` : '<span class="sc-spacer"></span>') +
          (changed && !rec ? `<button class="icon-btn" data-sc-reset title="Reset to default (${esc(keyLabel(SHORTCUT_DEFAULTS[id]) || 'None')})" aria-label="Reset">${ICON.undo}</button>` : '<span class="sc-spacer"></span>') +
          (k && VSCODE_KEYS.has(k) ? `<span class="sc-warn" title="VS Code also receives this key from the panel, so its own command runs too">${ICON.warning} also a VS Code shortcut</span>` : '') +
          '</div>';
      }
      html += '</div></div>';
    }
    return html;
  }
  /** Guarda el mapa de atajos del usuario (solo lo que difiere del valor por defecto). */
  function saveShortcuts(user) {
    for (const [id, k] of Object.entries(user)) { if ((SHORTCUT_DEFAULTS[id] || '') === k) { delete user[id]; } }
    if (settings) { settings.shortcuts = user; }
    vscode.postMessage({ type: 'setSetting', key: 'shortcuts', value: user });
  }
  function setShortcut(id, k) {
    const user = { ...((settings && settings.shortcuts) || {}) };
    const scope = id.split('.')[0];
    const taken = [];
    // La misma combinación en la misma vista: se le quita a la otra acción
    if (k) {
      for (const [other, name] of SHORTCUT_ACTIONS) {
        if (other !== id && other.startsWith(scope + '.') && shortcutOf(other) === k) { user[other] = ''; taken.push(name); }
      }
    }
    user[id] = k;
    saveShortcuts(user);
    scNote = taken.length ? `${keyLabel(k)} was removed from: ${taken.join(', ')}.` : '';
  }
  // Grabación: la siguiente pulsación (en captura, antes que cualquier otro manejador)
  window.addEventListener('keydown', e => {
    if (!scRecording) { return; }
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { scRecording = null; scNote = ''; renderSettings(); return; }
    const k = eventKey(e);
    if (!k) { return; }
    if (RESERVED_KEYS.has(k)) { scNote = `${keyLabel(k)} is used to move around the lists and can't be assigned.`; renderSettings(); return; }
    const id = scRecording;
    scRecording = null;
    setShortcut(id, k);
    renderSettings();
  }, true);

  /** Sección Branch Colors: color del carril de cada rama en el grafo (jbGit.branchColors). */
  /**
   * Settings ▸ Branch Colors, como Folder Colors: main y master siempre en la lista (con su
   * color, el propio o el automático azul; ↺ vuelve al automático) y debajo las ramas con
   * color propio (la papelera lo quita).
   */
  function branchColorsHtml() {
    const map = branchColors();
    const FIXED = ['main', 'master'];
    const names = [...FIXED, ...Object.keys(map).filter(n => !FIXED.includes(n)).sort((a, b) => a.localeCompare(b))];
    const rows = names.map(name => {
      const v = (map[name] || autoBranchColor(name)).toLowerCase();
      const custom = !!map[name];
      const pi = PALETTE.findIndex(h => h.toLowerCase() === v);
      const options = PALETTE.map((h, i) => `<option value="${h.toLowerCase()}"${i === pi ? ' selected' : ''}>${PALETTE_NAMES[i]}</option>`).join('') +
        `<option value="custom"${pi < 0 ? ' selected' : ''}>Custom</option>`;
      const action = !FIXED.includes(name)
        ? `<button class="icon-btn" data-bc-del title="Remove '${esc(name)}' (back to the automatic color)" aria-label="Remove">${ICON.trash}</button>`
        : custom ? `<button class="icon-btn" data-bc-del title="Back to the automatic color (yellow)" aria-label="Reset">${ICON.undo}</button>` : '<span class="fc-del-spacer"></span>';
      return `<div class="fc-row bc-row${custom ? ' modified' : ''}" data-bc-name="${esc(name)}">` +
        `<span class="fc-swatch bc-ico" data-bc-color="${esc(v)}">${ICON.branch}</span>` +
        `<span class="fc-name" title="${esc(name)}">${esc(name)}</span>` +
        `<select data-bc-color-sel aria-label="Color of '${esc(name)}'">${options}</select>` +
        `<input type="color" data-bc-hex value="${esc(v)}" title="Custom color"${pi >= 0 ? ' class="hidden"' : ''}>` +
        action + '</div>';
    }).join('');
    return `<div class="fc-list">${rows}</div>` +
      `<div class="fc-add"><input type="text" data-bc-new placeholder="Branch name (e.g. develop)"><button class="btn secondary" data-bc-add>Add Branch</button>` +
      '</div>';
  }
  /** Color de los tags (jbGit.tagColor), con la misma forma que las filas de ramas y carpetas. */
  function tagColorHtml(v) {
    const mod = isModified('tagColor');
    const hex = /^#[0-9a-f]{6}$/i.test(v) ? v : '#888888';
    const name = COLOR_TOKENS[v] ? COLOR_TOKENS[v][0] : 'Custom';
    // Botón con el icono y el nombre del color, de ese color; abre la lista (tagColorMenu)
    return `<div class="fc-list"><div class="fc-row tag-row${mod ? ' modified' : ''}" data-search="tag color tags">` +
      `<span class="fc-swatch tag-swatch">${ICON.tag}</span><span class="fc-name">All tags</span>` +
      `<button class="color-pick" data-tagc-pick data-color="${esc(colorCss(v) || v)}" aria-haspopup="menu" aria-label="Tag color: ${esc(name)}">` +
        `<span class="cp-ico">${ICON.tag}</span><span class="cp-label">${esc(name)}</span><span class="cp-arrow">${ICON.chevronDown}</span></button>` +
      `<input type="color" class="cp-hex" data-tagc-hex value="${hex}" tabindex="-1" aria-hidden="true">` +
      (mod ? `<button class="icon-btn" data-reset-cfg="tagColor" title="Back to the default color (yellow)" aria-label="Reset">${ICON.undo}</button>` : '<span class="fc-del-spacer"></span>') +
      '</div></div>';
  }
  /** Cambia el color de los tags (un nombre del tema o #rrggbb) y lo guarda. */
  function setTagColor(value) {
    if (settings) { settings.tagColor = value; }
    applyTagColor();
    vscode.postMessage({ type: 'setSetting', key: 'tagColor', value });
    renderSettings();
  }
  /** Lista de colores para los tags: cada opción con el icono y el nombre en su color. */
  function tagColorMenu() {
    const v = (settings && settings.tagColor) || 'yellow';
    const custom = !COLOR_TOKENS[v];
    return [
      ...Object.entries(COLOR_TOKENS).map(([k, [label, css]]) => ({ label, checked: v === k, icon: ICON.tag, color: css, act: () => setTagColor(k) })),
      { sep: true },
      { label: 'Custom', checked: custom, icon: ICON.tag, color: custom ? v : '', act: () => {
        const hx = /** @type {HTMLInputElement | null} */ (settingsEl.querySelector('[data-tagc-hex]'));
        if (hx) { try { hx.showPicker(); } catch { hx.click(); } }
      } },
    ];
  }
  function applyBranchColorDots(root) {
    for (const el of root.querySelectorAll('[data-bc-color]')) {
      const c = /** @type {HTMLElement} */ (el).dataset.bcColor || '';
      // El icono de rama toma el color; los puntos (si los hay), el fondo
      if (el.classList.contains('bc-ico')) { /** @type {HTMLElement} */ (el).style.color = c; } else { /** @type {HTMLElement} */ (el).style.background = c; }
    }
  }
  function addBranchColor() {
    const input = /** @type {HTMLInputElement} */ (settingsEl.querySelector('[data-bc-new]'));
    const name = (input.value || '').trim().replace(/^refs\/(heads|remotes\/[^/]+)\//, '');
    if (!name) { input.focus(); return; }
    if (!branchColors()[name]) { setBranchColor(name, branchColorOf(name)); }
    input.value = '';
    renderSettings();
  }

  /** Sección Folder Colors: paletas, una fila por carpeta (color con nombre o personalizado) y añadir. */
  function folderColorsHtml() {
    const map = folderColors();
    const entries = Object.entries(map).sort((a, b) => (a[0] === '@remote' ? -1 : b[0] === '@remote' ? 1 : a[0].localeCompare(b[0])));
    const options = v => Object.entries(COLOR_TOKENS).map(([k, [label]]) => `<option value="${k}"${v === k ? ' selected' : ''}>${label}</option>`).join('') +
      `<option value="custom"${COLOR_TOKENS[v] ? '' : ' selected'}>Custom</option>`;
    const rows = entries.map(([name, v]) => {
      const remote = name === '@remote';
      const hex = /^#[0-9a-f]{6}$/i.test(v) ? v : '#888888';
      return `<div class="fc-row" data-fc-name="${esc(name)}">` +
        `<span class="fc-swatch" data-fc="${esc(name)}">${remote ? ICON.remote : ICON.folder}</span>` +
        `<span class="fc-name">${remote ? 'Remote icons <span class="muted">(origin…)</span>' : esc(name)}</span>` +
        `<select data-fc-color>${options(v)}</select>` +
        `<input type="color" data-fc-hex value="${hex}" title="Custom color"${COLOR_TOKENS[v] ? ' class="hidden"' : ''}>` +
        (remote ? '<span class="fc-del-spacer"></span>' : `<button class="icon-btn" data-fc-del title="Remove '${esc(name)}'" aria-label="Remove">${ICON.trash}</button>`) +
        '</div>';
    }).join('');
    return `<div class="fc-list">${rows}</div>` +
      `<div class="fc-add"><input type="text" data-fc-new placeholder="Folder name (e.g. support)"><button class="btn secondary" data-fc-add>Add Folder</button></div>`;
  }

  settingsEl.addEventListener('change', e => {
    const t = /** @type {HTMLInputElement} */ (e.target);
    // Colores de carpetas: un color con nombre, o «Custom…» con el selector de color
    const fcRow = /** @type {HTMLElement} */ (t.closest('.fc-row'));
    if (fcRow && (t.matches('[data-fc-color]') || t.matches('[data-fc-hex]'))) {
      const name = fcRow.dataset.fcName || '';
      const sel = /** @type {HTMLSelectElement} */ (fcRow.querySelector('[data-fc-color]'));
      const hexEl = /** @type {HTMLInputElement} */ (fcRow.querySelector('[data-fc-hex]'));
      const value = sel.value === 'custom' ? hexEl.value : sel.value;
      setFolderColors({ ...folderColors(), [name]: value });
      renderSettings();
      return;
    }
    if (t.matches('[data-fc-new]') || t.matches('[data-bc-new]') || t.matches('[data-set-search]')) { return; }
    // Fuente: una de la lista o la de VS Code; «Custom…» muestra el campo para escribirla
    if (t.matches('[data-font-sel]')) {
      const key = t.dataset.fontSel || '';
      if (t.value === '__custom') {
        const inp = /** @type {HTMLInputElement | null} */ (t.parentElement && t.parentElement.querySelector('.font-custom'));
        const brk = t.parentElement && t.parentElement.querySelector('.font-break');
        if (brk) { brk.classList.remove('hidden'); }
        if (inp) { inp.classList.remove('hidden'); inp.focus(); inp.select(); }
        return;
      }
      if (settings) { settings[key] = t.value; }
      applyFonts();
      vscode.postMessage({ type: 'setSetting', key, value: t.value });
      renderSettings();
      return;
    }
    // Color de los tags
    if (t.matches('[data-tagc-hex]')) { setTagColor(t.value); return; }
    // Colores de ramas: uno de la paleta, o «Custom…» con el selector de color
    const bcRow = /** @type {HTMLElement} */ (t.closest('.bc-row'));
    if (bcRow) {
      const sel = /** @type {HTMLSelectElement} */ (bcRow.querySelector('[data-bc-color-sel]'));
      const hexEl = /** @type {HTMLInputElement} */ (bcRow.querySelector('[data-bc-hex]'));
      if (t === sel && sel.value === 'custom') { hexEl.classList.remove('hidden'); hexEl.focus(); try { hexEl.showPicker(); } catch { hexEl.click(); } return; }
      setBranchColor(bcRow.dataset.bcName || '', t === hexEl ? hexEl.value : sel.value);
      renderSettings();
      return;
    }
    const key = t.dataset.cfg;
    if (key) {
      let value;
      if (t.type === 'checkbox') { value = t.checked; }
      else if (t.type === 'number') {
        // Dentro de sus límites (min/max del campo): 50000 commits por página se queda en 10000
        const n = Math.round(Number(t.value));
        value = Math.min(Number(t.max || Infinity), Math.max(Number(t.min || -Infinity), Number.isFinite(n) ? n : Number(t.min || 0)));
        t.value = String(value);
      }
      else if (key === 'fontSize') { value = Math.round(Number(t.value)); }
      else if (key === 'protectedBranches') { value = t.value.split(',').map(x => x.trim()).filter(Boolean); }
      else { value = t.value; }
      vscode.postMessage({ type: 'setSetting', key, value });
      // Las fuentes se ven al momento (la extensión confirma después con «settings»)
      if (/^(code)?font(Family|Size)$/i.test(key)) { if (settings) { settings[key] = value; } applyFonts(); }
      t.blur();
      return;
    }
    if (t.dataset.ui != null) {
      const act = settingsActs[Number(t.dataset.ui)];
      if (act) { act(); }
      renderSettings();
    }
  });
  // Una explicación «i» fijada se cierra al pulsar en cualquier otro sitio o con Escape
  const unpinInfo = (keep = null) => {
    for (const w of document.querySelectorAll('.set-info-wrap.pinned')) {
      if (keep && w.contains(keep)) { continue; }
      w.classList.remove('pinned');
      w.querySelector('[data-set-info]')?.setAttribute('aria-expanded', 'false');
    }
  };
  document.addEventListener('mousedown', e => unpinInfo(/** @type {Node} */ (e.target)), true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { unpinInfo(); } }, true);
  settingsEl.addEventListener('click', e => {
    const t = /** @type {HTMLElement} */ (e.target);
    // Menú de categorías: al elegir una, se quita la búsqueda
    const pick = /** @type {HTMLElement | null} */ (t.closest('[data-tagc-pick]'));
    if (pick) { const r = pick.getBoundingClientRect(); showMenu(tagColorMenu(), r.left, r.bottom + 2); return; }
    // Flecha de una categoría: pliega o despliega sus subcategorías sin cambiar de página
    const tw = /** @type {HTMLElement | null} */ (t.closest('[data-set-toggle]'));
    if (tw && !settingsQuery) {
      const id = tw.dataset.setToggle || '';
      const closed = ui.settingsCollapsed.includes(id);
      ui.settingsCollapsed = closed ? ui.settingsCollapsed.filter(x => x !== id) : [...ui.settingsCollapsed, id];
      tw.classList.toggle('closed', !closed);
      tw.title = closed ? 'Collapse' : 'Expand';
      for (const c of settingsEl.querySelectorAll(`[data-set-parent="${id}"]`)) { c.classList.toggle('folded', !closed); }
      saveUi();
      applySettingsView();
      return;
    }
    const navItem = /** @type {HTMLElement | null} */ (t.closest('[data-set-page]'));
    if (navItem) {
      ui.settingsPage = navItem.dataset.setPage || 'general';
      saveUi();
      if (settingsQuery) { settingsQuery = ''; /** @type {HTMLInputElement} */ (settingsEl.querySelector('[data-set-search]')).value = ''; }
      applySettingsView();
      /** @type {HTMLElement} */ (settingsEl.querySelector('.set-content')).scrollTop = 0;
      return;
    }
    // Botón «i»: al pulsarlo la explicación se queda abierta (otro clic o pulsar fuera la cierra)
    const info = /** @type {HTMLElement | null} */ (t.closest('[data-set-info]'));
    if (info) {
      e.preventDefault();
      const w = /** @type {HTMLElement} */ (info.parentElement);
      const on = !w.classList.contains('pinned');
      w.classList.toggle('pinned', on);
      info.setAttribute('aria-expanded', String(on));
      return;
    }
    const pr = /** @type {HTMLElement | null} */ (t.closest('[data-page-reset]'));
    if (pr) {
      if (document.activeElement instanceof HTMLElement) { document.activeElement.blur(); }
      resetPage(pr.dataset.pageReset || '');
      renderSettings();
      return;
    }
    // Al pulsar Reset se quita el foco de un campo de texto (si no, la página no se repintaría)
    if (t.closest('[data-reset-font], [data-reset-cfg]') && document.activeElement instanceof HTMLElement) { document.activeElement.blur(); }
    const rf = /** @type {HTMLElement | null} */ (t.closest('[data-reset-font]'));
    if (rf) {
      e.preventDefault();
      for (const key of (rf.dataset.resetFont || '').split(',')) {
        if (!(key in CFG_DEFAULTS)) { continue; }
        if (settings) { settings[key] = CFG_DEFAULTS[key]; }
        vscode.postMessage({ type: 'setSetting', key, value: CFG_DEFAULTS[key] });
      }
      applyFonts();
      renderSettings();
      return;
    }
    // Reset de un ajuste jbGit.* a su valor por defecto
    const rs = /** @type {HTMLElement | null} */ (t.closest('[data-reset-cfg]'));
    if (rs) {
      e.preventDefault();
      const key = rs.dataset.resetCfg || '';
      if (key in CFG_DEFAULTS) {
        if (settings) { settings[key] = CFG_DEFAULTS[key]; }
        vscode.postMessage({ type: 'setSetting', key, value: CFG_DEFAULTS[key] });
        if (key === 'tagColor') { applyTagColor(); }
        if (key.toLowerCase().includes('font')) { applyFonts(); }
        renderSettings();
      }
      return;
    }

    const scRow = /** @type {HTMLElement | null} */ (t.closest('.sc-row'));
    if (scRow) {
      const id = scRow.dataset.sc || '';
      if (t.closest('[data-sc-rec]')) { scRecording = scRecording === id ? null : id; scNote = ''; renderSettings(); return; }
      if (t.closest('[data-sc-clear]')) { setShortcut(id, ''); scNote = ''; renderSettings(); return; }
      if (t.closest('[data-sc-reset]')) {
        const user = { ...((settings && settings.shortcuts) || {}) };
        delete user[id];
        const k = SHORTCUT_DEFAULTS[id];
        if (k) { setShortcut(id, k); } else { saveShortcuts(user); scNote = ''; }
        renderSettings();
        return;
      }
    }
    if (t.closest('[data-open-settings]')) { vscode.postMessage({ type: 'openSettings' }); return; }
    const pal = /** @type {HTMLElement | null} */ (t.closest('[data-fc-palette-pick]'));
    if (pal) { const r = pal.getBoundingClientRect(); showMenu(paletteMenu(), r.left, r.bottom + 2); return; }
    if (t.closest('[data-fc-del]')) {
      const name = /** @type {HTMLElement} */ (t.closest('.fc-row')).dataset.fcName || '';
      const map = { ...folderColors() };
      delete map[name];
      setFolderColors(map);
      renderSettings();
      return;
    }
    if (t.closest('[data-fc-add]')) { addFolderColor(); return; }
    if (t.closest('[data-bc-add]')) { addBranchColor(); return; }
    if (t.closest('[data-bc-del]')) { setBranchColor(/** @type {HTMLElement} */ (t.closest('.bc-row')).dataset.bcName || '', null); renderSettings(); return; }
    const b = /** @type {HTMLElement} */ (t.closest('button[data-ui]'));
    if (b) { const act = settingsActs[Number(b.dataset.ui)]; if (act) { act(); } renderSettings(); }
  });
  // Enter en un campo de texto o número lo guarda
  settingsEl.addEventListener('input', e => {
    const t = /** @type {HTMLInputElement} */ (e.target);
    if (t.matches('[data-set-search]')) { settingsQuery = t.value; applySettingsView(); }
    // Campos numéricos: solo cifras y nunca por encima del máximo mientras se escribe
    // (el mínimo se aplica al guardar, que si no no se podría escribir «2» para llegar a 200)
    if (t.matches('input[type=number]')) {
      const digits = t.value.replace(/\D/g, '');
      const max = Number(t.max || Infinity);
      const v = digits && Number(digits) > max ? String(max) : digits;
      if (v !== t.value) { t.value = v; }
    }
  });
  settingsEl.addEventListener('keydown', e => {
    // Las teclas que un campo numérico acepta pero no tienen sentido aquí (exponente, signo, decimales)
    if (/** @type {HTMLElement} */ (e.target).matches('input[type=number]') && ['e', 'E', '+', '-', '.', ','].includes(e.key)) { e.preventDefault(); return; }
    const t = /** @type {HTMLInputElement} */ (e.target);
    if (t.matches('[data-set-search]') && e.key === 'Escape' && t.value) { e.stopPropagation(); t.value = ''; settingsQuery = ''; applySettingsView(); return; }
    if (e.key === 'Enter' && t.matches('input[data-cfg]')) { t.dispatchEvent(new Event('change', { bubbles: true })); }
    if (e.key === 'Enter' && t.matches('[data-fc-new]')) { addFolderColor(); }
    if (e.key === 'Enter' && t.matches('[data-bc-new]')) { addBranchColor(); }
  });
  /** Añade la carpeta escrita con un color que aún no se use (o gris si ya están todos). */
  function addFolderColor() {
    const input = /** @type {HTMLInputElement} */ (settingsEl.querySelector('[data-fc-new]'));
    const name = (input.value || '').trim().toLowerCase();
    if (!name || name === '@remote') { input.focus(); return; }
    const map = folderColors();
    if (!map[name]) {
      const used = new Set(Object.values(map));
      const free = ['green', 'orange', 'purple', 'red', 'blue', 'yellow'].find(c => !used.has(c)) || 'gray';
      setFolderColors({ ...map, [name]: free });
    }
    input.value = '';
    input.blur();
    renderSettings();
  }

  // -------------------------------------------------------------------------
  // Stash: lista de stashes, sus archivos y Pop / Apply / Drop
  // -------------------------------------------------------------------------

  /** @type {any[] | null} */
  let stashes = null;
  let stashSel = null;         // id («repo:hash») del stash seleccionado
  /** @type {any} */
  let stashFiles = null;       // { hash, files, error }
  let stashFileSel = -1;
  const stashListEl = $('#stash-list');
  const stashFilesEl = $('#stash-files-tree');


  const currentStash = () => (stashes || []).find(x => x.id === stashSel) || null;

  function onStashes(m) {
    stashes = m.list;
    $('#stash-count').textContent = stashes.length ? String(stashes.length) : '';
    $('#stash-count').classList.toggle('hidden', !stashes.length);
    if (!currentStash()) { selectStash(stashes.length ? stashes[0].id : null, false); }
    renderStashes(m.error);
  }

  function selectStash(hash, render = true) {
    if (hash !== stashSel) {
      stashSel = hash;
      stashFiles = null;
      stashFileSel = -1;
      if (hash) { vscode.postMessage({ type: 'selectStash', id: hash }); }
    }
    if (render) { renderStashes(); }
  }

  function onStashFiles(m) {
    if (m.id !== stashSel) { return; }
    stashFiles = m;
    renderStashFiles();
  }

  function renderStashes(error) {
    let html = '';
    if (error) { html = `<div class="empty error">${esc(error)}</div>`; }
    if (stashes && !stashes.length && !error) { html = '<div class="empty">No stashes. Use <em>Stash Changes</em> to save your local changes for later.</div>'; }
    for (const st of stashes || []) {
      // Con varios repos, el repo va delante de la rama
      const hint = [data && data.multi ? repoName(st.repo) : '', st.branch, formatDate(st.time)].filter(Boolean).join(' · ');
      html += `<div class="tnode${st.id === stashSel ? ' selected' : ''}" data-stash="${esc(st.id)}" data-pad="8" title="${esc(st.ref)}: ${esc(st.message)}">` +
        `<span class="ico-folder">${ICON.stash}</span><span class="label">${esc(st.message)}</span><span class="hint">${esc(hint)}</span></div>`;
    }
    stashListEl.innerHTML = html;
    applyPositions(stashListEl);
    updateActionBar();
    renderStashFiles();
  }

  function renderStashFiles() {
    const cur = currentStash();
    $('#stash-files-title').textContent = cur ? `${data && data.multi ? repoName(cur.repo) + ' · ' : ''}${cur.ref} — ${cur.message}` : 'Files';
    let html = '';
    stashFolders = new Map();
    if (!cur) { html = ''; }
    else if (!stashFiles) { html = '<div class="empty">Loading…</div>'; }
    else if (stashFiles.error) { html = `<div class="empty error">${esc(stashFiles.error)}</div>`; }
    else {
      const rows = stashFiles.files.map((f, i) => ({ ...f, i, repo: cur.repo }));
      html = fileTreeRows(rows, 0, 'stf:', ui.stashGroupBy, (f, depth, showDir) => {
        const st = f.untracked ? 'Q' : f.status;
        const slash = f.path.lastIndexOf('/');
        const dir = showDir && slash >= 0 ? f.path.slice(0, slash) : '';
        const hint = f.oldPath ? `← ${f.oldPath}` : [dir, f.untracked ? 'unversioned' : ''].filter(Boolean).join(' · ');
        return `<div class="tnode${f.i === stashFileSel ? ' selected' : ''}" data-sf="${f.i}" data-pad="${6 + depth * 14}" title="${esc(f.path)}">` +
          `<span class="twisty"></span><span class="st-${st}">${ICON.file}</span><span class="label st-${st}">${esc(f.path.slice(slash + 1))}</span>${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</div>`;
      }, stashFolders);
    }
    stashFilesEl.innerHTML = html;
    applyPositions(stashFilesEl);
  }

  const stashAction = (action, st) => vscode.postMessage({ type: 'stashAction', action, ref: st ? st.ref : '', id: st ? st.id : '' });
  const openStashDiff = i => { if (stashFiles && stashFiles.files[i]) { vscode.postMessage({ type: 'openStashDiff', id: stashFiles.id, file: stashFiles.files[i] }); } };

  /** Botones de la barra izquierda en Stash: recargar, Unstash (pop) y borrar. */
  function stashActionState(act) {
    const cur = currentStash();
    switch (act) {
      case 'stRefresh': return { title: 'Refresh', on: true, msg: { type: 'refresh' } };
      case 'stView': return { title: 'View Options', on: true, run: () => openViewMenu('stash', 'stView') };
      case 'stUnstash': return { title: cur ? `Unstash '${cur.message}' (Pop)` : 'Unstash (Pop)', on: !!cur, run: () => stashAction('pop', cur) };
      case 'stDrop': return { title: cur ? `Drop '${cur.message}'…` : 'Drop Stash…', on: !!cur, run: () => stashAction('drop', cur) };
    }
    return { title: act, on: false };
  }

  function stashMenu(st) {
    return [
      { label: 'Pop', sc: 'stash.pop', act: () => stashAction('pop', st) },
      { label: 'Apply', sc: 'stash.apply', act: () => stashAction('apply', st) },
      { label: 'Drop…', sc: 'stash.drop', act: () => stashAction('drop', st) },
      { sep: true },
      { label: 'Copy Message', sc: 'stash.copyMessage', act: () => navigator.clipboard.writeText(st.message) },
      { sep: true },
      { label: 'Clear All Stashes…', sc: 'stash.clear', act: () => stashAction('clear', null) },
    ];
  }

  stashListEl.addEventListener('click', e => {
    const n = /** @type {HTMLElement} */ (e.target).closest('.tnode[data-stash]');
    if (n) { selectStash(n.getAttribute('data-stash')); }
  });
  stashListEl.addEventListener('contextmenu', e => {
    e.preventDefault();
    const n = /** @type {HTMLElement} */ (e.target).closest('.tnode[data-stash]');
    if (!n) { return; }
    selectStash(n.getAttribute('data-stash'));
    const cur = currentStash();
    if (cur) { showMenu(stashMenu(cur), e.clientX, e.clientY); }
  });
  stashListEl.addEventListener('keydown', e => {
    const list = stashes || [];
    const i = list.findIndex(x => x.id === stashSel);
    if (runShortcut(e, 'stash', () => (list[i] ? stashMenu(list[i]) : []))) { return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = list[Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) {
        selectStash(next.id);
        const el = stashListEl.querySelector('.tnode.selected');
        if (el) { el.scrollIntoView({ block: 'nearest' }); }
      }
    } else if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      e.preventDefault();
      const el = stashListEl.querySelector('.tnode.selected');
      if (el && list[i]) { const r = el.getBoundingClientRect(); showMenu(stashMenu(list[i]), r.left + 40, r.bottom); }
    }
  });

  stashFilesEl.addEventListener('click', e => {
    const f = /** @type {HTMLElement} */ (e.target).closest('.tnode[data-fold]');
    if (f) { toggleFold(f.getAttribute('data-fold')); renderStashFiles(); return; }
    const n = /** @type {HTMLElement} */ (e.target).closest('.tnode[data-sf]');
    if (!n) { return; }
    stashFileSel = Number(n.getAttribute('data-sf'));
    renderStashFiles();
  });
  stashFilesEl.addEventListener('dblclick', e => {
    const n = /** @type {HTMLElement} */ (e.target).closest('.tnode[data-sf]');
    if (n) { openStashDiff(Number(n.getAttribute('data-sf'))); }
  });
  stashFilesEl.addEventListener('keydown', e => {
    if (runShortcut(e, 'stashFiles', () => (stashFiles && stashFiles.files && stashFiles.files[stashFileSel] ? stashFileMenu() : []))) { return; }
    if (e.key === 'Enter' && stashFileSel >= 0) { openStashDiff(stashFileSel); }
  });
  stashFilesEl.addEventListener('contextmenu', e => {
    e.preventDefault();
    const n = /** @type {HTMLElement} */ (e.target).closest('.tnode[data-sf]');
    if (!n || !stashFiles) { return; }
    stashFileSel = Number(n.getAttribute('data-sf'));
    renderStashFiles();
    showMenu(stashFileMenu(), e.clientX, e.clientY);
  });
  function stashFileMenu() {
    const f = stashFiles.files[stashFileSel];
    return [
      { label: 'Show Diff', sc: 'stashFiles.showDiff', key: 'Double-click', act: () => openStashDiff(stashFileSel) },
      { label: 'Copy Path', sc: 'stashFiles.copyPath', act: () => navigator.clipboard.writeText(f.path) },
    ];
  }


  // -------------------------------------------------------------------------
  // Teclado en los árboles (ramas, archivos del commit, Local Changes, archivos del stash)
  // -------------------------------------------------------------------------

  const FOLDER_SEL = '[data-folder], [data-fkey], [data-fold], [data-group]';
  const ID_ATTRS = ['data-key', 'data-fkey', 'data-fold', 'data-group', 'data-ck', 'data-sf', 'data-file'];
  const nodeId = n => { for (const a of ID_ATTRS) { if (n.hasAttribute(a)) { return a + '=' + n.getAttribute(a); } } return ''; };

  /**
   * Flechas como en JetBrains: ↑/↓ recorren las filas visibles (también las carpetas), → abre
   * una carpeta o entra en ella, ← la cierra o sube a la carpeta padre, Inicio/Fin van al
   * principio o al final. Un archivo o rama se selecciona simulando su clic (cada árbol ya
   * sabe qué hacer: vista previa, detalles…; con Shift amplía la selección donde se admite).
   * Una carpeta solo se marca (kb-cursor), sin plegarla; el marcador sobrevive a los repintados.
   */
  function keyNav(el, opts = {}) {
    let cursor = '';    // id de la fila con el cursor del teclado, si es una carpeta
    const rows = () => [...el.querySelectorAll('.tnode')].filter(n => nodeId(n) && n.offsetParent !== null);
    const mark = () => {
      el.classList.toggle('kb-folder', !!cursor);
      for (const n of el.querySelectorAll('.kb-cursor')) { n.classList.remove('kb-cursor'); }
      if (!cursor) { return; }
      const n = rows().find(x => nodeId(x) === cursor);
      if (n) { n.classList.add('kb-cursor'); } else { cursor = ''; el.classList.remove('kb-folder'); }
    };
    new MutationObserver(mark).observe(el, { childList: true });
    el.addEventListener('mousedown', () => { cursor = ''; mark(); });
    const current = list => {
      if (cursor) { const i = list.findIndex(x => nodeId(x) === cursor); if (i >= 0) { return i; } }
      const sel = list.filter(x => x.classList.contains('selected'));
      return sel.length ? list.indexOf(sel[sel.length - 1]) : -1;
    };
    const go = (n, e) => {
      if (!n) { return; }
      if (n.matches(FOLDER_SEL)) {
        cursor = nodeId(n);
        mark();
      } else {
        cursor = '';
        mark();
        n.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: !!(opts.shift && e.shiftKey) }));
      }
      const now = rows().find(x => nodeId(x) === nodeId(n)) || n;
      now.scrollIntoView({ block: 'nearest' });
    };
    const toggle = n => { n.dispatchEvent(new MouseEvent('click', { bubbles: true })); mark(); };
    const depth = n => Number(n.getAttribute('data-pad') || 0);
    el.addEventListener('keydown', e => {
      if (e.ctrlKey || e.metaKey || e.altKey) { return; }
      const list = rows();
      if (!list.length) { return; }
      const i = current(list);
      const n = list[i];
      const isFolder = !!n && n.matches(FOLDER_SEL);
      const open = isFolder && !!n.querySelector('.twisty.open');
      switch (e.key) {
        case 'ArrowDown': go(list[Math.min(list.length - 1, i + 1)], e); break;
        case 'ArrowUp': go(list[Math.max(0, i < 0 ? 0 : i - 1)], e); break;
        case 'Home': go(list[0], e); break;
        case 'End': go(list[list.length - 1], e); break;
        case 'ArrowRight':
          if (!isFolder) { return; }
          if (!open) { cursor = nodeId(n); toggle(n); } else { go(list[i + 1], e); }
          break;
        case 'ArrowLeft': {
          if (!n) { return; }
          if (open) { cursor = nodeId(n); toggle(n); break; }
          // Sube a la carpeta que lo contiene (la fila anterior con menos sangría)
          for (let j = i - 1; j >= 0; j--) { if (depth(list[j]) < depth(n) && list[j].matches(FOLDER_SEL)) { go(list[j], e); break; } }
          break;
        }
        case 'Enter':
          if (isFolder) { cursor = nodeId(n); toggle(n); break; }
          if (opts.enter && n) { opts.enter(n); break; }
          return;
        default: return;
      }
      e.preventDefault();
    });
  }
  treeEl.addEventListener('keydown', e => {
    runShortcut(e, 'branches', () => {
      if (!data) { return []; }
      const sels = selectedRefs();
      if (sels.length > 1) { return multiBranchMenu(sels); }
      if (sels.length === 1) { return sels[0].type === 'tag' ? tagMenu(sels[0], true) : branchMenu(sels[0], true); }
      // HEAD: solo se puede copiar el nombre de la rama actual
      return selectedTreeKeys.has('HEAD') ? [{ sc: 'branches.copyName', act: copyBranchNames }] : [];
    });
  });
  keyNav(treeEl, { shift: true, enter: n => n.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) });
  keyNav(filesEl);
  keyNav(changesTreeEl, { shift: true });
  keyNav(stashFilesEl);

  // -------------------------------------------------------------------------
  // Layout: splitters y ocultar panel de ramas
  // -------------------------------------------------------------------------

  /**
   * Ancho mínimo de la lista de Local Changes: lo justo para que Amend, Commit y Commit and
   * Push quepan en una línea sin tocarse. Depende de la fuente, así que se mide; con la pestaña
   * oculta todo mide 0 y devuelve 0 (switchTab('changes') vuelve a aplicarlo).
   */
  function changesMinWidth() {
    const row = /** @type {HTMLElement | null} */ (commitBoxEl.querySelector('.commit-actions'));
    if (!row || !row.offsetParent) { return 0; }
    const kids = /** @type {HTMLElement[]} */ ([...row.children]).filter(k => !k.classList.contains('spacer'));
    const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
    const box = getComputedStyle(commitBoxEl);
    // n elementos + el hueco flexible = n huecos entre ellos
    return Math.ceil(kids.reduce((s, k) => s + k.getBoundingClientRect().width, 0) + gap * kids.length +
      parseFloat(box.paddingLeft) + parseFloat(box.paddingRight)) + 2;
  }
  function applyChangesWidth() {
    $('#changes').style.width = `${Math.max(ui.changesWidth, changesMinWidth())}px`;
  }

  function applyLayout() {
    branchesEl.style.width = `${ui.branchesWidth}px`;
    detailsEl.style.width = `${ui.detailsWidth}px`;
    applyChangesWidth();
    commitBoxEl.style.height = `${ui.commitHeight}px`;
    $('#stash-files').style.width = `${ui.stashFilesWidth}px`;
    branchesEl.classList.toggle('hidden', ui.branchesHidden);
    /** @type {HTMLElement} */ (document.querySelector('.splitter[data-target="branches"]')).classList.toggle('hidden', ui.branchesHidden);
    $('#btn-expand').classList.toggle('hidden', !ui.branchesHidden);
    filesEl.style.flex = `0 0 ${Math.round(ui.filesRatio * 100)}%`;
    infoEl.style.flex = '1 1 auto';
    applyLogView();
  }

  $('#btn-collapse').addEventListener('click', () => { ui.branchesHidden = true; applyLayout(); saveUi(); });
  $('#btn-expand').addEventListener('click', () => { ui.branchesHidden = false; applyLayout(); saveUi(); });

  document.querySelectorAll('.splitter').forEach(sp => {
    const s = /** @type {HTMLElement} */ (sp);
    s.addEventListener('mousedown', e => {
      e.preventDefault();
      const isRight = s.dataset.side === 'right';
      const startX = e.clientX;
      const target = s.dataset.target;
      const key = target === 'changes' ? 'changesWidth' : target === 'stash-files' ? 'stashFilesWidth' : isRight ? 'detailsWidth' : 'branchesWidth';
      const startW = ui[key];
      s.classList.add('dragging');
      const move = ev => {
        const dx = ev.clientX - startX;
        // Local Changes no baja de lo que ocupan Amend y los botones de commit (manda sobre el 60 %)
        const min = target === 'changes' ? Math.max(140, changesMinWidth()) : 140;
        const w = Math.max(min, Math.min(window.innerWidth * 0.6, isRight ? startW - dx : startW + dx));
        ui[key] = w;
        applyLayout();
      };
      const up = () => {
        s.classList.remove('dragging');
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        saveUi();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  });

  const hs = /** @type {HTMLElement} */ (document.querySelector('#details .hsplitter'));
  hs.addEventListener('mousedown', e => {
    e.preventDefault();
    const rect = detailsEl.getBoundingClientRect();
    hs.classList.add('dragging');
    const move = ev => {
      ui.filesRatio = Math.max(0.15, Math.min(0.85, (ev.clientY - rect.top) / rect.height));
      applyLayout();
    };
    const up = () => {
      hs.classList.remove('dragging');
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      saveUi();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  // Separador entre la lista de cambios y la caja de commit (alto de la caja)
  const cs = $('#commit-split');
  cs.addEventListener('mousedown', e => {
    e.preventDefault();
    const rect = $('#changes').getBoundingClientRect();
    cs.classList.add('dragging');
    const move = ev => {
      ui.commitHeight = Math.max(90, Math.min(rect.height - 60, rect.bottom - ev.clientY));
      applyLayout();
    };
    const up = () => {
      cs.classList.remove('dragging');
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      saveUi();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  applyLayout();
  switchTab(ui.tab);
  renderChanges();
  renderStashes();
  vscode.postMessage({ type: 'ready' });
})();
