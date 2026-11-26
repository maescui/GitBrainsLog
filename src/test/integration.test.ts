/**
 * Tests de integración: el GitLogViewProvider real (refresh, auto-stage, commit, watchers)
 * contra repos git temporales, con el stub de «vscode» y un panel falso (ver harness.ts).
 * Cubren lo que los tests unitarios no pueden: que extension.ts use bien las piezas de core.ts.
 */
import { test, describe, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { writeFileSync, rmSync, mkdirSync, symlinkSync } from 'fs';
import * as path from 'path';
import { openPanel, fakeWebview, spyGit, until, sleep, stubState, stubConfig, Panel, Msg } from './harness';
import { TestRepo, tmpDir, rm } from './helpers';
import { Git } from '../git';
import { GitLogViewProvider } from '../extension';
import { watchSpecs, escAttr } from '../core';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(f => { try { f(); } catch { /* ya borrado */ } }); delete stubConfig.autoStage; });

/** Repo con a.txt, b.txt y c.txt commiteados. */
function newRepo(extra: Record<string, string> = {}): TestRepo {
  const r = TestRepo.init();
  r.commit('c1', { 'a.txt': 'a1\n', 'b.txt': 'b1\n', 'c.txt': 'c1\n', ...extra });
  cleanup.push(() => rm(r.root));
  return r;
}
async function open(...folders: string[]): Promise<Panel> {
  const p = await openPanel(folders);
  cleanup.push(() => p.dispose());
  return p;
}
const lastOf = (p: Panel, type: string): Msg => [...p.posted].reverse().find(m => m.type === type)!;
const fileOf = (m: Msg, name: string) => (m.files as any[]).find(f => f.path === name);
const WRITES = new Set(['add', 'reset', 'commit', 'checkout', 'rm', 'apply', 'stash']);

describe('el panel carga (smoke)', () => {
  test('log, cambios y stashes de un repo', async () => {
    const r = newRepo();
    r.commit('c2', { 'a.txt': 'a2\n' });
    const p = await open(r.root);
    const d = lastOf(p, 'data');
    assert.equal(d.commits.length, 2);
    assert.equal(d.repos[0].head.branch, 'main');
    assert.deepEqual(lastOf(p, 'changes').files, []);
  });
});

describe('refresh(): descarta las respuestas viejas', () => {
  test('un refresh lento que acaba después de uno con filtro no pisa sus datos', async () => {
    const r = newRepo();
    r.git('branch', 'other');                 // other = c1
    r.commit('c2', { 'a.txt': 'a2\n' });      // main = c1 + c2
    const p = await open(r.root);
    assert.equal(lastOf(p, 'data').commits.length, 2);

    let started = false, release!: () => void;
    const gate = new Promise<void>(res => { release = res; });
    spyGit(p.repos()[0].git, 'getLog', async (orig, ref, ...rest) => {
      if (ref == null) { started = true; await gate; }     // el log sin filtro tarda
      return orig(ref, ...rest);
    });

    const from = p.posted.length;
    const slow = p.provider.refresh();                     // sin filtro: se queda esperando al «git log»
    await until(() => started, 'que el refresh lento llegue a git log');
    await p.send({ type: 'filter', ref: 'refs/heads/other' });   // el refresh nuevo acaba antes
    release();
    await slow;                                            // el viejo termina después y debe callarse

    const datas = p.since('data', from);
    assert.ok(datas.length >= 1);
    for (const d of datas) {
      assert.equal(d.commits.length, 1, 'ningún data con el log sin filtrar tras poner el filtro');
      assert.equal(d.filterRef, 'refs/heads/other');
    }
  });

  test('el error de un refresh superado no se muestra', async () => {
    const r = newRepo();
    const p = await open(r.root);
    let started = false, release!: () => void;
    const gate = new Promise<void>(res => { release = res; });
    spyGit(p.repos()[0].git, 'getLog', async (orig, ref, ...rest) => {
      if (!started) { started = true; await gate; throw new Error('fallo del refresh viejo'); }
      return orig(ref, ...rest);
    });
    const from = p.posted.length;
    const old = p.provider.refresh();
    await until(() => started, 'que el refresh viejo llegue a git log');
    await p.provider.refresh();                            // el nuevo funciona
    release();
    await old;
    assert.equal(p.since('error', from).length, 0);
    assert.ok(p.since('data', from).length >= 1);
  });
});

