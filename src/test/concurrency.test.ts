/**
 * Piezas de core.ts que evitan carreras: la cola del índice (auto-stage y acciones del
 * usuario), el contador de generaciones de refresh() y los patrones de los watchers.
 */
import { test, describe, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { existsSync, rmSync } from 'fs';
import * as path from 'path';
import { SerialQueue, Generation, watchSpecs } from '../core';
import { Git } from '../git';
import { TestRepo, tmpDir, rm } from './helpers';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('SerialQueue (escrituras al índice)', () => {
  test('las tareas no se solapan aunque se pidan a la vez', async () => {
    const q = new SerialQueue();
    let running = 0, maxRunning = 0;
    const task = (ms: number) => q.run(async () => {
      maxRunning = Math.max(maxRunning, ++running);
      await sleep(ms);
      running--;
    });
    await Promise.all([task(20), task(1), task(10), task(1)]);
    assert.equal(maxRunning, 1);
  });

  test('se ejecutan en el orden en que se piden', async () => {
    const q = new SerialQueue();
    const order: number[] = [];
    await Promise.all([30, 1, 15].map((ms, i) => q.run(async () => { await sleep(ms); order.push(i); })));
    assert.deepEqual(order, [0, 1, 2]);
  });

  test('devuelve el resultado de cada tarea', async () => {
    const q = new SerialQueue();
    const [a, b] = await Promise.all([q.run(async () => 'a'), q.run(async () => 2)]);
    assert.deepEqual([a, b], ['a', 2]);
  });

  test('si una falla, el error es solo de quien la pidió y las siguientes se ejecutan', async () => {
    const q = new SerialQueue();
    const bad = q.run(async () => { await sleep(5); throw new Error('index.lock'); });
    const next = q.run(async () => 'ok');
    await assert.rejects(bad, /index\.lock/);
    assert.equal(await next, 'ok');
    assert.equal(await q.run(async () => 'después'), 'después'); // la cola sigue viva
  });

  test('una tarea que lanza de forma síncrona tampoco rompe la cola', async () => {
    const q = new SerialQueue();
    await assert.rejects(q.run((() => { throw new Error('boom'); }) as () => Promise<void>), /boom/);
    assert.equal(await q.run(async () => 1), 1);
  });

  test('simula auto-stage y «−» a la vez: la lista de excluidos no pierde la exclusión', async () => {
    // El auto-stage lee la lista, espera a git y la guarda podada; el usuario añade un archivo
    // en medio. Sin cola, la poda machaca la exclusión; con cola, las dos pasan de una en una.
    const run = async (serial: boolean) => {
      let excluded = ['a.txt'];
      const q = new SerialQueue();
      const exec = <T>(fn: () => Promise<T>) => (serial ? q.run(fn) : fn());
      const prune = exec(async () => { const keep = [...excluded]; await sleep(10); excluded = keep; });
      const unstage = exec(async () => { excluded = [...excluded, 'b.txt']; });
      await Promise.all([prune, unstage]);
      return excluded;
    };
    assert.deepEqual(await run(false), ['a.txt'], 'sin cola se pierde b.txt (el fallo que se evita)');
    assert.deepEqual(await run(true), ['a.txt', 'b.txt']);
  });
});

describe('Generation (refresh() descarta lo viejo)', () => {
  test('solo la última generación no está obsoleta', () => {
    const g = new Generation();
    const a = g.begin();
    assert.equal(g.stale(a), false);
    const b = g.begin();
    assert.equal(g.stale(a), true);
    assert.equal(g.stale(b), false);
  });

  test('un refresh lento que acaba después de uno rápido no pisa sus datos', async () => {
    const g = new Generation();
    const posted: string[] = [];
    const refresh = async (label: string, ms: number) => {
      const gen = g.begin();
      await sleep(ms);                       // «git log»
      if (g.stale(gen)) { return; }
      posted.push(label);
    };
    // El filtro viejo tarda más que el nuevo y termina después
    await Promise.all([refresh('sin filtro', 30), refresh('con filtro', 1)]);
    assert.deepEqual(posted, ['con filtro']);
  });

  test('sin solapes, cada refresh publica', async () => {
    const g = new Generation();
    const posted: number[] = [];
    for (let i = 0; i < 3; i++) { const gen = g.begin(); await sleep(1); if (!g.stale(gen)) { posted.push(i); } }
    assert.deepEqual(posted, [0, 1, 2]);
  });
});

describe('watchSpecs (qué vigila cada repo)', () => {
  const dirs: string[] = [];
  after(() => dirs.forEach(rm));
  const kinds = (s: ReturnType<typeof watchSpecs>) => s.map(x => x.kind);

  test('un watcher de ramas propio, uno compartido, uno de índice y uno del árbol', () => {
    const s = watchSpecs('/r', { dir: '/r/.git', common: '/r/.git' });
    assert.deepEqual(kinds(s), ['refs', 'refs', 'index', 'tree']);
    assert.equal(s[3].dir, '/r');
    assert.equal(s[3].pattern, '**/*');
  });

  test('lo propio cuelga de dir; refs, packed-refs y stash, de common; el índice, de dir', () => {
    const s = watchSpecs('/main/wt', { dir: '/main/.git/worktrees/wt', common: '/main/.git' });
    const own = s[0], shared = s[1], index = s[2];
    assert.equal(own.dir, '/main/.git/worktrees/wt');
    for (const f of ['HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge/**', 'rebase-apply/**']) { assert.ok(own.pattern.includes(f), f); }
    assert.equal(shared.dir, '/main/.git');
    for (const f of ['packed-refs', 'refs/**', 'logs/refs/stash']) { assert.ok(shared.pattern.includes(f), f); }
    assert.ok(!shared.pattern.includes('HEAD'), 'HEAD es del worktree, no compartido');
    assert.equal(index.dir, '/main/.git/worktrees/wt');
    assert.equal(index.pattern, 'index');
  });

  test('con un worktree real: lo que vigila existe donde git lo guarda', async () => {
    const r = TestRepo.init(); dirs.push(r.root);
    r.commit('c1', { 'a.txt': 'a' });
    const wt = tmpDir(); dirs.push(wt);
    rmSync(wt, { recursive: true, force: true });
    r.git('worktree', 'add', '-q', '-b', 'other', wt);
    const d = await new Git(wt).gitDirs();
    const [own, shared, index] = watchSpecs(wt, d);
    assert.ok(existsSync(path.join(own.dir, 'HEAD')), 'el HEAD del worktree está en su directorio propio');
    assert.ok(existsSync(path.join(shared.dir, 'refs', 'heads', 'other')), 'las ramas están en el directorio común');
    assert.ok(!existsSync(path.join(wt, '.git', 'HEAD')), 'con la ruta fija <raíz>/.git no se vería nada (el fallo que se evita)');
    assert.equal(index.dir, own.dir);
  });
});
