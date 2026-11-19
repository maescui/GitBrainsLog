// @ts-check
// Visor de conflictos de tres columnas (MergePanel en src/merge.ts), como el de JetBrains:
// izquierda = lo propio (ours), centro = resultado, derecha = lo que llega (theirs).
// Sin style="" (CSP): todo con clases o CSSOM.
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  // Fuentes de Settings ▸ Fonts (atributos data-* del <body>; sin ellos, las de VS Code)
  (() => {
    const d = document.body.dataset, r = document.documentElement.style;
    if (d.font) { r.setProperty('--jb-font', d.font); }
    if (d.fontSize) { r.setProperty('--jb-font-size', `${d.fontSize}px`); }
  })();
  const $ = (/** @type {string} */ s) => /** @type {HTMLElement} */ (document.querySelector(s));
  const body = $('#mg-body');

  const ICON = {
    up: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M4 7l4-4 4 4"/></svg>',
    down: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v10M4 9l4 4 4-4"/></svg>',
  };
  $('#mg-prev').innerHTML = ICON.up;
  $('#mg-next').innerHTML = ICON.down;

  /**
   * Segmentos: { kind: 'common', lines } o un bloque { kind, base, ours, theirs, result,
   * left, right, edited }. left/right: 'none' (ese lado no cambió), 'pending', 'applied'
   * o 'ignored'.
   */
  let segs = [];
  let eol = true;

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function init(m) {
    eol = m.eol;
    $('#mg-file').textContent = m.path;
    $('#mg-left-head').textContent = `Yours${m.ours ? ` (${m.ours})` : ''}`;
    $('#mg-right-head').textContent = `Theirs${m.theirs ? ` (${m.theirs})` : ''}`;
    $('#mg-accept-left').textContent = `Accept Yours`;
    $('#mg-accept-right').textContent = `Accept Theirs`;
    segs = m.segments.map(s => {
      if (s.kind === 'common') { return s; }
      // Los cambios sin conflicto se aplican solos; los conflictos empiezan con la base
      const c = { ...s, edited: false, result: s.base, left: 'none', right: 'none' };
      if (s.kind === 'ours') { c.result = s.ours; c.left = 'applied'; }
      else if (s.kind === 'theirs') { c.result = s.theirs; c.right = 'applied'; }
      else if (s.kind === 'same') { c.result = s.ours; }
      else { c.left = 'pending'; c.right = 'pending'; }
      return c;
    });
    render();
    const first = conflictIndexes()[0];
    if (first !== undefined) { reveal(first); }
  }

  const isConflict = s => s.kind === 'conflict';
  const resolved = s => !isConflict(s) || s.edited || (s.left !== 'pending' && s.right !== 'pending');
  const conflictIndexes = () => segs.map((s, i) => (isConflict(s) && !resolved(s) ? i : -1)).filter(i => i >= 0);

  /** Aplica un lado: si el otro ya estaba aplicado, se añade debajo (como JetBrains). */
  function apply(i, side) {
    const s = segs[i];
    const lines = side === 'left' ? s.ours : s.theirs;
    const other = side === 'left' ? s.right : s.left;
    s.result = isConflict(s) && other === 'applied' ? [...s.result, ...lines] : [...lines];
    s[side] = 'applied';
  }
  /** Descarta un lado: si estaba aplicado (un cambio sin conflicto), el bloque vuelve a la base. */
  function ignore(i, side) {
    const s = segs[i];
    if (s[side] === 'applied' && !isConflict(s)) { s.result = [...s.base]; }
    s[side] = 'ignored';
  }

  function lineRows(lines, start, cls = '') {
    if (!lines.length) { return '<div class="ml empty-block"></div>'; }
    return lines.map((l, k) => `<div class="ml ${cls}"><span class="ln">${start + k}</span><span class="code">${esc(l) || ' '}</span></div>`).join('');
  }

  function render() {
    let lo = 1, mo = 1, ro = 1;
    let html = '';
    segs.forEach((s, i) => {
      if (s.kind === 'common') {
        const n = s.lines.length;
        html += `<div class="seg common"><div class="cell">${lineRows(s.lines, lo)}</div><div class="gut"></div>` +
          `<div class="cell">${lineRows(s.lines, mo)}</div><div class="gut"></div><div class="cell">${lineRows(s.lines, ro)}</div></div>`;
        lo += n; mo += n; ro += n;
        return;
      }
      const conflict = isConflict(s);
      const done = resolved(s);
      const sideCls = st => (st === 'none' ? '' : conflict ? (st === 'pending' ? 'conflict' : 'conflict done') : st === 'applied' ? 'change' : 'change done');
      const gutter = (side, st) => {
        if (st === 'pending') {
          const arrow = side === 'left' ? '»' : '«';
          return `<button class="mg-act apply" data-act="apply" data-side="${side}" data-i="${i}" title="Apply ${side === 'left' ? 'yours' : 'theirs'}">${arrow}</button>` +
            `<button class="mg-act ignore" data-act="ignore" data-side="${side}" data-i="${i}" title="Ignore">×</button>`;
        }
        if (st === 'applied' && !conflict) {
          return `<button class="mg-act ignore" data-act="ignore" data-side="${side}" data-i="${i}" title="Undo this change">×</button>`;
        }
        return '';
      };
      const midCls = conflict ? (done ? 'resolved' : 'conflict') : s.kind === 'same' ? 'change' : (s.left === 'applied' || s.right === 'applied') ? 'change' : '';
      const midNums = s.result.length ? s.result.map((_, k) => `<span>${mo + k}</span>`).join('') : '';
      html += `<div class="seg chunk${done ? '' : ' unresolved'}" data-i="${i}">` +
        `<div class="cell ${sideCls(s.kind === 'same' ? 'applied' : s.left)}">${lineRows(s.ours, lo)}</div>` +
        `<div class="gut">${gutter('left', s.left)}</div>` +
        `<div class="cell mid ${midCls}"><div class="mid-wrap"><div class="ln-col">${midNums}</div>` +
        `<div class="mtext" contenteditable="plaintext-only" spellcheck="false" data-i="${i}">${esc(s.result.join('\n'))}</div></div></div>` +
        `<div class="gut">${gutter('right', s.right)}</div>` +
        `<div class="cell ${sideCls(s.kind === 'same' ? 'applied' : s.right)}">${lineRows(s.theirs, ro)}</div></div>`;
      lo += s.ours.length; mo += s.result.length; ro += s.theirs.length;
    });
    const top = body.scrollTop;
    body.innerHTML = html;
    body.scrollTop = top;
    updateStatus();
  }

  function updateStatus() {
    const n = conflictIndexes().length;
    const st = $('#mg-status');
    st.textContent = n ? `${n} conflict${n === 1 ? '' : 's'} left` : 'All conflicts resolved';
    st.classList.toggle('ok', !n);
    /** @type {HTMLButtonElement} */ ($('#mg-accept-left')).disabled = !n;
    /** @type {HTMLButtonElement} */ ($('#mg-accept-right')).disabled = !n;
  }

  function reveal(i) {
    const el = body.querySelector(`.seg[data-i="${i}"]`);
    if (el) { /** @type {HTMLElement} */ (el).scrollIntoView({ block: 'center' }); }
  }
  /** Conflicto anterior o siguiente sin resolver (F7 / Shift+F7). */
  function jump(dir) {
    const list = conflictIndexes();
    if (!list.length) { return; }
    const mid = body.scrollTop + body.clientHeight / 2;
    const pos = i => { const el = /** @type {HTMLElement} */ (body.querySelector(`.seg[data-i="${i}"]`)); return el ? el.offsetTop + el.offsetHeight / 2 : 0; };
    const target = dir > 0 ? (list.find(i => pos(i) > mid + 2) ?? list[0]) : ([...list].reverse().find(i => pos(i) < mid - 2) ?? list[list.length - 1]);
    reveal(target);
  }

  body.addEventListener('click', e => {
    const b = /** @type {HTMLElement} */ (e.target).closest('.mg-act');
    if (!b) { return; }
    const i = Number(/** @type {HTMLElement} */ (b).dataset.i);
    if (/** @type {HTMLElement} */ (b).dataset.act === 'apply') { apply(i, /** @type {HTMLElement} */ (b).dataset.side); }
    else { ignore(i, /** @type {HTMLElement} */ (b).dataset.side); }
    render();
  });
  // El resultado se puede editar a mano: el bloque cuenta como resuelto
  body.addEventListener('input', e => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (!t.classList.contains('mtext')) { return; }
    const s = segs[Number(t.dataset.i)];
    s.result = t.innerText.replace(/\n$/, '').split('\n');
    if (t.innerText === '') { s.result = []; }
    s.edited = true;
    updateStatus();
  });
  body.addEventListener('focusout', e => {
    if (/** @type {HTMLElement} */ (e.target).classList.contains('mtext')) { render(); }
  });

  $('#mg-accept-left').addEventListener('click', () => acceptAll('left'));
  $('#mg-accept-right').addEventListener('click', () => acceptAll('right'));
  /** Accept Yours / Accept Theirs: todos los conflictos pendientes con ese lado. */
  function acceptAll(side) {
    for (const i of conflictIndexes()) {
      const s = segs[i];
      s.result = [...(side === 'left' ? s.ours : s.theirs)];
      s.left = side === 'left' ? 'applied' : 'ignored';
      s.right = side === 'right' ? 'applied' : 'ignored';
    }
    render();
  }
  $('#mg-prev').addEventListener('click', () => jump(-1));
  $('#mg-next').addEventListener('click', () => jump(1));
  document.addEventListener('keydown', e => {
    if (e.key === 'F7') { e.preventDefault(); jump(e.shiftKey ? -1 : 1); }
  });

  function resultText() {
    const lines = segs.flatMap(s => (s.kind === 'common' ? s.lines : s.result));
    return lines.join('\n') + (eol && lines.length ? '\n' : '');
  }
  $('#mg-apply').addEventListener('click', () => {
    const n = conflictIndexes().length;
    if (n) { vscode.postMessage({ type: 'confirmApply', unresolved: n }); } else { vscode.postMessage({ type: 'apply', text: resultText() }); }
  });
  $('#mg-cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  $('#mg-native').addEventListener('click', () => vscode.postMessage({ type: 'openNative' }));

  window.addEventListener('message', ev => {
    const m = ev.data;
    if (m.type === 'init') { init(m); }
    else if (m.type === 'doApply') { vscode.postMessage({ type: 'apply', text: resultText() }); }
  });
  vscode.postMessage({ type: 'ready' });
})();