describe('candado del índice y auto-stage', () => {
  /** Espía las escrituras al índice: devuelve el máximo que corrieron a la vez (cada una tarda `ms`). */
  function trackWrites(p: Panel, ms = 40) {
    const state = { active: 0, max: 0, ops: [] as string[] };
    spyGit(p.repos()[0].git, 'run', async (orig, args: string[], ...rest) => {
      if (!WRITES.has(args[0])) { return orig(args, ...rest); }
      state.ops.push(args[0]);
      state.max = Math.max(state.max, ++state.active);
      try { await sleep(ms); return await orig(args, ...rest); } finally { state.active--; }
    });
    return state;
  }

  test('auto-stage y «−» a la vez no escriben el índice al mismo tiempo', async () => {
    const r = newRepo();
    r.write('a.txt', 'a2\n'); r.write('b.txt', 'b2\n');
    const p = await open(r.root);                     // a y b modificados → auto-stage los añade
    assert.equal(fileOf(lastOf(p, 'changes'), 'b.txt').group, 'staged');
    r.write('c.txt', 'c2\n');                         // c cambia: el próximo refresco lo añadirá
    const w = trackWrites(p);
    const b = fileOf(lastOf(p, 'changes'), 'b.txt');
    await Promise.all([
      p.provider.refreshChanges(),                    // git add c.txt
      p.send({ type: 'changeAction', action: 'unstage', changes: [b] }),   // git reset b.txt
    ]);
    assert.ok(w.ops.includes('add') && w.ops.includes('reset'), `se esperaban un add y un reset (hubo: ${w.ops})`);
    assert.equal(w.max, 1, 'las escrituras al índice deben ir de una en una');
  });

  test('dos «−» a la vez tampoco se solapan', async () => {
    const r = newRepo();
    r.write('a.txt', 'a2\n'); r.write('b.txt', 'b2\n');
    const p = await open(r.root);
    const a = fileOf(lastOf(p, 'changes'), 'a.txt'), b = fileOf(lastOf(p, 'changes'), 'b.txt');
    const w = trackWrites(p);
    await Promise.all([
      p.send({ type: 'changeAction', action: 'unstage', changes: [a] }),
      p.send({ type: 'changeAction', action: 'unstage', changes: [b] }),
    ]);
    assert.equal(w.ops.filter(o => o === 'reset').length, 2);
    assert.equal(w.max, 1);
  });

  test('un archivo sacado con «−» no vuelve a entrar en el siguiente refresco', async () => {
    const r = newRepo();
    r.write('a.txt', 'a2\n'); r.write('b.txt', 'b2\n');
    const p = await open(r.root);
    await p.send({ type: 'changeAction', action: 'unstage', changes: [fileOf(lastOf(p, 'changes'), 'b.txt')] });
    await p.provider.refreshChanges();
    await p.provider.refreshChanges();
    const ch = lastOf(p, 'changes');
    assert.equal(fileOf(ch, 'b.txt').group, 'unstaged', 'b sigue fuera del commit');
    assert.equal(fileOf(ch, 'a.txt').group, 'staged', 'a sigue dentro');
  });

  test('«+» (Stage) lo vuelve a incluir', async () => {
    const r = newRepo();
    r.write('b.txt', 'b2\n');
    const p = await open(r.root);
    await p.send({ type: 'changeAction', action: 'unstage', changes: [fileOf(lastOf(p, 'changes'), 'b.txt')] });
    await p.provider.refreshChanges();
    assert.equal(fileOf(lastOf(p, 'changes'), 'b.txt').group, 'unstaged');
    await p.send({ type: 'changeAction', action: 'stage', changes: [fileOf(lastOf(p, 'changes'), 'b.txt')] });
    await p.provider.refreshChanges();
    assert.equal(fileOf(lastOf(p, 'changes'), 'b.txt').group, 'staged');
  });

  test('con autoStage desactivado no se añade nada solo', async () => {
    stubConfig.autoStage = false;
    const r = newRepo();
    r.write('a.txt', 'a2\n');
    const p = await open(r.root);
    assert.equal(fileOf(lastOf(p, 'changes'), 'a.txt').group, 'unstaged');
  });

  test('el commit incluye lo editado desde el último refresco', async () => {
    const r = newRepo();
    const p = await open(r.root);
    r.write('a.txt', 'a-editado\n');                 // sin watcher ni refresh: la lista no lo sabe
    const from = p.posted.length;
    await p.send({ type: 'commit', message: 'edita a', amend: false, push: false });
    await p.waitFor('committed', { from, timeout: 5000 });
    assert.equal(r.git('log', '--format=%s').trim().split('\n')[0], 'edita a');
    assert.match(r.git('show', '--name-only', '--format=', 'HEAD'), /a\.txt/);
    assert.equal(r.git('status', '--porcelain').trim(), '');
  });

  test('el commit no incluye lo que se sacó con «−»', async () => {
    const r = newRepo();
    r.write('a.txt', 'a2\n'); r.write('b.txt', 'b2\n');
    const p = await open(r.root);
    await p.send({ type: 'changeAction', action: 'unstage', changes: [fileOf(lastOf(p, 'changes'), 'b.txt')] });
    const from = p.posted.length;
    await p.send({ type: 'commit', message: 'solo a', amend: false, push: false });
    await p.waitFor('committed', { from, timeout: 5000 });
    const files = r.git('show', '--name-only', '--format=', 'HEAD');
    assert.match(files, /a\.txt/);
    assert.doesNotMatch(files, /b\.txt/);
    assert.match(r.git('status', '--porcelain'), / M b\.txt/);
  });

  test('un index.lock de otro proceso no sale como error y se reintenta al soltarse', async () => {
    const r = newRepo();
    const p = await open(r.root);
    r.write('a.txt', 'a2\n');
    const lock = path.join(r.root, '.git', 'index.lock');
    writeFileSync(lock, '');                          // otro git tiene el índice
    cleanup.push(() => rmSync(lock, { force: true }));
    await p.provider.refreshChanges();
    const ch = lastOf(p, 'changes');
    assert.equal(ch.error, undefined, 'no se muestra el error');
    assert.equal(fileOf(ch, 'a.txt').group, 'unstaged', 'de momento queda sin añadir');
    const from = p.posted.length;
    rmSync(lock);
    await p.waitFor('changes', { from, timeout: 8000, pred: m => fileOf(m, 'a.txt')?.group === 'staged' });
  });
});

