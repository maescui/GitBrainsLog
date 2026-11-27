// @ts-check
// Ventanas de diálogo (DialogWindow en src/dialog.ts), en una ventana flotante de VS Code:
// Push Commits (como el de JetBrains) y un mensaje de varias líneas (Squash).
// Sin style="" (CSP): todo con clases o CSSOM.
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  // Iconos de archivos del tema de iconos de VS Code (fileicons.js); sin tema, la lista queda sin iconos
  const jbFileIcons = /** @type {any} */ (window).jbFileIcons || { html: () => '', apply() { /* nada */ }, setTheme() { /* nada */ } };
  // Fechas (dateformat.js, cargado antes que este script)
  const jbDateFormat = /** @type {any} */ (window).jbDateFormat;
  // Fuentes de Settings ▸ Fonts (atributos data-* del <body>; sin ellos, las de VS Code)
  (() => {
    const d = document.body.dataset, r = document.documentElement.style;
    if (d.font) { r.setProperty('--jb-font', d.font); }
    if (d.fontSize) { r.setProperty('--jb-font-size', `${d.fontSize}px`); }
  })();
  const root = /** @type {HTMLElement} */ (document.getElementById('dlg'));
  const ICON = {
    branch: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="4.5" cy="3.5" r="1.8"/><circle cx="4.5" cy="12.5" r="1.8"/><circle cx="11.5" cy="5" r="1.8"/><path d="M4.5 5.3v5.4M11.5 6.8c0 2.6-7 2-7 3.9"/></svg>',
    warning: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M8 1.8 14.6 13.5H1.4z"/><path d="M8 6v3.6M8 11.4v.4" stroke-linecap="round"/></svg>',
    lock: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="3.5" y="7" width="9" height="7" rx="1.2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/><path d="M8 9.8v1.6" stroke-linecap="round"/></svg>',
    pencil: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M11 2.5l2.5 2.5L6 12.5 3 13l.5-3z"/><path d="M9.5 4l2.5 2.5"/></svg>',
  };
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  /** Fecha de un commit: la absoluta del Log (dateformat.js), dd/MM/yyyy, HH:mm en cualquier idioma. */
  function formatDate(/** @type {number} */ t) {
    return jbDateFormat.absolute(new Date(t * 1000));
  }
  const result = (/** @type {any} */ r) => vscode.postMessage({ type: 'result', ...r });
  // Escape cierra (= cancelar) en cualquier diálogo
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); result({ ok: false }); } });

  // -------------------------------------------------------------------------
  // Mensaje de varias líneas (Squash): Enter = salto de línea, Ctrl/Cmd+Enter acepta
  // -------------------------------------------------------------------------

  function showText(m) {
    root.className = 'dlg-text-page';
    root.innerHTML = `<div class="dlg-title">${esc(m.heading || m.title)}</div>
      ${m.detail ? `<div class="dlg-detail">${String(m.detail).split('\n\n').map(p => `<p>${esc(p)}</p>`).join('')}</div>` : ''}
      <textarea id="dlg-text" class="dlg-textarea" spellcheck="false" aria-label="${esc(m.label || 'Text')}">${esc(m.text || '')}</textarea>
      <div class="dlg-actions"><span class="muted dlg-hint">Ctrl+Enter to ${esc((m.action || 'OK').toLowerCase())}</span><span class="spacer"></span>
        <button class="btn secondary" data-act="cancel">Cancel</button><button class="btn" data-act="ok">${esc(m.action || 'OK')}</button></div>`;
    const ta = /** @type {HTMLTextAreaElement} */ (root.querySelector('#dlg-text'));
    const ok = () => result({ ok: true, text: ta.value });
    root.addEventListener('click', e => {
      const b = /** @type {HTMLElement} */ (e.target).closest('[data-act]');
      if (b) { if (b.getAttribute('data-act') === 'ok') { ok(); } else { result({ ok: false }); } }
    });
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ok(); } });
    ta.focus();
    ta.setSelectionRange(0, 0);
    ta.scrollTop = 0;
  }

  // -------------------------------------------------------------------------
  // Push Commits (como JetBrains)
  // -------------------------------------------------------------------------

  /** @type {any} */
  let push = null;   // { items, protectedBranches, multi, sel: { key, hash }, files, timers }

  /**
   * Un bloque por rama: casilla, «repo: rama → remoto : destino» (remoto y destino
   * editables) y los commits que se suben; a la derecha, los archivos del commit
   * seleccionado (doble clic: diff). Abajo, Push Tags y Push / Force Push.
   */
  function showPush(m) {
    push = { multi: m.multi, protectedBranches: m.protectedBranches || [], sel: null, files: null, timers: {},
      items: m.items.map(it => ({ ...it, include: it.commits.length > 0 || !it.exists })) };
    root.className = 'dlg-push-page';
    root.innerHTML = `<div class="pd-body">
          <div class="pd-left">${push.items.map(pushBlockHtml).join('')}</div>
          <div class="pd-right"><div class="pd-files-title muted">Select a commit to see its files</div><div class="pd-files"></div></div>
        </div>
        <div class="pd-footer">
          <label class="dlg-check pd-tags"><input type="checkbox" id="pd-tags"> Push tags:</label>
          <select id="pd-tags-mode" disabled><option value="all">All</option><option value="follow">Current Branch</option></select>
          <span class="spacer"></span>
          <button class="btn secondary" data-pd="cancel">Cancel</button>
          <button class="btn secondary" data-pd="force">Force Push</button>
          <button class="btn" data-pd="push">Push</button>
        </div>`;
    for (const it of push.items) { renderPushCommits(it); }
    updatePushButtons();
    const first = push.items.find(it => it.include && it.commits.length);
    if (first) { selectPushCommit(first.key, first.commits[0].hash); }
    /** @type {HTMLElement} */ (root.querySelector('[data-pd="push"]')).focus();
  }

  const finishPush = (ok, force = false) => {
    if (!push) { return; }
    const tags = /** @type {HTMLInputElement} */ (root.querySelector('#pd-tags')).checked
      ? /** @type {HTMLSelectElement} */ (root.querySelector('#pd-tags-mode')).value : '';
    const items = push.items.map(it => ({ key: it.key, include: it.include, remote: it.remote, target: it.target }));
    result({ ok, force, tags, items });
  };
  root.addEventListener('click', e => {
    if (!push) { return; }
    const t = /** @type {HTMLElement} */ (e.target);
    const b = /** @type {HTMLButtonElement} */ (t.closest('[data-pd]'));
    if (b) {
      if (b.disabled) { return; }
      if (b.dataset.pd === 'cancel') { finishPush(false); } else { finishPush(true, b.dataset.pd === 'force'); }
      return;
    }
    const ed = /** @type {HTMLElement} */ (t.closest('[data-edit]'));
    if (ed) { editTarget(Number(ed.dataset.key)); return; }
    const c = /** @type {HTMLElement} */ (t.closest('.pd-commit'));
    if (c) { selectPushCommit(Number(c.dataset.key), c.dataset.hash); }
  });

  /**
   * La rama de destino en el remoto solo se edita con el lápiz (para no cambiarla sin
   * querer): se cambia el texto por un campo; Enter o salir del campo lo confirma y Escape
   * deja el valor que tenía.
   */
  function editTarget(key) {
    const box = root.querySelector(`.pd-target[data-key="${key}"]`);
    if (!box || !push) { return; }
    const input = /** @type {HTMLInputElement} */ (box.querySelector('[data-target]'));
    input.dataset.before = push.items[key].target;
    box.classList.add('editing');
    input.classList.remove('hidden');
    input.focus();
    input.select();
  }
  function endEditTarget(input, revert) {
    const box = input.closest('.pd-target');
    if (!box || !box.classList.contains('editing') || !push) { return; }
    const it = push.items[Number(input.dataset.key)];
    if (revert || !input.value.trim()) {
      input.value = input.dataset.before || it.target;
      if (it.target !== input.value) { it.target = input.value; clearTimeout(push.timers[it.key]); requestPushPreview(it); }
    }
    box.classList.remove('editing');
    input.classList.add('hidden');
    /** @type {HTMLElement} */ (box.querySelector('.pd-target-name')).textContent = it.target;
    updatePushButtons();
  }
  root.addEventListener('focusout', e => {
    const t = /** @type {HTMLInputElement} */ (e.target);
    if (t.matches && t.matches('[data-target]')) { endEditTarget(t, false); }
  });
  root.addEventListener('dblclick', e => {
    const f = /** @type {HTMLElement} */ (/** @type {HTMLElement} */ (e.target).closest('.pd-file'));
    if (f && push && push.sel && push.files) {
      const c = pushCommit(push.sel.key, push.sel.hash);
      const file = push.files[Number(f.dataset.i)];
      if (c && file) { vscode.postMessage({ type: 'openFileDiff', hash: c.hash, parent: c.parent, file }); }
    }
  });
  root.addEventListener('change', e => {
    if (!push) { return; }
    const t = /** @type {HTMLInputElement} */ (e.target);
    if (t.id === 'pd-tags') { /** @type {HTMLSelectElement} */ (root.querySelector('#pd-tags-mode')).disabled = !t.checked; return; }
    const it = push.items[Number(t.dataset.key)];
    if (!it) { return; }
    if (t.matches('[data-inc]')) { it.include = t.checked; updatePushButtons(); }
    else if (t.matches('[data-remote]')) { it.remote = t.value; requestPushPreview(it); }
  });
  root.addEventListener('input', e => {
    if (!push) { return; }
    const t = /** @type {HTMLInputElement} */ (e.target);
    if (!t.matches('[data-target]')) { return; }
    const it = push.items[Number(t.dataset.key)];
    it.target = t.value.trim();
    updatePushButtons();
    clearTimeout(push.timers[it.key]);
    push.timers[it.key] = setTimeout(() => requestPushPreview(it), 350);
  });
  root.addEventListener('keydown', e => {
    if (!push) { return; }
    const tg = /** @type {HTMLInputElement} */ (e.target);
    if (tg.matches('[data-target]') && (e.key === 'Enter' || e.key === 'Escape')) {
      // En el campo del destino, Enter confirma y Escape deshace (sin cerrar la ventana)
      e.preventDefault();
      e.stopPropagation();
      endEditTarget(tg, e.key === 'Escape');
      const pencil = /** @type {HTMLElement | null} */ (root.querySelector(`[data-edit][data-key="${tg.dataset.key}"]`));
      if (pencil) { pencil.focus(); }
      return;
    }
    if (e.key === 'Enter' && !(/** @type {HTMLElement} */ (e.target).matches('button, select'))) {
      e.preventDefault();
      const ok = /** @type {HTMLButtonElement} */ (root.querySelector('[data-pd="push"]'));
      if (!ok.disabled) { finishPush(true); }
    }
  });

  function pushBlockHtml(it) {
    const remotes = it.remotes.map(r => `<option value="${esc(r)}"${r === it.remote ? ' selected' : ''}>${esc(r)}</option>`).join('');
    return `<div class="pd-repo" data-key="${it.key}">
      <div class="pd-head">
        <input type="checkbox" data-inc data-key="${it.key}"${it.include ? ' checked' : ''} aria-label="Push '${esc(it.branch)}'">
        ${push.multi ? `<span class="pd-reponame">${esc(it.repoName)}:</span>` : ''}
        <span class="pd-branch">${ICON.branch}${esc(it.branch)}</span>
        <span class="muted">→</span>
        <select data-remote data-key="${it.key}"${it.remotes.length < 2 ? ' disabled' : ''}>${remotes}</select>
        <span class="muted">:</span>
        <span class="pd-target" data-key="${it.key}">
          <span class="pd-target-name" title="Branch on the remote">${esc(it.target)}</span>
          <button class="pd-edit" data-edit data-key="${it.key}" title="Edit the target branch on the remote" aria-label="Edit target branch">${ICON.pencil}</button>
          <input type="text" class="hidden" data-target data-key="${it.key}" value="${esc(it.target)}" spellcheck="false" aria-label="Target branch">
        </span>
        <span class="pd-badges"></span>
      </div>
      <div class="pd-commits"></div>
    </div>`;
  }

  /** Commits y avisos de un bloque (se repinta al cambiar el remoto o la rama de destino). */
  function renderPushCommits(it) {
    const el = root.querySelector(`.pd-repo[data-key="${it.key}"]`);
    if (!el) { return; }
    const badges = [];
    if (!it.exists) { badges.push('<span class="pd-badge new" title="The branch doesn\'t exist on the remote yet: it will be created and set as upstream">New</span>'); }
    if (push.protectedBranches.includes(it.target)) { badges.push(`<span class="pd-badge lock" title="Protected branch: it cannot be force-pushed">${ICON.lock}</span>`); }
    if (it.behind) { badges.push(`<span class="pd-badge warn" title="The remote branch has ${it.behind} commit${it.behind === 1 ? '' : 's'} that '${esc(it.branch)}' doesn't have: the push will be rejected. Update first, or use Force Push.">${ICON.warning}↓${it.behind}</span>`); }
    /** @type {HTMLElement} */ (el.querySelector('.pd-badges')).innerHTML = badges.join('');
    const list = /** @type {HTMLElement} */ (el.querySelector('.pd-commits'));
    list.innerHTML = it.commits.length
      ? it.commits.map(c => `<div class="pd-commit${push.sel && push.sel.hash === c.hash ? ' selected' : ''}" data-key="${it.key}" data-hash="${esc(c.hash)}">` +
        `<span class="pd-subject">${esc(c.subject)}</span><span class="pd-author muted">${esc(c.author)}</span><span class="pd-date muted">${esc(formatDate(c.time))}</span></div>`).join('')
      : `<div class="pd-none muted">${it.exists ? 'No commits to push' : 'No new commits (the branch will be created on the remote)'}</div>`;
  }

  function updatePushButtons() {
    if (!push) { return; }
    const sel = push.items.filter(it => it.include);
    const pushBtn = /** @type {HTMLButtonElement} */ (root.querySelector('[data-pd="push"]'));
    const forceBtn = /** @type {HTMLButtonElement} */ (root.querySelector('[data-pd="force"]'));
    const valid = sel.length > 0 && sel.every(it => it.target && it.remote);
    pushBtn.disabled = !valid;
    const prot = sel.filter(it => push.protectedBranches.includes(it.target));
    forceBtn.disabled = !valid || prot.length > 0;
    forceBtn.title = prot.length ? `Force push is not allowed to protected branches: ${prot.map(it => it.target).join(', ')}`
      : 'Push with --force-with-lease (fails if the remote branch moved since your last fetch)';
  }

  function requestPushPreview(it) {
    if (!push) { return; }
    vscode.postMessage({ type: 'pushPreview', key: it.key, repo: it.repo, branch: it.branch, remote: it.remote, target: it.target });
  }
  function onPushPreview(m) {
    if (!push) { return; }
    const it = push.items[m.key];
    if (!it) { return; }
    Object.assign(it, { commits: m.commits, behind: m.behind, exists: m.exists });
    renderPushCommits(it);
    updatePushButtons();
  }

  const pushCommit = (key, hash) => (push && push.items[key] ? push.items[key].commits.find(c => c.hash === hash) : null);
  function selectPushCommit(key, hash) {
    const c = pushCommit(key, hash);
    if (!c) { return; }
    push.sel = { key, hash };
    push.files = null;
    for (const el of root.querySelectorAll('.pd-commit')) {
      el.classList.toggle('selected', /** @type {HTMLElement} */ (el).dataset.hash === hash);
    }
    /** @type {HTMLElement} */ (root.querySelector('.pd-files-title')).textContent = c.subject;
    /** @type {HTMLElement} */ (root.querySelector('.pd-files')).innerHTML = '<div class="pd-none muted">Loading…</div>';
    vscode.postMessage({ type: 'pushFiles', hash: c.hash, parent: c.parent });
  }
  function onPushFiles(m) {
    if (!push || !push.sel || push.sel.hash !== m.hash) { return; }
    push.files = m.files;
    const st = s => (s[0] === 'A' ? 'st-A' : s[0] === 'D' ? 'st-D' : s[0] === 'R' ? 'st-R' : 'st-M');
    /** @type {HTMLElement} */ (root.querySelector('.pd-files')).innerHTML = m.files.length
      ? m.files.map((f, i) => `<div class="pd-file" data-i="${i}" title="${esc(f.oldPath ? `${f.oldPath} → ${f.path}` : f.path)} — double-click to see the diff">` +
        `<span class="pd-st ${st(f.status)}">${esc(f.status[0])}</span>${jbFileIcons.html(f.path, false)}<span class="pd-fname">${esc(f.path.split('/').pop())}</span>` +
        `<span class="pd-fdir muted">${esc(f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '')}</span></div>`).join('')
      : '<div class="pd-none muted">No files changed</div>';
    jbFileIcons.apply(root.querySelector('.pd-files'));
  }

  window.addEventListener('message', ev => {
    const m = ev.data;
    if (m.type === 'init') { if (m.kind === 'push') { showPush(m); } else if (m.kind === 'text') { showText(m); } }
    else if (m.type === 'pushPreview') { onPushPreview(m); }
    else if (m.type === 'pushFiles') { onPushFiles(m); }
    else if (m.type === 'iconTheme') {
      jbFileIcons.setTheme(m.theme);
      if (push && push.sel && push.files) { onPushFiles({ hash: push.sel.hash, files: push.files }); }   // repinta con los iconos
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
