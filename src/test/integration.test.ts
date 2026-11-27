/**
 * Tests de integración: el GitLogViewProvider real (refresh, auto-stage, commit, watchers)
 * contra repos git temporales, con el stub de «vscode» y un panel falso (ver harness.ts).
 * Cubren lo que los tests unitarios no pueden: que extension.ts use bien las piezas de core.ts.
 */
import { test, describe, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { writeFileSync, rmSync, mkdirSync, symlinkSync, existsSync } from 'fs';
import * as path from 'path';
import { openPanel, fakeWebview, spyGit, until, sleep, stubState, stubConfig, Panel, Msg } from './harness';
import { execFileSync } from 'child_process';
import { TestRepo, GIT_ENV, tmpDir, rm } from './helpers';
import { Git } from '../git';
import { GitLogViewProvider } from '../extension';
import { watchSpecs, escAttr } from '../core';
import { watchFileIcons } from '../fileIcons';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(f => { try { f(); } catch { /* ya borrado */ } }); delete stubConfig.autoStage; delete stubConfig.repositoryScanMaxDepth; delete stubConfig.maxCommits; delete stubConfig.iconTheme; });

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

  const repoNames = (p: Panel) => (lastOf(p, 'data').repos as any[]).map(r => r.name);
  const filesOf = (p: Panel, repoName: string) => {
    const idx = repoNames(p).indexOf(repoName);
    return (lastOf(p, 'changes').files as any[]).filter(f => f.repo === idx);
  };

  test('un repo dentro de otro es un repo más: sale con su nombre y sus cambios bajo su propio nodo', async () => {
    const r = withNestedRepo();
    writeFileSync(path.join(r.root, 'inner', 'nuevo.txt'), 'n\n');
    const p = await open(r.root);
    assert.deepEqual(repoNames(p), [path.basename(r.root), 'inner']);
    assert.deepEqual(filesOf(p, 'inner').map(f => [f.group, f.path]), [['untracked', 'nuevo.txt']]);
  });

  test('…y el repo de fuera no lo lista como una carpeta sin seguimiento', async () => {
    const r = withNestedRepo();
    const p = await open(r.root);
    assert.deepEqual(filesOf(p, path.basename(r.root)).map(f => f.path), ['plain/p.txt'], 'solo lo suyo');
  });

  test('se ve aunque esté más hondo que la profundidad de búsqueda (git lo lista)', async () => {
    stubConfig.repositoryScanMaxDepth = 0;
    const r = newRepo();
    const deep = path.join(r.root, 'a', 'b', 'c', 'deep');
    mkdirSync(deep, { recursive: true });
    TestRepo.init(deep).commit('d1', { 'd.txt': 'd\n' });
    const p = await open(r.root);
    assert.deepEqual(repoNames(p), [path.basename(r.root), 'deep']);
    assert.ok(!(lastOf(p, 'changes').files as any[]).some(f => f.path.endsWith('deep/')), 'no queda como carpeta del de fuera');
  });

  test('un repo recién clonado dentro aparece como repo al refrescar, sin reabrir nada', async () => {
    const r = newRepo();
    const p = await open(r.root);
    assert.deepEqual(repoNames(p), [path.basename(r.root)]);
    const fresh = path.join(r.root, 'fresh');
    mkdirSync(fresh);
    TestRepo.init(fresh).commit('f1', { 'f.txt': 'f\n' });
    await p.provider.refreshChanges();
    const d = await p.waitFor('data', { pred: m => m.repos.length === 2, timeout: 8000 });
    assert.deepEqual(d.repos.map((x: any) => x.name), [path.basename(r.root), 'fresh']);
  });

  test('se trabaja con él: un cambio en el repo anidado se commitea en él y no en el de fuera', async () => {
    const r = withNestedRepo();
    const inner = new TestRepo(path.join(r.root, 'inner'));
    inner.write('i.txt', 'cambiado\n');
    const outerBefore = r.git('rev-list', '--count', 'HEAD').trim();
    const p = await open(r.root);
    assert.equal(filesOf(p, 'inner').find(f => f.path === 'i.txt')?.group, 'staged');
    const from = p.posted.length;
    await p.send({ type: 'commit', message: 'cambio en inner', amend: false, push: false });
    await p.waitFor('committed', { from, timeout: 5000 });
    assert.equal(inner.git('log', '-1', '--format=%s').trim(), 'cambio en inner');
    assert.equal(r.git('rev-list', '--count', 'HEAD').trim(), outerBefore, 'el de fuera no cambia');
  });

  test('«Stage All and Commit» en el repo de fuera no añade el repo anidado como repo incrustado', async () => {
    const r = withNestedRepo();
    writeFileSync(path.join(r.root, 'nuevo.txt'), 'n\n');
    const p = await open(r.root);
    const from = p.posted.length;
    const asked = p.waitFor('confirm', { from });
    const done = p.send({ type: 'commit', message: 'todo', amend: false, push: false });
    const c = await asked;
    await p.send({ type: 'confirmResult', id: c.id, ok: true, checked: false });
    await done;
    await p.waitFor('committed', { from, timeout: 5000 });
    const files = r.git('ls-tree', '-r', '--name-only', 'HEAD').trim().split('\n');
    assert.ok(files.includes('nuevo.txt') && files.includes('plain/p.txt'), 'lo suyo sí');
    assert.ok(!files.some(f => f.startsWith('inner')), 'el repo anidado no');
    assert.ok(!/^160000/m.test(r.git('ls-files', '-s')), 'sin entradas de repo incrustado (160000)');
  });

  test('Delete no manda a la papelera un repo entero', async () => {
    const r = withNestedRepo();
    const p = await open(r.root);
    stubState.warnings = [];
    const asked = p.waitFor('confirm');
    const done = p.send({ type: 'changeAction', action: 'delete', changes: [{ repo: 0, group: 'untracked', path: 'inner/' }] });
    const c = await asked;
    await p.send({ type: 'confirmResult', id: c.id, ok: true, checked: false });
    await done;
    assert.equal(stubState.warnings.length, 1);
    assert.match(stubState.warnings[0], /'inner' is a Git repository/);
    assert.ok(existsSync(path.join(r.root, 'inner', '.git')), 'el repo sigue ahí');
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

describe('grafo: la rama principal en la columna de la izquierda', () => {
  /** Columna del grafo de cada commit del último log, por mensaje. */
  const colsOf = (p: Panel) => Object.fromEntries((lastOf(p, 'data').commits as any[]).map(c => [c.subject, c.g.col]));

  /** c1 y c2 en la rama principal, y una rama que sale de c1 con un commit más nuevo que c2. */
  function repoWithNewerBranch(main: string) {
    const r = TestRepo.init(undefined, main);
    cleanup.push(() => rm(r.root));
    r.commit('c1', { 'a.txt': 'a\n' });
    r.commit('c2', { 'a.txt': 'b\n' });
    r.git('switch', '-q', '-c', 'feature', 'HEAD~1');
    r.commit('f1', { 'f.txt': 'f\n' });
    r.git('switch', '-q', main);
    return r;
  }

  test('main con una rama más nueva por encima: main en la columna 0 y la rama a su derecha', async () => {
    const p = await open(repoWithNewerBranch('main').root);
    assert.deepEqual(colsOf(p), { f1: 1, c2: 0, c1: 0 });
  });

  test('igual con master', async () => {
    const p = await open(repoWithNewerBranch('master').root);
    assert.deepEqual(colsOf(p), { f1: 1, c2: 0, c1: 0 });
  });

  test('sin main ni master el grafo se reparte como siempre', async () => {
    const p = await open(repoWithNewerBranch('trunk').root);
    assert.deepEqual(colsOf(p), { f1: 0, c2: 1, c1: 0 });
  });

  test('si main está a la derecha por una rama checked-out, también se coloca a la izquierda', async () => {
    const r = repoWithNewerBranch('main');
    r.git('switch', '-q', 'feature');                       // HEAD en la rama; main sigue siendo la principal
    const p = await open(r.root);
    assert.deepEqual(colsOf(p), { f1: 1, c2: 0, c1: 0 });
  });
});

describe('barra del Log (Fetch, Pull, Push): solo en los repos que deja pasar el filtro Paths', () => {
  /** Un repo con su remoto (un repo «bare» local) y su rama main siguiendo a origin/main. */
  function repoWithRemote(): TestRepo {
    const r = newRepo();
    const bare = tmpDir();
    cleanup.push(() => rm(bare));
    new TestRepo(bare).git('init', '-q', '--bare', '-b', 'main');
    r.git('remote', 'add', 'origin', bare);
    r.git('push', '-q', '-u', 'origin', 'main');
    return r;
  }
  const name = (r: TestRepo) => path.basename(r.root);

  /** Abre el panel con estos repos y anota sobre cuáles actúan Fetch, Pull y Push (sin tocar la red). */
  async function openWith(...repos: TestRepo[]) {
    const p = await open(...repos.map(r => r.root));
    const calls = { fetch: [] as string[], pull: [] as string[], push: [] as string[] };
    p.provider.exec = async (repo: any, args: string[]) => { if (args[0] === 'fetch') { calls.fetch.push(path.basename(repo.root)); } };
    p.provider.pull = async (repo: any) => { calls.pull.push(path.basename(repo.root)); };
    p.provider.push = async (targets: any[]) => { calls.push.push(...targets.map(t => path.basename(t.repo.root))); };
    const bar = async () => { for (const action of ['fetch', 'pull', 'push']) { await p.send({ type: 'repoAction', action }); } };
    const filter = (value: object) => p.send({ type: 'logFilter', key: 'paths', value });
    const sorted = (x: string[]) => [...x].sort();
    return { p, calls, bar, filter, sorted };
  }

  test('sin filtro, actúan en todos los repos', async () => {
    const [a, b] = [repoWithRemote(), repoWithRemote()];
    const t = await openWith(a, b);
    await t.bar();
    const all = t.sorted([name(a), name(b)]);
    assert.deepEqual(t.sorted(t.calls.fetch), all);
    assert.deepEqual(t.sorted(t.calls.pull), all);
    assert.deepEqual(t.sorted(t.calls.push), all);
  });

  test('con el filtro Paths en un repo, solo actúan en ese repo', async () => {
    const [a, b] = [repoWithRemote(), repoWithRemote()];
    const t = await openWith(a, b);
    await t.filter({ roots: [a.root], paths: [] });
    await t.bar();
    assert.deepEqual(t.calls, { fetch: [name(a)], pull: [name(a)], push: [name(a)] });
  });

  test('con el filtro Paths en una carpeta o archivo de un repo, solo actúan en ese repo', async () => {
    const [a, b] = [repoWithRemote(), repoWithRemote()];
    const t = await openWith(a, b);
    await t.filter({ roots: [], paths: [path.join(b.root, 'a.txt')] });
    await t.bar();
    assert.deepEqual(t.calls, { fetch: [name(b)], pull: [name(b)], push: [name(b)] });
  });

  test('al quitar el filtro vuelven a actuar en todos', async () => {
    const [a, b] = [repoWithRemote(), repoWithRemote()];
    const t = await openWith(a, b);
    await t.filter({ roots: [a.root], paths: [] });
    await t.filter({ roots: [], paths: [] });
    await t.bar();
    assert.deepEqual(t.sorted(t.calls.fetch), t.sorted([name(a), name(b)]));
  });

  test('si el repo filtrado no tiene remoto, avisa y no toca el otro', async () => {
    const [withRemote, plain] = [repoWithRemote(), newRepo()];
    const t = await openWith(withRemote, plain);
    await t.filter({ roots: [plain.root], paths: [] });
    stubState.warnings = [];
    await t.bar();
    assert.deepEqual(t.calls.fetch, [], 'el repo con remoto queda fuera del filtro');
    assert.deepEqual(t.calls.pull, []);
    assert.ok(stubState.warnings.some(w => /No remote configured/.test(w)), 'fetch avisa');
    assert.ok(stubState.warnings.some(w => /no upstream branch/.test(w)), 'pull avisa');
  });
});

describe('búsqueda del log en todo el historial (no solo lo cargado)', () => {
  const TOTAL = 130, LOADED = 100;   // el log carga como mucho 100 (mínimo del ajuste maxCommits)
  const subjectOf = (i: number) => `commit-${String(i).padStart(3, '0')}`;
  /** Un repo con TOTAL commits (git fast-import: al instante), de dos autores que se alternan; el más viejo es el 1. */
  function bulkRepo(): TestRepo {
    const r = TestRepo.init();
    cleanup.push(() => rm(r.root));
    let s = '';
    for (let i = 1; i <= TOTAL; i++) {
      const who = i % 2 ? 'Ana García <ana@x.es>' : 'Luis Martín <luis@y.com>';
      const msg = subjectOf(i);
      s += `commit refs/heads/main\nmark :${i}\nauthor ${who} ${1_700_000_000 + i * 60} +0000\ncommitter ${who} ${1_700_000_000 + i * 60} +0000\n`
        + `data ${Buffer.byteLength(msg)}\n${msg}\n${i > 1 ? `from :${i - 1}\n` : ''}\n`;
    }
    execFileSync('git', ['fast-import', '--quiet'], { cwd: r.root, input: s, env: GIT_ENV });
    return r;
  }
  const search = async (p: Panel, q: string, seq = 1) => {
    const from = p.posted.length;
    await p.send({ type: 'searchLog', q, seq });
    return p.waitFor('searchResults', { from, pred: m => m.seq === seq });
  };
  const loadedSubjects = (p: Panel) => (lastOf(p, 'data').commits as any[]).map(c => c.subject);

  test('el log solo carga 100, pero la búsqueda encuentra un commit más viejo', async () => {
    stubConfig.maxCommits = LOADED;
    const p = await open(bulkRepo().root);
    assert.equal(lastOf(p, 'data').commits.length, LOADED);
    assert.ok(!loadedSubjects(p).includes('commit-005'), 'el commit 5 no está cargado');
    const m = await search(p, 'commit-005');
    assert.equal(m.error, undefined);
    assert.deepEqual(m.commits.map((c: any) => c.subject), ['commit-005']);
    assert.equal(m.truncated, false);
  });

  test('por el principio del hash de un commit que no está cargado', async () => {
    stubConfig.maxCommits = LOADED;
    const r = bulkRepo();
    const old = r.git('log', '--format=%H', '--grep=^commit-003$').trim();
    const p = await open(r.root);
    assert.ok(!loadedSubjects(p).includes('commit-003'));
    const m = await search(p, old.slice(0, 9));
    assert.deepEqual(m.commits.map((c: any) => c.subject), ['commit-003']);
  });

  test('por autor: todos sus commits del historial, no solo los cargados', async () => {
    stubConfig.maxCommits = LOADED;
    const p = await open(bulkRepo().root);
    const loadedLuis = (lastOf(p, 'data').commits as any[]).filter(c => c.author === 'Luis Martín').length;
    const m = await search(p, 'luis');
    assert.equal(m.commits.length, TOTAL / 2);
    assert.ok(m.commits.length > loadedLuis, 'más que los que había cargados');
    assert.ok(m.commits.every((c: any) => c.author === 'Luis Martín'));
  });

  test('cada resultado trae lo que necesita una fila del log (ids con el repo, padres, hash real)', async () => {
    stubConfig.maxCommits = LOADED;
    const r = bulkRepo();
    const p = await open(r.root);
    const [c] = (await search(p, 'commit-010')).commits;
    const sha = r.git('log', '--format=%H', '--grep=^commit-010$').trim();
    const parent = r.git('rev-parse', `${sha}^`).trim();
    assert.equal(c.sha, sha);
    assert.equal(c.hash, `0:${sha}`);
    assert.equal(c.repo, 0);
    assert.deepEqual(c.parents, [`0:${parent}`]);
    assert.deepEqual([c.author, c.email, typeof c.time, typeof c.ctime], ['Luis Martín', 'luis@y.com', 'number', 'number']);
  });

  test('se puede seleccionar un resultado que no estaba cargado y ver sus detalles', async () => {
    stubConfig.maxCommits = LOADED;
    const p = await open(bulkRepo().root);
    const [c] = (await search(p, 'commit-002')).commits;
    const from = p.posted.length;
    await p.send({ type: 'selectCommit', hash: c.hash });
    const d = await p.waitFor('details', { from, pred: m => m.details?.hash === c.hash });
    assert.equal(d.details.subject ?? d.details.message?.split('\n')[0], 'commit-002');
  });

  test('varias búsquedas seguidas: solo contesta la última', async () => {
    stubConfig.maxCommits = LOADED;
    const p = await open(bulkRepo().root);
    const from = p.posted.length;
    await Promise.all([p.send({ type: 'searchLog', q: 'commit-001', seq: 1 }), p.send({ type: 'searchLog', q: 'commit-002', seq: 2 })]);
    const answers = p.since('searchResults', from);
    assert.deepEqual(answers.map(m => m.seq), [2], 'la petición vieja se descarta');
    assert.deepEqual(answers[0].commits.map((c: any) => c.subject), ['commit-002']);
  });

  test('sin texto, o sin coincidencias: vacío y sin error', async () => {
    stubConfig.maxCommits = LOADED;
    const p = await open(bulkRepo().root);
    for (const q of ['', '   ', 'no-existe-en-ningun-commit']) {
      const m = await search(p, q, p.posted.length + 1);
      assert.deepEqual([m.commits, m.truncated, m.error], [[], false, undefined], JSON.stringify(q));
    }
  });

  test('un texto con caracteres raros se busca tal cual, sin error', async () => {
    stubConfig.maxCommits = LOADED;
    const p = await open(bulkRepo().root);
    for (const q of ['.*', '[', '(', '\\', '--all', "'; rm -rf /", 'commit-0*']) {
      const m = await search(p, q, p.posted.length + 1);
      assert.equal(m.error, undefined, JSON.stringify(q));
      assert.deepEqual(m.commits, [], JSON.stringify(q));
    }
  });

  test('respeta el filtro Paths: solo busca en los repos que deja pasar', async () => {
    const [a, b] = [newRepo(), newRepo()];
    a.commit('solo-en-a', { 'a.txt': 'x\n' });
    b.commit('solo-en-b', { 'b.txt': 'x\n' });
    const p = await open(a.root, b.root);
    const idx = (lastOf(p, 'data').repos as any[]).findIndex(r => path.resolve(r.root) === path.resolve(a.root));
    assert.deepEqual((await search(p, 'solo-en-b', 1)).commits.map((c: any) => c.subject), ['solo-en-b'], 'sin filtro, se encuentra');
    await p.send({ type: 'logFilter', key: 'paths', value: { roots: [a.root], paths: [] } });
    assert.deepEqual((await search(p, 'solo-en-b', 2)).commits, [], 'con el filtro en el repo a, no');
    const inA = (await search(p, 'solo-en-a', 3)).commits;
    assert.deepEqual(inA.map((c: any) => [c.subject, c.repo]), [['solo-en-a', idx]]);
  });

  test('respeta el filtro de rama: lo que está solo en otra rama no sale', async () => {
    const r = newRepo();
    r.git('switch', '-q', '-c', 'feature');
    r.commit('solo-en-feature', { 'f.txt': 'x\n' });
    r.git('switch', '-q', 'main');
    r.commit('solo-en-main', { 'm.txt': 'x\n' });
    const p = await open(r.root);
    assert.equal((await search(p, 'solo-en-feature', 1)).commits.length, 1, 'sin filtro de rama (todas), sale');
    await p.send({ type: 'filter', ref: 'refs/heads/main' });
    assert.deepEqual((await search(p, 'solo-en-feature', 2)).commits, [], 'filtrado a main, no');
    assert.equal((await search(p, 'solo-en-main', 3)).commits.length, 1);
  });

  test('varios repos: los resultados salen juntos, del más nuevo al más viejo', async () => {
    const [a, b] = [newRepo(), newRepo()];
    a.commit('hallazgo uno', { 'a.txt': 'x\n' });
    b.commit('hallazgo dos', { 'b.txt': 'x\n' });
    a.commit('hallazgo tres', { 'a.txt': 'y\n' });
    const p = await open(a.root, b.root);
    const m = await search(p, 'hallazgo');
    assert.equal(m.commits.length, 3);
    for (let i = 1; i < m.commits.length; i++) { assert.ok(m.commits[i - 1].ctime >= m.commits[i].ctime); }
    assert.deepEqual(new Set(m.commits.map((c: any) => c.repo)), new Set([0, 1]));
  });
});

describe('iconos de archivos: el tema de iconos de VS Code llega a la página', () => {
  /** Una extensión de iconos de mentira (con su tema y sus SVG) en una carpeta temporal. */
  function themeExtension(id = 'mi-tema', themeJson?: string): { packageJSON: any; extensionPath: string } {
    const dir = tmpDir('jbgit-iconext-');
    cleanup.push(() => rm(dir));
    mkdirSync(path.join(dir, 'icons'), { recursive: true });
    for (const n of ['file', 'folder', 'ts', 'light-file']) { writeFileSync(path.join(dir, 'icons', `${n}.svg`), `<svg xmlns="http://www.w3.org/2000/svg"><!--${id}-${n}--></svg>`); }
    writeFileSync(path.join(dir, 'theme.json'), themeJson ?? JSON.stringify({
      iconDefinitions: {
        file: { iconPath: './icons/file.svg' }, folder: { iconPath: './icons/folder.svg' }, ts: { iconPath: './icons/ts.svg' }, lightFile: { iconPath: './icons/light-file.svg' },
      },
      file: 'file', folder: 'folder', fileExtensions: { ts: 'ts' }, light: { file: 'lightFile' },
    }));
    return { packageJSON: { contributes: { iconThemes: [{ id, path: './theme.json' }] } }, extensionPath: dir };
  }
  /** Abre el panel con ese tema de iconos activo (las extensiones se preparan antes de que la página mande «ready»). */
  async function openWith(iconTheme: string | null, ...exts: { packageJSON: any; extensionPath: string }[]) {
    const r = newRepo();
    const p = await openPanel([r.root], { setup: () => { stubState.extensions = exts; stubConfig.iconTheme = iconTheme; } });
    cleanup.push(() => p.dispose());
    return p;
  }
  const themes = (p: Panel) => p.posted.filter(m => m.type === 'iconTheme');
  const decode = (uri: string) => Buffer.from(uri.split(',')[1], 'base64').toString('utf8');

  test('al arrancar la página recibe el tema activo, con sus iconos como data: URI', async () => {
    const p = await openWith('mi-tema', themeExtension());
    await until(() => themes(p).length >= 1, 'el mensaje iconTheme');
    const t = themes(p)[0].theme;
    assert.equal(t.id, 'mi-tema');
    assert.equal(decode(t.defs.ts.src), '<svg xmlns="http://www.w3.org/2000/svg"><!--mi-tema-ts--></svg>');
    assert.deepEqual([t.file, t.folder, t.fileExtensions], ['file', 'folder', { ts: 'ts' }]);
  });

  test('con «None» (null) llega un tema null: iconos de siempre', async () => {
    const p = await openWith(null, themeExtension());
    await until(() => themes(p).length >= 1, 'el mensaje iconTheme');
    assert.equal(themes(p)[0].theme, null);
  });

  test('un tema que ninguna extensión instalada trae: null', async () => {
    const p = await openWith('no-existe', themeExtension());
    await until(() => themes(p).length >= 1, 'el mensaje iconTheme');
    assert.equal(themes(p)[0].theme, null);
  });

  test('un tema que no se puede leer: null y sin error en la página', async () => {
    const p = await openWith('mi-tema', themeExtension('mi-tema', '{ esto no es json'));
    await until(() => themes(p).length >= 1, 'el mensaje iconTheme');
    assert.equal(themes(p)[0].theme, null);
    assert.equal(p.posted.filter(m => m.type === 'error').length, 0);
  });

  test('si el usuario cambia de tema de iconos, la página recibe el nuevo', async () => {
    const p = await openWith('mi-tema', themeExtension('mi-tema'), themeExtension('otro'));
    await until(() => themes(p).length >= 1, 'el primer tema');
    const w = watchFileIcons(); cleanup.push(() => w.dispose());
    stubConfig.iconTheme = 'otro';
    stubState.changeConfig('workbench.iconTheme');
    await until(() => themes(p).some(m => m.theme?.id === 'otro'), 'el tema nuevo');
    stubConfig.iconTheme = null;
    stubState.changeConfig('workbench.iconTheme');
    await until(() => themes(p).some(m => m.theme === null), 'None');
  });

  test('si cambia el tema de color a uno claro, llega la variante clara del tema', async () => {
    const p = await openWith('mi-tema', themeExtension());
    await until(() => themes(p).length >= 1, 'el primer tema');
    assert.equal(themes(p)[0].theme.file, 'file');
    const w = watchFileIcons(); cleanup.push(() => w.dispose());
    stubState.changeColorTheme(1);
    await until(() => themes(p).some(m => m.theme?.file === 'lightFile'), 'la variante clara');
  });

  test('si se instalan extensiones, se vuelve a leer (el tema puede ser nuevo)', async () => {
    const p = await openWith('mi-tema');                       // el tema aún no está instalado
    await until(() => themes(p).length >= 1, 'el primer mensaje');
    assert.equal(themes(p)[0].theme, null);
    const w = watchFileIcons(); cleanup.push(() => w.dispose());
    stubState.extensions = [themeExtension()];
    stubState.changeExtensions();
    await until(() => themes(p).some(m => m.theme?.id === 'mi-tema'), 'el tema ya instalado');
  });

  test('otros ajustes de VS Code no mandan nada', async () => {
    const p = await openWith('mi-tema', themeExtension());
    await until(() => themes(p).length >= 1, 'el primer tema');
    const w = watchFileIcons(); cleanup.push(() => w.dispose());
    const before = themes(p).length;
    stubState.changeConfig('editor.fontSize');
    await sleep(150);
    assert.equal(themes(p).length, before);
  });

  test('al cerrar el panel deja de mandar', async () => {
    const p = await openWith('mi-tema', themeExtension());
    await until(() => themes(p).length >= 1, 'el primer tema');
    const w = watchFileIcons(); cleanup.push(() => w.dispose());
    p.dispose();
    const before = themes(p).length;
    stubState.changeConfig('workbench.iconTheme');
    await sleep(150);
    assert.equal(themes(p).length, before);
  });
});