describe('watchers: dónde vigila la extensión', () => {
  /** Un repo y un worktree suyo (rama `other`). */
  function withWorktree() {
    const r = newRepo();
    const wt = tmpDir(); rmSync(wt, { recursive: true, force: true });
    r.git('worktree', 'add', '-q', '-b', 'other', wt);
    cleanup.push(() => rm(wt));
    return { r, wt };
  }
  const norm = (x: string) => path.resolve(x).toLowerCase();
  /** Dónde guarda git los datos de un repo o worktree, preguntándoselo a git (no a nuestro código). */
  const gitSays = (root: string) => {
    const t = new TestRepo(root);
    return { dir: norm(path.resolve(root, t.git('rev-parse', '--absolute-git-dir').trim())), common: norm(path.resolve(root, t.git('rev-parse', '--git-common-dir').trim())) };
  };
  /** Bases de los watchers vivos cuyo patrón cumple `pred`. */
  const basesOf = (pred: (pattern: string) => boolean) => stubState.watchers.filter(w => !w.disposed && pred(w.pattern)).map(w => norm(w.base));

  test('en un repo normal vigila .git (HEAD, refs, índice) y la raíz', async () => {
    const r = newRepo();
    await open(r.root);
    await until(() => stubState.watchers.length >= 4, 'que se registren los watchers');
    const g = gitSays(r.root);
    assert.equal(g.dir, norm(path.join(r.root, '.git')));
    assert.deepEqual(basesOf(pt => pt.startsWith('{HEAD')), [g.dir]);
    assert.deepEqual(basesOf(pt => pt.includes('refs/**') && !pt.includes('HEAD')), [g.common]);
    assert.deepEqual(basesOf(pt => pt === 'index'), [g.dir]);
    assert.deepEqual(basesOf(pt => pt === '**/*'), [norm(r.root)]);
  });

  test('en un worktree vigila su directorio propio (HEAD, índice) y el común (refs), no <raíz>/.git', async () => {
    const { r, wt } = withWorktree();
    await open(wt);
    await until(() => stubState.watchers.length >= 4, 'que se registren los watchers');
    const g = gitSays(wt);
    assert.notEqual(g.dir, g.common);
    assert.equal(g.common, norm(path.join(r.root, '.git')), 'git dice: las ramas están en el .git del repo principal');
    assert.ok(g.dir.startsWith(g.common + path.sep) && g.dir.includes('worktrees'), 'git dice: HEAD e índice cuelgan de .git/worktrees');
    assert.deepEqual(basesOf(pt => pt.startsWith('{HEAD')), [g.dir]);
    assert.deepEqual(basesOf(pt => pt.includes('refs/**') && !pt.includes('HEAD')), [g.common]);
    assert.deepEqual(basesOf(pt => pt === 'index'), [g.dir]);
    assert.ok(!basesOf(() => true).includes(norm(path.join(wt, '.git'))), 'nada cuelga de <worktree>/.git (es un archivo)');
  });

  test('una rama nueva creada fuera (refs compartidos del worktree) refresca el log', async () => {
    const { r, wt } = withWorktree();
    const p = await open(wt);
    await until(() => stubState.watchers.length >= 4, 'que se registren los watchers');
    const dirs = await new Git(wt).gitDirs();
    const [, shared] = watchSpecs(wt, dirs);
    r.git('branch', 'nueva');                         // lo hace otro (la terminal), en el repo principal
    const from = p.posted.length;
    assert.ok(stubState.fire('create', { base: shared.dir, pattern: shared.pattern }, path.join(shared.dir, 'refs', 'heads', 'nueva')) > 0);
    await p.waitFor('data', { from, pred: m => m.tree.some((n: any) => n.full === 'refs/heads/nueva') });
  });

  test('un commit en el worktree (HEAD propio) refresca el log', async () => {
    const { wt } = withWorktree();
    const p = await open(wt);
    await until(() => stubState.watchers.length >= 4, 'que se registren los watchers');
    const dirs = await new Git(wt).gitDirs();
    const [own] = watchSpecs(wt, dirs);
    new TestRepo(wt).commit('en el worktree', { 'z.txt': 'z' });
    const from = p.posted.length;
    stubState.fire('change', { base: own.dir, pattern: own.pattern }, path.join(own.dir, 'HEAD'));
    await p.waitFor('data', { from, pred: m => m.commits[0]?.subject === 'en el worktree' });
  });

  test('el índice y el árbol de trabajo refrescan Local Changes, pero lo de dentro de .git no', async () => {
    const { wt } = withWorktree();
    const p = await open(wt);
    await until(() => stubState.watchers.length >= 4, 'que se registren los watchers');
    const dirs = await new Git(wt).gitDirs();
    const [, , index, tree] = watchSpecs(wt, dirs);

    let from = p.posted.length;
    stubState.fire('change', { base: index.dir, pattern: index.pattern }, path.join(index.dir, 'index'));
    await p.waitFor('changes', { from });

    // Un archivo del árbol de trabajo sí
    new TestRepo(wt).write('a.txt', 'cambiado\n');
    from = p.posted.length;
    stubState.fire('change', { base: tree.dir, pattern: tree.pattern }, path.join(wt, 'a.txt'));
    await p.waitFor('changes', { from });

    // El `.git` de un worktree es un archivo en la raíz: cambiarlo no es un cambio del árbol
    from = p.posted.length;
    stubState.fire('change', { base: tree.dir, pattern: tree.pattern }, path.join(wt, '.git'));
    await sleep(800);                                 // más que el debounce de 300 ms
    assert.equal(p.since('changes', from).length, 0);
  });
});

