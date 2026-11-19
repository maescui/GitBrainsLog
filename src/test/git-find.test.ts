/**
 * findRepositories (git.ts): búsqueda de repos en las carpetas abiertas, por niveles, con
 * jbGit.repositoryScanMaxDepth (CLAUDE.md, «Varios repositorios a la vez»).
 */
import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'fs';
import * as path from 'path';
import { TestRepo, tmpDir, rm } from './helpers';
import { findRepositories } from '../git';

/** Repo nuevo en una carpeta que aún no existe. */
const repoAt = (p: string) => { mkdirSync(p, { recursive: true }); return TestRepo.init(p); };

/** Normaliza rutas para comparar (git da «C:/…» en Windows). */
const norm = (l: string[]) => l.map(p => path.resolve(p));

describe('findRepositories', () => {
  let ws: string;     // carpeta abierta (no es un repo)
  let outside: string;
  const P = (...p: string[]) => path.join(ws, ...p);
  before(() => {
    ws = tmpDir('jbgit-ws-');
    outside = tmpDir('jbgit-out-');
    // ws/a                 repo (nivel 1)
    // ws/a/sub             repo anidado, ignorado por a
    // ws/a/x/y/deep        repo a 3 niveles bajo a
    // ws/b/c               repo (nivel 2)
    // ws/d/e/f             repo (nivel 3)
    // ws/.hidden/r         repo en carpeta oculta (no se entra)
    // ws/node_modules/pkg  repo en dependencias (no se entra)
    // ws/link              enlace (junction) a un repo de fuera (no se sigue)
    const a = repoAt(P('a'));
    a.commit('a', { '.gitignore': 'sub/\n' });
    repoAt(P('a', 'sub')).commit('sub');
    repoAt(P('a', 'x', 'y', 'deep'));
    repoAt(P('b', 'c'));
    repoAt(P('d', 'e', 'f'));
    repoAt(P('.hidden', 'r'));
    repoAt(P('node_modules', 'pkg'));
    repoAt(path.join(outside, 'ext'));
    symlinkSync(path.join(outside, 'ext'), P('link'), 'junction');
  });
  after(() => { rm(ws); rm(outside); });

  test('profundidad 0: solo la carpeta abierta (que no es un repo)', async () => {
    assert.deepEqual(await findRepositories([ws], 0), []);
  });

  test('profundidad 1: hijos directos y lo que hay justo dentro de cada repo', async () => {
    assert.deepEqual(norm(await findRepositories([ws], 1)), norm([P('a'), P('a', 'sub')]));
  });

  test('profundidad 2 (por defecto): por niveles, los menos profundos primero', async () => {
    assert.deepEqual(norm(await findRepositories([ws], 2)), norm([P('a'), P('a', 'sub'), P('b', 'c')]));
  });

  test('profundidad 3: la cuenta vuelve a empezar en cada repo encontrado', async () => {
    assert.deepEqual(norm(await findRepositories([ws], 3)),
      norm([P('a'), P('a', 'sub'), P('b', 'c'), P('d', 'e', 'f'), P('a', 'x', 'y', 'deep')]));
  });

  test('nunca entra en carpetas ocultas, node_modules ni enlaces', async () => {
    const found = norm(await findRepositories([ws], 5));
    for (const p of [P('.hidden', 'r'), P('node_modules', 'pkg'), P('link'), path.join(outside, 'ext')]) {
      assert.ok(!found.includes(path.resolve(p)), `no debería encontrar ${p}`);
    }
    assert.equal(found.length, 5);
  });

  test('profundidad negativa = 0', async () => {
    assert.deepEqual(await findRepositories([ws], -3), []);
  });

  test('carpeta abierta que es un repo: va primero', async () => {
    assert.deepEqual(norm(await findRepositories([P('a')], 1)), norm([P('a'), P('a', 'sub')]));
    assert.deepEqual(norm(await findRepositories([P('a')], 0)), norm([P('a')]));
  });

  test('carpeta abierta dentro de un repo: devuelve el repo que la contiene', async () => {
    mkdirSync(P('a', 'x', 'y'), { recursive: true });
    assert.deepEqual(norm(await findRepositories([P('a', 'x')], 0)), norm([P('a')]));
    assert.deepEqual(norm(await findRepositories([P('a', 'x')], 2)), norm([P('a'), P('a', 'x', 'y', 'deep')]));
  });

  test('varias carpetas: sin repetidos', async () => {
    assert.deepEqual(norm(await findRepositories([P('a'), P('a', 'sub'), P('b')], 1)),
      norm([P('a'), P('a', 'sub'), P('b', 'c')]));
  });

  test('carpeta que no existe: nada', async () => {
    assert.deepEqual(await findRepositories([P('no-existe')], 2), []);
  });

  test('submódulo real (.git es un archivo)', async () => {
    const top = tmpDir('jbgit-sm-');
    const lib = tmpDir('jbgit-lib-');
    try {
      TestRepo.init(lib).commit('lib', { 'l.txt': '1' });
      const t = TestRepo.init(top);
      t.commit('top');
      t.git('-c', 'protocol.file.allow=always', 'submodule', '-q', 'add', lib, 'mods/lib');
      t.commit('submódulo');
      assert.deepEqual(norm(await findRepositories([top], 2)), norm([top, path.join(top, 'mods', 'lib')]));
    } finally { rm(top); rm(lib); }
  });

  // En Windows, git rev-parse --show-toplevel devuelve «C:/Users/…» y findRepositories lo
  // devuelve tal cual. La extensión compara esas raíces con rutas nativas (fsPath, con «\» y
  // la unidad en minúscula), p. ej. showHistoryForUri: p.startsWith(r.root + path.sep).
  test('devuelve rutas nativas (separador del sistema)', async () => {
    const found = await findRepositories([ws], 1);
    for (const p of found) { assert.equal(p, path.normalize(p), `ruta no nativa: ${p}`); }
  });
});
