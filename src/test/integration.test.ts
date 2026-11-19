/**
 * Tests de integración: el GitLogViewProvider real (refresh, auto-stage, commit, watchers)
 * contra repos git temporales, con el stub de «vscode» y un panel falso (ver harness.ts).
 * Cubren lo que los tests unitarios no pueden: que extension.ts use bien las piezas de core.ts.
 */
import { test, describe, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'fs';
import * as path from 'path';
import { openPanel, spyGit, until, sleep, stubState, stubConfig, Panel, Msg } from './harness';
import { TestRepo, tmpDir, rm } from './helpers';
import { Git } from '../git';
import { watchSpecs } from '../core';

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