describe('filtros del log', () => {
  test('cada log lleva el número del último cambio de filtro aplicado', async () => {
    const r = newRepo();
    const p = await open(r.root);
    assert.equal(lastOf(p, 'data').logFilterSeq, 0);
    const data = p.waitFor('data');
    await p.send({ type: 'logFilter', key: 'paths', value: { roots: [r.root], paths: [] }, seq: 7 });
    const d = await data;
    assert.equal(d.logFilterSeq, 7);
    assert.deepEqual(d.logFilters.roots, [r.root]);
  });
});

describe('Log en una pestaña del editor', () => {
  /** WebviewPanel falso sobre fakeWebview: además se puede cerrar. */
  function fakeEditor() {
    const fake = fakeWebview();
    const disposers: (() => void)[] = [];
    const panel: any = {
      visible: true, active: true, title: '', iconPath: undefined, webview: fake.webview,
      onDidChangeViewState: () => ({ dispose() { /* nada */ } }),
      onDidDispose: (cb: () => void) => { disposers.push(cb); return { dispose() { /* nada */ } }; },
      reveal: () => undefined,
      dispose: () => disposers.splice(0).forEach(f => f()),
    };
    return { ...fake, panel };
  }

  /** Pestaña del Log restaurada por VS Code al recargar y sin cargar todavía, en el grupo viewColumn. */
  function restoredLogTab(viewColumn = 1) {
    const vscode = require('vscode');
    const tab: any = { input: new vscode.TabInputWebview(`mainThreadWebview-${GitLogViewProvider.editorType}`) };
    tab.group = { viewColumn, tabs: [tab] };
    stubState.tabGroups = [tab.group];
    return tab;
  }

  /** La extensión ha puesto el contexto jbGit.inEditor de los menús a true alguna vez. */
  const inEditorSet = () => stubState.commands.some(c => c[0] === 'setContext' && c[1] === 'jbGit.inEditor' && c[2] === true);

  test('el Log pasa a la pestaña y vuelve al panel al cerrarla', async () => {
    const r = newRepo();
    const p = await open(r.root);
    const side = p.provider.sideView;
    const ed = fakeEditor();
    p.provider.adoptEditor(ed.panel);
    // El panel inferior muestra el aviso; la pestaña, el Log
    assert.match(side.webview.html, /open in an editor tab/);
    assert.match(ed.panel.webview.html, /id="log-list"/);
    assert.equal(ed.panel.title, `Git Log (${path.basename(r.root)})`);
    const data = ed.waitFor('data');
    await ed.send({ type: 'ready' });
    assert.equal((await data).commits.length, 1);
    // Lo que mande la página vieja del panel ya no llega a onMessage
    const before = p.posted.length;
    await p.send({ type: 'refresh' });
    await sleep(200);
    assert.equal(p.since('data', before).length, 0);
    // «Move Back Here» del aviso pide su comando; solo se aceptan los de la lista
    stubState.commands = [];
    await p.send({ type: 'command', id: 'jbGit.moveToPanel' });
    await p.send({ type: 'command', id: 'workbench.action.closeWindow' });
    assert.deepEqual(stubState.commands, [['jbGit.moveToPanel']]);
    // Al cerrar la pestaña el panel vuelve a cargar el Log
    await p.provider.moveToPanel();
    assert.equal(p.provider.editor, undefined);
    assert.match(side.webview.html, /id="log-list"/);
    const back = p.waitFor('data');
    await p.send({ type: 'ready' });
    await back;
  });

  test('la página del Log lleva el último estado de la interfaz, venga del panel o de la pestaña', async () => {
    const r = newRepo();
    const p = await open(r.root);
    const side = p.provider.sideView;
    const has = (html: string, state: object) => html.includes(`data-ui-state="${escAttr(JSON.stringify(state))}"`);
    const first = { tab: 'stash', commitDraft: 'WIP "x" <y>' };
    await p.send({ type: 'uiState', state: first });
    const ed = fakeEditor();
    p.provider.adoptEditor(ed.panel);
    assert.ok(has(ed.panel.webview.html, first));
    // Lo que cambie en la pestaña vuelve al panel al cerrarla
    await ed.send({ type: 'uiState', state: { tab: 'log' } });
    ed.panel.dispose();
    assert.ok(has(side.webview.html, { tab: 'log' }));
  });

  test('el estado de la interfaz se escribe una vez por ráfaga (no una por tecla) y no se pierde al cerrar', async () => {
    const r = newRepo();
    const p = await open(r.root);
    const ws = p.provider.context.workspaceState;
    const writes: object[] = [];
    const update = ws.update.bind(ws);
    ws.update = (key: string, value: object) => { if (key === 'jbGit.uiState') { writes.push(value); } return update(key, value); };
    const has = (html: string, state: object) => html.includes(`data-ui-state="${escAttr(JSON.stringify(state))}"`);

    // El borrador del commit llega en cada tecla: nada se escribe mientras se sigue escribiendo…
    for (const draft of ['f', 'fi', 'fix', 'fix ', 'fix b']) { await p.send({ type: 'uiState', state: { commitDraft: draft } }); }
    assert.equal(writes.length, 0);
    // …pero una página que se cargue ahora (el Log cambia de sitio) ya lleva lo último
    const ed = fakeEditor();
    p.provider.adoptEditor(ed.panel);
    assert.ok(has(ed.panel.webview.html, { commitDraft: 'fix b' }));
    // Pasada la pausa, una sola escritura con el último estado
    await until(() => writes.length === 1, 'que se escriba el estado', 3000);
    assert.deepEqual(writes, [{ commitDraft: 'fix b' }]);
    await sleep(450);
    assert.equal(writes.length, 1, 'no se vuelve a escribir sin cambios');

    // Si se cierra antes de la pausa (p. ej. se desactiva la extensión), se escribe al cerrar
    await ed.send({ type: 'uiState', state: { commitDraft: 'fix bug' } });   // el Log está ya en la pestaña
    assert.equal(writes.length, 1);
    p.provider.dispose();
    assert.deepEqual(writes[1], { commitDraft: 'fix bug' });
    await sleep(450);
    assert.equal(writes.length, 2, 'y no se escribe otra vez después');
  });

  test('con el Log en una pestaña a la vista, los diffs se abren en el grupo de al lado', async () => {
    const r = newRepo();
    const p = await open(r.root);
    assert.equal(p.provider.column(), -1);              // ViewColumn.Active
    const ed = fakeEditor();
    p.provider.adoptEditor(ed.panel);
    assert.equal(p.provider.column(), -2);              // ViewColumn.Beside
    // Si la acción no sale del Log (p. ej. Show History desde el explorador, con otro grupo activo),
    // el grupo activo: «al lado» sería al lado de ese otro y abriría uno nuevo cada vez
    ed.panel.active = false;
    assert.equal(p.provider.column(), -1);
  });

  test('una confirmación abierta al mover el Log se da por cancelada, sin preguntar otra vez', async () => {
    const r = newRepo();
    const p = await open(r.root);
    const asked = p.waitFor('confirm');
    const answer = p.provider.confirm('Hard reset to abc?', 'All uncommitted changes will be lost.', 'Reset');
    await asked;
    p.provider.adoptEditor(fakeEditor().panel);
    assert.equal(await answer, false);
    assert.deepEqual(stubState.warnings, []);           // ni el modal nativo
  });

  test('varios archivos abiertos a la vez van todos al grupo de al lado, sin quitarle el foco al Log', async () => {
    const r = newRepo();
    r.write('a.txt', 'a2\n'); r.write('b.txt', 'b2\n');
    const p = await open(r.root);
    p.provider.adoptEditor(fakeEditor().panel);
    const changes = ['a.txt', 'b.txt'].map(n => fileOf(lastOf(p, 'changes'), n));
    stubState.shown = [];
    await p.provider.changeAction('open', changes);
    assert.deepEqual(stubState.shown.map(s => [path.basename(s.path), s.opts.viewColumn, s.opts.preserveFocus]),
      [['a.txt', -2, true], ['b.txt', -2, true]]);
  });

  test('pestaña restaurada sin cargar: el panel muestra el aviso y Show Git Log la recrea en su grupo', async () => {
    const r = newRepo();
    const p = await open(r.root);
    const side = p.provider.sideView;
    const vscode = require('vscode');
    // Al recargar la ventana VS Code restaura la pestaña del Log, pero no la carga hasta mostrarla
    const tab = restoredLogTab(2);
    p.provider.resolveWebviewView(side);
    assert.match(side.webview.html, /open in an editor tab/);
    assert.ok(inEditorSet());
    // Show Git Log (o Open in Editor Tab): una pestaña nueva en el mismo grupo, y la vieja se cierra
    const ed = fakeEditor();
    let opts: any;
    const orig = vscode.window.createWebviewPanel;
    vscode.window.createWebviewPanel = (_t: string, _n: string, o: unknown) => { opts = o; return ed.panel; };
    try { await p.provider.reveal(); } finally { vscode.window.createWebviewPanel = orig; }
    assert.equal(p.provider.editor, ed.panel);
    assert.equal(opts.viewColumn, 2);
    assert.deepEqual(stubState.closedTabs, [tab]);
  });

  test('Move Back Here con la pestaña restaurada sin cargar la cierra y el Log vuelve al panel', async () => {
    const r = newRepo();
    const p = await open(r.root);
    const side = p.provider.sideView;
    const tab = restoredLogTab();
    p.provider.resolveWebviewView(side);
    assert.match(side.webview.html, /open in an editor tab/);
    await p.provider.moveToPanel();
    assert.deepEqual(stubState.closedTabs, [tab]);
    assert.match(side.webview.html, /id="log-list"/);
  });

  test('con el Log cargado en el panel, una pestaña restaurada que aparece después no lo saca de él', async () => {
    const r = newRepo();
    const p = await open(r.root);
    const side = p.provider.sideView;
    restoredLogTab();                                    // llega después de cargar el panel
    p.provider.onTabsChanged();
    await p.provider.reveal(true);                       // Alt+9 o un diálogo de confirmación
    assert.equal(p.provider.editor, undefined);
    assert.match(side.webview.html, /id="log-list"/);
    assert.ok(!inEditorSet());
  });

  test('al cerrar la pestaña del Log, el panel carga el Log aunque VS Code aún liste la pestaña', async () => {
    const r = newRepo();
    const p = await open(r.root);
    const side = p.provider.sideView;
    const ed = fakeEditor();
    p.provider.adoptEditor(ed.panel);
    restoredLogTab();                                    // la pestaña que se está cerrando
    ed.panel.dispose();
    assert.match(side.webview.html, /id="log-list"/);
    stubState.tabGroups = [];
    p.provider.onTabsChanged();
    assert.match(side.webview.html, /id="log-list"/);
  });

  test('si se cierra la pestaña restaurada sin cargarla, el Log vuelve al panel', async () => {
    const r = newRepo();
    const p = await open(r.root);
    const side = p.provider.sideView;
    restoredLogTab();
    p.provider.resolveWebviewView(side);
    assert.match(side.webview.html, /open in an editor tab/);
    stubState.tabGroups = [];
    p.provider.onTabsChanged();
    assert.match(side.webview.html, /id="log-list"/);
    const data = p.waitFor('data');
    await p.send({ type: 'ready' });
    await data;
  });

  test('una segunda pestaña restaurada se cierra y se queda la primera', async () => {
    const r = newRepo();
    const p = await open(r.root);
    const a = fakeEditor(), b = fakeEditor();
    p.provider.adoptEditor(a.panel);
    let closed = false;
    b.panel.dispose = () => { closed = true; };
    p.provider.adoptEditor(b.panel);
    assert.ok(closed);
    assert.equal(p.provider.editor, a.panel);
  });
});

