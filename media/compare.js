// @ts-check
// Pestaña de comparación (ComparePanel en src/compare.ts): lista de archivos a la izquierda
// y visor lado a lado a la derecha, como JetBrains. Sin style="" (CSP): todo por CSSOM.
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  // Iconos de archivos del tema de iconos de VS Code (fileicons.js); sin tema, la lista queda sin iconos
  const jbFileIcons = /** @type {any} */ (window).jbFileIcons || { html: () => '', apply() { /* nada */ }, setTheme() { /* nada */ } };
  // Fuentes de Settings ▸ Fonts (atributos data-* del <body>; sin ellos, las de VS Code)
  (() => {
    const d = document.body.dataset, r = document.documentElement.style;
    if (d.font) { r.setProperty('--jb-font', d.font); }
    if (d.fontSize) { r.setProperty('--jb-font-size', `${d.fontSize}px`); }
  })();
  const saved = vscode.getState() || {};
  const ROW_H = 18;
  const MAX_ROWS = 300000;

  const $ = (/** @type {string} */ s) => /** @type {HTMLElement} */ (document.querySelector(s));
  const listEl = $('#cmp-list');
  const searchEl = /** @type {HTMLInputElement} */ ($('#cmp-search'));
  const filesPane = $('#cmp-files');
  const leftEl = $('#cmp-left');
  const rightEl = $('#cmp-right');
  const leftInner = /** @type {HTMLElement} */ (leftEl.firstElementChild);
  const rightInner = /** @type {HTMLElement} */ (rightEl.firstElementChild);

  const ICON = {
    refresh: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.5v3h-3"/></svg>',
    up: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M4 7l4-4 4 4"/></svg>',
    down: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v10M4 9l4 4 4-4"/></svg>',
    native: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M8 2.5v11"/><path d="M3.5 6h2.5M10 6h2.5M11.25 4.75v2.5M3.5 10h2.5" stroke-linecap="round"/></svg>',
  };
  $('#cmp-refresh').innerHTML = ICON.refresh;
  $('#cmp-hist-refresh').innerHTML = ICON.refresh;
  $('#cmp-prev').innerHTML = ICON.up;
  $('#cmp-next').innerHTML = ICON.down;
  $('#cmp-native').innerHTML = ICON.native;

  /** @type {{status: string, path: string, oldPath?: string}[]} */
  let files = [];
  let loaded = false;   // ya ha llegado la lista de archivos (antes, «No differences» sería un parpadeo)
  let selected = -1;
  let filter = '';
  /** Filas del visor: { k: ''|'add'|'del'|'mod', l, r (números), lt, rt (texto) } */
  let rows = [];
  let blocks = [];          // índice de la primera fila de cada bloque de cambios
  let message = '';         // mensaje en lugar del diff (binario, sin cambios…)
  let charW = 7.2;

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const base = p => p.slice(p.lastIndexOf('/') + 1);
  const dir = p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

  // ----- lista de archivos -----------------------------------------------------------

  function visibleFiles() {
    const q = filter.toLowerCase();
    return files.map((f, i) => ({ f, i })).filter(({ f }) => !q || f.path.toLowerCase().includes(q) || (f.oldPath || '').toLowerCase().includes(q));
  }

  function renderList() {
    const vis = visibleFiles();
    if (!files.length) { listEl.innerHTML = '<div class="empty">No differences.</div>'; return; }
    if (!vis.length) { listEl.innerHTML = '<div class="empty">No matching files.</div>'; return; }
    listEl.innerHTML = vis.map(({ f, i }) =>
      `<div class="fi${i === selected ? ' selected' : ''}" data-i="${i}" role="option" title="${esc(f.oldPath ? `${f.oldPath} → ${f.path}` : f.path)}">` +
      `<span class="st st-${esc(f.status[0])}">${esc(f.status[0])}</span>` +
      jbFileIcons.html(f.path, false) +
      `<span class="fname">${esc(base(f.path))}</span>` +
      `<span class="fdir">${esc([dir(f.path), f.oldPath ? `← ${f.oldPath}` : ''].filter(Boolean).join('  '))}</span></div>`).join('');
    jbFileIcons.apply(listEl);
  }

  function select(i) {
    if (i < 0 || i >= files.length) { return; }
    selected = i;
    for (const el of listEl.querySelectorAll('.fi')) { el.classList.toggle('selected', Number(/** @type {HTMLElement} */ (el).dataset.i) === i); }
    const cur = listEl.querySelector('.fi.selected');
    if (cur) { /** @type {HTMLElement} */ (cur).scrollIntoView({ block: 'nearest' }); }
    const f = files[i];
    $('#cmp-file').textContent = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
    $('#cmp-stats').textContent = '';
    rows = []; blocks = []; message = 'Loading…';
    renderDiff(true);
    vscode.postMessage({ type: 'selectFile', index: i });
  }

  listEl.addEventListener('click', e => {
    const fi = /** @type {HTMLElement} */ (e.target).closest('.fi');
    if (fi) { select(Number(/** @type {HTMLElement} */ (fi).dataset.i)); listEl.focus(); }
  });
  listEl.addEventListener('dblclick', e => {
    const fi = /** @type {HTMLElement} */ (e.target).closest('.fi');
    if (fi) { vscode.postMessage({ type: 'openNative', index: Number(/** @type {HTMLElement} */ (fi).dataset.i) }); }
  });
  listEl.addEventListener('keydown', e => {
    const vis = visibleFiles().map(x => x.i);
    if (!vis.length) { return; }
    const pos = vis.indexOf(selected);
    let next = -1;
    if (e.key === 'ArrowDown') { next = vis[Math.min(vis.length - 1, pos + 1)]; }
    else if (e.key === 'ArrowUp') { next = vis[Math.max(0, pos - 1)]; }
    else if (e.key === 'Home') { next = vis[0]; }
    else if (e.key === 'End') { next = vis[vis.length - 1]; }
    else if (e.key === 'Enter' && selected >= 0) { vscode.postMessage({ type: 'openNative', index: selected }); e.preventDefault(); return; }
    else { return; }
    e.preventDefault();
    if (next !== selected) { select(next); }
  });
  searchEl.addEventListener('input', () => { filter = searchEl.value; renderList(); });
  searchEl.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'Enter') {
      const vis = visibleFiles();
      if (vis.length) { select(vis[0].i); listEl.focus(); e.preventDefault(); }
    }
  });
  $('#cmp-refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  $('#cmp-native').addEventListener('click', () => { if (selected >= 0) { vscode.postMessage({ type: 'openNative', index: selected }); } });

  // ----- historial (Show History): lista de commits ------------------------------------

  const histPane = $('#cmp-commits');
  const histList = $('#cmp-hist-list');
  const histSearch = /** @type {HTMLInputElement} */ ($('#cmp-hist-search'));
  /** @type {{sha: string, subject: string, author: string, time: number, status: string, path: string, oldPath?: string}[]} */
  let commits = [];
  let commitSel = -1;
  let histFilter = '';
  let historyMode = false;
  let historyFolder = false;
  let historyPath = '';

  function formatDate(t) {
    const d = new Date(t * 1000);
    return `${d.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' })}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
  }
  function visibleCommits() {
    const q = histFilter.trim().toLowerCase();
    return commits.map((c, i) => ({ c, i })).filter(({ c }) => !q || c.sha.startsWith(q) || c.subject.toLowerCase().includes(q) || c.author.toLowerCase().includes(q));
  }
  function renderCommits() {
    if (!commits.length) { histList.innerHTML = '<div class="empty">No commits touch this path.</div>'; return; }
    const vis = visibleCommits();
    if (!vis.length) { histList.innerHTML = '<div class="empty">No matching commits.</div>'; return; }
    histList.innerHTML = vis.map(({ c, i }) => {
      // En un archivo, se avisa cuando en ese commit tenía otra ruta o se renombró
      const renamed = !historyFolder && c.oldPath ? `<span class="ci-path" title="${esc(c.oldPath)} → ${esc(c.path)}">renamed from ${esc(base(c.oldPath))}</span>`
        : !historyFolder && c.path !== historyPath ? `<span class="ci-path" title="${esc(c.path)}">${esc(c.path)}</span>` : '';
      return `<div class="ci${i === commitSel ? ' selected' : ''}" data-i="${i}" role="option">` +
        `<div class="ci-sub" title="${esc(c.subject)}">${!historyFolder && c.status && c.status !== 'M' ? `<span class="st st-${esc(c.status)}">${esc(c.status)}</span>` : ''}${esc(c.subject)}</div>` +
        `<div class="ci-meta"><span>${esc(c.author)}</span><span>${esc(formatDate(c.time))}</span><span class="ci-hash">${esc(c.sha.slice(0, 8))}</span>${renamed}</div></div>`;
    }).join('');
  }
  function selectCommit(i) {
    if (i < 0 || i >= commits.length) { return; }
    commitSel = i;
    for (const el of histList.querySelectorAll('.ci')) { el.classList.toggle('selected', Number(/** @type {HTMLElement} */ (el).dataset.i) === i); }
    const cur = histList.querySelector('.ci.selected');
    if (cur) { /** @type {HTMLElement} */ (cur).scrollIntoView({ block: 'nearest' }); }
    rows = []; blocks = []; message = 'Loading…';
    renderDiff(true);
    vscode.postMessage({ type: 'selectCommit', index: i });
  }
  histList.addEventListener('click', e => {
    const ci = /** @type {HTMLElement} */ (e.target).closest('.ci');
    if (ci) { selectCommit(Number(/** @type {HTMLElement} */ (ci).dataset.i)); histList.focus(); }
  });
  histList.addEventListener('dblclick', e => {
    if (/** @type {HTMLElement} */ (e.target).closest('.ci') && selected >= 0) { vscode.postMessage({ type: 'openNative', index: selected }); }
  });
  histList.addEventListener('keydown', e => {
    const vis = visibleCommits().map(x => x.i);
    if (!vis.length) { return; }
    const pos = vis.indexOf(commitSel);
    const page = Math.max(1, Math.floor(histList.clientHeight / 40) - 1);
    let next = -1;
    if (e.key === 'ArrowDown') { next = vis[Math.min(vis.length - 1, pos + 1)]; }
    else if (e.key === 'ArrowUp') { next = vis[Math.max(0, pos - 1)]; }
    else if (e.key === 'PageDown') { next = vis[Math.min(vis.length - 1, pos + page)]; }
    else if (e.key === 'PageUp') { next = vis[Math.max(0, pos - page)]; }
    else if (e.key === 'Home') { next = vis[0]; }
    else if (e.key === 'End') { next = vis[vis.length - 1]; }
    else if (e.key === 'Enter' && selected >= 0) { vscode.postMessage({ type: 'openNative', index: selected }); e.preventDefault(); return; }
    else if (e.key === 'ArrowRight' && historyFolder) { listEl.focus(); e.preventDefault(); return; }
    else { return; }
    e.preventDefault();
    if (next !== commitSel) { selectCommit(next); }
  });
  histSearch.addEventListener('input', () => { histFilter = histSearch.value; renderCommits(); });
  histSearch.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'Enter') {
      const vis = visibleCommits();
      if (vis.length) { selectCommit(vis[0].i); histList.focus(); e.preventDefault(); }
    }
  });
  $('#cmp-hist-refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

  /** Mensaje history: se pasa al modo historial (en un archivo, sin la lista de archivos). */
  function onHistory(m) {
    historyMode = true;
    historyFolder = !!m.folder;
    historyPath = m.path;
    const keep = commitSel >= 0 && commits[commitSel] ? commits[commitSel].sha : null;
    commits = m.commits || [];
    histPane.classList.remove('hidden');
    $('#cmp-hist-split').classList.remove('hidden');
    filesPane.classList.toggle('hidden', !historyFolder);
    $('#cmp-split').classList.toggle('hidden', !historyFolder);
    $('#cmp-hist-title').textContent = `${m.path === '.' ? 'Repository' : m.path} · ${commits.length}${commits.length >= 2000 ? '+' : ''} commit${commits.length === 1 ? '' : 's'}`;
    $('#cmp-hist-title').setAttribute('title', m.title);
    commitSel = -1;
    renderCommits();
    if (m.error) { histList.innerHTML = `<div class="empty error">${esc(m.error)}</div>`; return; }
    const again = keep ? commits.findIndex(c => c.sha === keep) : -1;
    if (commits.length) { selectCommit(again >= 0 ? again : 0); histList.focus(); }
    else { files = []; renderList(); rows = []; message = 'No history.'; renderDiff(true); }
  }

  // ----- visor lado a lado -------------------------------------------------------------

  /** Convierte el diff unificado (con todo el contexto) en filas emparejadas izquierda/derecha. */
  function parseDiff(text) {
    const out = [];
    const bl = [];
    let o = 0, n = 0, inHunk = false, header = '';
    let dels = [], adds = [];
    const flush = () => {
      if (!dels.length && !adds.length) { return; }
      bl.push(out.length);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
        const d = dels[k], a = adds[k];
        out.push({ k: d && a ? 'mod' : d ? 'del' : 'add', l: d ? d.n : '', r: a ? a.n : '', lt: d ? d.t : null, rt: a ? a.t : null });
      }
      dels = []; adds = [];
    };
    for (const l of text.split('\n')) {
      if (out.length >= MAX_ROWS) { break; }
      if (l.startsWith('@@')) {
        flush();
        const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l);
        if (m) { o = Number(m[1]); n = Number(m[2]); }
        if (inHunk) { out.push({ k: 'gap', l: '', r: '', lt: '', rt: '' }); }
        inHunk = true;
        continue;
      }
      if (!inHunk) { header += l + '\n'; continue; }
      if (l.startsWith('\\')) { continue; }
      const t = l[0], code = l.slice(1);
      if (t === '-') { if (adds.length) { flush(); } dels.push({ n: o++, t: code }); }
      else if (t === '+') { adds.push({ n: n++, t: code }); }
      else if (t === ' ') { flush(); out.push({ k: '', l: o++, r: n++, lt: code, rt: code }); }
    }
    flush();
    let msg = '';
    if (!out.length) {
      msg = /^Binary files/m.test(header) ? 'Binary file changed.'
        : /^rename from/m.test(header) ? 'Renamed without content changes.'
        : /^(old|new) mode/m.test(header) ? 'Only the file mode changed.'
        : 'No content changes.';
    }
    return { out, bl, msg };
  }

  /** Resalta dentro de una línea modificada la parte que cambia (entre el prefijo y el sufijo comunes). */
  function intra(a, b) {
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) { p++; }
    let s = 0;
    while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) { s++; }
    // Si apenas se parecen (menos del 40 % común), la línea entera ha cambiado: sin resaltar
    const longest = Math.max(a.length, b.length);
    if (!longest || (p + s) / longest < 0.4) { return [esc(a), esc(b)]; }
    const mark = (t) => p === 0 && s === 0 ? esc(t)
      : `${esc(t.slice(0, p))}<span class="ch">${esc(t.slice(p, t.length - s))}</span>${esc(t.slice(t.length - s))}`;
    return [mark(a), mark(b)];
  }

  function rowHtml(r, i, side) {
    const num = side === 'l' ? r.l : r.r;
    const txt = side === 'l' ? r.lt : r.rt;
    if (r.k === 'gap') { return `<div class="cl gap" data-top="${i * ROW_H}"></div>`; }
    if (txt === null) { return `<div class="cl filler" data-top="${i * ROW_H}"><span class="ln"></span><span class="code"></span></div>`; }
    let code = esc(txt);
    if (r.k === 'mod') { code = intra(r.lt, r.rt)[side === 'l' ? 0 : 1]; }
    const cls = r.k === 'mod' ? 'mod' : r.k === 'del' ? (side === 'l' ? 'del' : '') : r.k === 'add' ? (side === 'r' ? 'add' : '') : '';
    return `<div class="cl ${cls}" data-top="${i * ROW_H}"><span class="ln">${num}</span><span class="code">${code || ' '}</span></div>`;
  }

  function renderDiff(reset = false) {
    if (reset) { leftEl.scrollTop = 0; rightEl.scrollTop = 0; leftEl.scrollLeft = 0; rightEl.scrollLeft = 0; }
    if (message && !rows.length) {
      leftInner.innerHTML = `<div class="empty">${esc(message)}</div>`;
      rightInner.innerHTML = '';
      leftInner.style.height = rightInner.style.height = 'auto';
      return;
    }
    const total = rows.length;
    leftInner.style.height = rightInner.style.height = `${total * ROW_H}px`;
    const top = leftEl.scrollTop;
    const h = leftEl.clientHeight || 600;
    const start = Math.max(0, Math.floor(top / ROW_H) - 20);
    const end = Math.min(total, Math.ceil((top + h) / ROW_H) + 20);
    let lh = '', rh = '';
    for (let i = start; i < end; i++) { lh += rowHtml(rows[i], i, 'l'); rh += rowHtml(rows[i], i, 'r'); }
    leftInner.innerHTML = lh;
    rightInner.innerHTML = rh;
    for (const el of [...leftInner.children, ...rightInner.children]) {
      /** @type {HTMLElement} */ (el).style.top = `${/** @type {HTMLElement} */ (el).dataset.top}px`;
    }
  }

  /** Ancho del texto más largo de cada lado (para el scroll horizontal, con filas virtualizadas). */
  function applyWidths() {
    let lw = 0, rw = 0;
    for (const r of rows) {
      if (r.lt && r.lt.length > lw) { lw = r.lt.length; }
      if (r.rt && r.rt.length > rw) { rw = r.rt.length; }
    }
    const digits = String(rows.length ? Math.max(...rows.slice(-50).map(r => Number(r.l) || 0), ...rows.slice(-50).map(r => Number(r.r) || 0)) : 1).length;
    document.body.style.setProperty('--ln-w', `${Math.max(3, digits) + 1}ch`);
    leftInner.style.minWidth = `calc(${Math.ceil(lw * charW) + 20}px + var(--ln-w) + 16px)`;
    rightInner.style.minWidth = `calc(${Math.ceil(rw * charW) + 20}px + var(--ln-w) + 16px)`;
  }

  // Desplazamiento vertical sincronizado entre los dos lados
  let syncing = false;
  for (const [a, b] of [[leftEl, rightEl], [rightEl, leftEl]]) {
    a.addEventListener('scroll', () => {
      if (syncing) { return; }
      syncing = true;
      b.scrollTop = a.scrollTop;
      syncing = false;
      requestAnimationFrame(() => renderDiff());
    });
  }
  new ResizeObserver(() => renderDiff()).observe(leftEl);

  /** Salta al bloque de cambios anterior o siguiente (F7 / Shift+F7, como JetBrains). */
  function jump(dir) {
    if (!blocks.length) { return; }
    const cur = Math.floor((leftEl.scrollTop + leftEl.clientHeight / 3) / ROW_H);
    let target = dir > 0 ? blocks.find(b => b > cur) : [...blocks].reverse().find(b => b < cur - 1);
    if (target === undefined) {
      // Al llegar al final de un archivo, pasa al siguiente (y al revés)
      const vis = visibleFiles().map(x => x.i);
      const pos = vis.indexOf(selected);
      const next = vis[pos + dir];
      if (next !== undefined) { pendingJump = dir; select(next); }
      return;
    }
    leftEl.scrollTop = Math.max(0, target * ROW_H - leftEl.clientHeight / 3);
  }
  let pendingJump = 0;
  $('#cmp-prev').addEventListener('click', () => jump(-1));
  $('#cmp-next').addEventListener('click', () => jump(1));
  document.addEventListener('keydown', e => {
    if (e.key === 'F7') { e.preventDefault(); jump(e.shiftKey ? -1 : 1); }
  });

  // ----- separador arrastrable ---------------------------------------------------------

  let filesWidth = saved.filesWidth || 320;
  let commitsWidth = saved.commitsWidth || 380;
  const applyLayout = () => { filesPane.style.width = `${filesWidth}px`; histPane.style.width = `${commitsWidth}px`; };
  applyLayout();
  $('#cmp-split').addEventListener('mousedown', e => {
    e.preventDefault();
    const startX = e.clientX, startW = filesWidth;
    const move = (/** @type {MouseEvent} */ ev) => { filesWidth = Math.max(160, Math.min(window.innerWidth - 240, startW + ev.clientX - startX)); applyLayout(); };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); vscode.setState({ ...saved, filesWidth, commitsWidth }); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  $('#cmp-hist-split').addEventListener('mousedown', e => {
    e.preventDefault();
    const startX = e.clientX, startW = commitsWidth;
    const move = (/** @type {MouseEvent} */ ev) => { commitsWidth = Math.max(200, Math.min(window.innerWidth - 300, startW + ev.clientX - startX)); applyLayout(); };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); vscode.setState({ ...saved, filesWidth, commitsWidth }); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  // ----- mensajes ----------------------------------------------------------------------

  window.addEventListener('message', ev => {
    const m = ev.data;
    if (m.type === 'history') { onHistory(m); return; }
    if (m.type === 'iconTheme') { jbFileIcons.setTheme(m.theme); if (loaded) { renderList(); } return; }
    if (m.type === 'init') {
      // En el historial, solo vale la respuesta del commit elegido
      if (historyMode && m.commit !== commitSel) { return; }
      const keep = selected >= 0 && files[selected] ? files[selected].path : null;
      files = m.files || [];
      loaded = true;
      $('#cmp-title').textContent = `${files.length} file${files.length === 1 ? '' : 's'}`;
      $('#cmp-title').setAttribute('title', m.title);
      $('#cmp-left-name').textContent = m.left;
      $('#cmp-right-name').textContent = m.right;
      selected = -1;
      renderList();
      if (m.error) { listEl.innerHTML = `<div class="empty error">${esc(m.error)}</div>`; return; }
      const again = keep ? files.findIndex(f => f.path === keep) : -1;
      if (files.length) { select(again >= 0 ? again : 0); }

      else { rows = []; message = 'No differences.'; renderDiff(true); }
    } else if (m.type === 'diff') {
      if (m.index !== selected) { return; }
      if (m.error) { rows = []; blocks = []; message = m.error; renderDiff(true); return; }
      const { out, bl, msg } = parseDiff(m.text || '');
      rows = out; blocks = bl; message = msg;
      const adds = out.filter(r => r.rt !== null && (r.k === 'add' || r.k === 'mod')).length;
      const dels = out.filter(r => r.lt !== null && (r.k === 'del' || r.k === 'mod')).length;
      $('#cmp-stats').textContent = out.length ? `${bl.length} difference${bl.length === 1 ? '' : 's'} · +${adds} −${dels}` : '';
      applyWidths();
      renderDiff(true);
      // Primer cambio a la vista (o el último, si se llegó retrocediendo con Shift+F7)
      if (blocks.length) {
        const target = pendingJump < 0 ? blocks[blocks.length - 1] : blocks[0];
        leftEl.scrollTop = Math.max(0, target * ROW_H - leftEl.clientHeight / 3);
      }
      pendingJump = 0;
    }
  });

  // Ancho de un carácter de la fuente del editor (para el scroll horizontal)
  const probe = document.createElement('span');
  probe.className = 'code probe';
  probe.textContent = 'x'.repeat(100);
  document.body.appendChild(probe);
  charW = probe.getBoundingClientRect().width / 100 || 7.2;
  probe.remove();

  vscode.postMessage({ type: 'ready' });
})();