describe('borrar varias ramas y tags a la vez', () => {
  const ref = (full: string) => ({ full, repos: [0] });
  const tags = (r: TestRepo) => r.git('tag', '-l').trim().split('\n').filter(Boolean).sort();
  const branches = (r: TestRepo) => r.git('branch', '--format=%(refname:short)').trim().split('\n').sort();
  /** Manda el borrado y contesta al cuadro de confirmación como la página (ok / cancelar). */
  async function deleteRefs(p: Panel, refs: object[], ok = true) {
    const asked = p.waitFor('confirm');
    const done = p.send({ type: 'branchesAction', action: 'delete', refs });
    const c = await asked;
    await p.send({ type: 'confirmResult', id: c.id, ok, checked: false });
    await done;
    return c;
  }

  test('varios tags locales: un solo cuadro y se borran todos (sin tocar la rama actual)', async () => {
    const r = newRepo();
    for (const t of ['v1', 'v2', 'v3']) { r.git('tag', t); }
    const p = await open(r.root);
    const c = await deleteRefs(p, ['v1', 'v2', 'v3'].map(t => ref(`refs/tags/${t}`)));
    assert.equal(c.heading, 'Delete 3 tags?');
    assert.deepEqual(c.sections, [{ label: 'Tags:', items: ["'v1'", "'v2'", "'v3'"] }]);
    assert.ok(c.notes.includes('Only the local tags are deleted.'));
    assert.deepEqual(tags(r), []);
    assert.deepEqual(branches(r), ['main']);
  });

  test('tags y ramas mezclados: cada uno en su lista, y se borran los dos', async () => {
    const r = newRepo();
    r.git('tag', 'v1'); r.git('tag', 'v2'); r.git('branch', 'feature/x');
    const p = await open(r.root);
    const c = await deleteRefs(p, [ref('refs/tags/v1'), ref('refs/tags/v2'), ref('refs/heads/feature/x')]);
    assert.equal(c.heading, 'Delete 3 branches and tags?');
    assert.deepEqual(c.sections.map((s: any) => s.label), ['Branches:', 'Tags:']);
    assert.deepEqual(tags(r), []);
    assert.deepEqual(branches(r), ['main']);
  });

  test('un solo tag por el mismo camino: el cuadro habla de un tag, no de una rama', async () => {
    const r = newRepo();
    r.git('tag', 'v1'); r.git('tag', 'v2');
    const p = await open(r.root);
    const c = await deleteRefs(p, [ref('refs/tags/v1')]);
    assert.equal(c.heading, "Delete tag 'v1'?");
    assert.ok(c.notes.includes('Only the local tag is deleted.'));
    assert.deepEqual(tags(r), ['v2']);
  });

  test('si se cancela el cuadro, no se borra ningún tag', async () => {
    const r = newRepo();
    r.git('tag', 'v1'); r.git('tag', 'v2');
    const p = await open(r.root);
    await deleteRefs(p, [ref('refs/tags/v1'), ref('refs/tags/v2')], false);
    assert.deepEqual(tags(r), ['v1', 'v2']);
  });

  test('un tag anotado también se borra, y los demás tags siguen', async () => {
    const r = newRepo();
    r.git('tag', '-a', 'v1', '-m', 'primera'); r.git('tag', 'v2'); r.git('tag', 'keep');
    const p = await open(r.root);
    await deleteRefs(p, [ref('refs/tags/v1'), ref('refs/tags/v2')]);
    assert.deepEqual(tags(r), ['keep']);
  });
});

describe('carpetas en Local Changes (repos anidados, enlaces a carpetas): sin EISDIR', () => {
  /** Un repo con otro repo dentro, que git lista como la carpeta sin seguimiento «inner/». */
  function withNestedRepo() {
    const r = newRepo();
    const dir = path.join(r.root, 'inner');
    mkdirSync(dir);
    TestRepo.init(dir).commit('i1', { 'i.txt': 'i\n' });
    mkdirSync(path.join(r.root, 'plain'));
    writeFileSync(path.join(r.root, 'plain', 'p.txt'), 'p\n');
    return r;
  }
  const preview = async (p: Panel, change: object) => {
    const from = p.posted.length;
    await p.send({ type: 'previewChange', change });
    return p.waitFor('changePreview', { from });
  };

  test('git lista el repo anidado como una carpeta sin seguimiento', async () => {
    const p = await open(withNestedRepo().root);
    const f = (lastOf(p, 'changes').files as any[]).find(x => x.path === 'inner/' && x.repo === 0);
    assert.ok(f, 'inner/ aparece en Local Changes');
    assert.equal(f.group, 'untracked');
  });

  test('la vista previa de un repo anidado no da EISDIR: dice que es un repo anidado', async () => {
    const r = withNestedRepo();
    const p = await open(r.root);
    const m = await preview(p, { repo: 0, group: 'untracked', path: 'inner/' });
    assert.equal(m.error, undefined);
    assert.equal(m.directory, 'repo');
    assert.equal(m.text, '');
  });

  test('la vista previa de una carpeta normal tampoco da EISDIR', async () => {
    const p = await open(withNestedRepo().root);
    const m = await preview(p, { repo: 0, group: 'untracked', path: 'plain' });
    assert.equal(m.error, undefined);
    assert.equal(m.directory, 'dir');
  });

  test('los archivos de siempre se siguen viendo (sin seguimiento y binarios)', async () => {
    const r = withNestedRepo();
    writeFileSync(path.join(r.root, 'nuevo.txt'), 'hola\n');
    writeFileSync(path.join(r.root, 'bin.dat'), Buffer.from([1, 2, 0, 3]));
    const p = await open(r.root);
    const t = await preview(p, { repo: 0, group: 'untracked', path: 'nuevo.txt' });
    assert.deepEqual([t.error, t.directory, t.text], [undefined, undefined, 'hola\n']);
    const b = await preview(p, { repo: 0, group: 'untracked', path: 'bin.dat' });
    assert.equal(b.binary, true);
  });

  test('doble clic en una carpeta: se muestra en el Explorador, sin el aviso «no existe»', async () => {
    const r = withNestedRepo();
    const p = await open(r.root);
    stubState.commands = []; stubState.warnings = []; stubState.shown = [];
    await p.send({ type: 'openChange', change: { repo: 0, group: 'untracked', path: 'inner/' } });
    assert.deepEqual(stubState.warnings, []);
    assert.equal(stubState.shown.length, 0, 'no se intenta abrir como documento');
    assert.equal(stubState.commands.length, 1);
    assert.equal(stubState.commands[0][0], 'revealInExplorer');
    assert.equal((stubState.commands[0][1] as { fsPath: string }).fsPath, path.join(r.root, 'inner'));
  });

  test('un archivo que ya no existe sigue avisando de que no existe', async () => {
    const r = withNestedRepo();
    const p = await open(r.root);
    stubState.warnings = [];
    await p.send({ type: 'openChange', change: { repo: 0, group: 'untracked', path: 'fantasma.txt' } });
    assert.equal(stubState.warnings.length, 1);
    assert.match(stubState.warnings[0], /doesn't exist in the working tree/);
  });

  test('un enlace simbólico a una carpeta: la vista previa enseña el destino del enlace', async (t) => {
    const r = withNestedRepo();
    try { symlinkSync('plain', path.join(r.root, 'enlace'), 'dir'); } catch { t.skip('este sistema no deja crear enlaces simbólicos'); return; }
    const p = await open(r.root);
    const m = await preview(p, { repo: 0, group: 'untracked', path: 'enlace' });
    assert.equal(m.error, undefined);
    assert.equal(m.directory, undefined);
    assert.equal(m.text, 'plain');
  });
});
