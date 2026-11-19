/**
 * buildBlockPatch de punta a punta: se genera un diff real en un repo temporal, se construye
 * el parche de cada bloque y se aplica con git, igual que la extensión:
 *  - Stage de un bloque de Changes:   git apply --cached        (parche 'forward')
 *  - Unstage de un bloque de Staged:  git apply --cached -R     (parche 'reverse')
 *  - Rollback de un bloque de Changes: git apply -R              (parche 'reverse')
 * y se comprueba que solo ese bloque ha cambiado (CLAUDE.md, Local Changes).
 */
import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import * as path from 'path';
import { TestRepo, rm } from './helpers';
import { Git, parseDiffBlocks, buildBlockPatch } from '../git';

/**
 * Contenido esperado al mezclar las dos versiones bloque a bloque, a partir de un diff con
 * todo el archivo de contexto: el bloque k toma la versión kSide y los demás, la otra.
 */
function mixed(fullDiff: string, k: number, kSide: 'new' | 'old'): string {
  const { hunks } = parseDiffBlocks(fullDiff);
  let out = '';
  for (const h of hunks) {
    for (const e of h) {
      const side = e.block === -1 ? null : e.block === k ? kSide : (kSide === 'new' ? 'old' : 'new');
      const keep = e.t === ' ' || (side === 'new' ? e.t === '+' : e.t === '-');
      if (keep) { out += e.text + (e.noNewline ? '' : '\n'); }
    }
  }
  return out;
}

/** Generador pseudoaleatorio reproducible (mulberry32). */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('buildBlockPatch aplicado con git', () => {
  let r: TestRepo;
  let git: Git;
  const F = 'f.txt';
  before(() => {
    r = TestRepo.init();
    git = new Git(r.root);
    r.commit('init', { 'otro.txt': 'x\n' });
  });
  after(() => rm(r.root));

  const read = () => readFileSync(path.join(r.root, F), 'utf8');
  const index = () => r.git('show', `:${F}`);
  /** Deja el índice con oldText y el árbol de trabajo con newText. */
  const setup = (oldText: string, newText: string) => {
    r.write(F, oldText);
    r.git('add', F);
    r.write(F, newText);
  };

  /**
   * Para cada bloque del diff índice ↔ árbol de trabajo comprueba stage (forward) y rollback
   * (reverse), y para el diff HEAD ↔ índice, unstage (reverse con --cached).
   */
  async function checkAll(oldText: string, newText: string, label: string) {
    setup(oldText, newText);
    const diff = await git.run(['diff', '--no-color', '--no-ext-diff', '-M', '--', F]);
    const full = await git.run(['diff', '--no-color', '--no-ext-diff', '-U100000', '--', F]);
    const n = parseDiffBlocks(diff).blocks.length;
    // Con más contexto los bloques son los mismos (rachas de «-»/«+»)
    assert.deepEqual(parseDiffBlocks(full).blocks, parseDiffBlocks(diff).blocks, `${label}: bloques`);
    for (let k = 0; k < n; k++) {
      const msg = `${label}, bloque ${k}/${n}`;
      // Stage: el índice pasa a tener solo ese bloque aplicado
      setup(oldText, newText);
      const fwd = buildBlockPatch(diff, k, F, 'forward')!;
      await git.run(['apply', '--cached', '--whitespace=nowarn', '-'], fwd).catch(e => assert.fail(`${msg} (stage): ${e.message}\n${fwd}`));
      assert.equal(index(), mixed(full, k, 'new'), `${msg} (stage, índice)`);
      assert.equal(read(), newText, `${msg} (stage no toca el árbol de trabajo)`);

      // Rollback: el árbol de trabajo pierde solo ese bloque
      setup(oldText, newText);
      const rev = buildBlockPatch(diff, k, F)!;
      await git.run(['apply', '-R', '--whitespace=nowarn', '-'], rev).catch(e => assert.fail(`${msg} (rollback): ${e.message}\n${rev}`));
      assert.equal(read(), mixed(full, k, 'old'), `${msg} (rollback, árbol)`);
      assert.equal(index(), oldText, `${msg} (rollback no toca el índice)`);
    }
    // Unstage desde Staged: HEAD = oldText, índice = newText
    r.write(F, oldText);
    r.git('add', F);
    r.git('commit', '-q', '-m', 'base');
    r.write(F, newText);
    r.git('add', F);
    const sdiff = await git.run(['diff', '--no-color', '--no-ext-diff', '-M', '--cached', '--', F]);
    const sfull = await git.run(['diff', '--no-color', '--no-ext-diff', '-U100000', '--cached', '--', F]);
    for (let k = 0; k < parseDiffBlocks(sdiff).blocks.length; k++) {
      r.write(F, newText);
      r.git('add', F);
      const rev = buildBlockPatch(sdiff, k, F)!;
      await git.run(['apply', '--cached', '-R', '--whitespace=nowarn', '-'], rev).catch(e => assert.fail(`${label} bloque ${k} (unstage): ${e.message}\n${rev}`));
      assert.equal(index(), mixed(sfull, k, 'old'), `${label}, bloque ${k} (unstage, índice)`);
    }
  }

  const L = (...l: string[]) => l.map(x => x + '\n').join('');

  test('dos bloques en el mismo hunk', () => checkAll(L('a', 'b', 'c', 'd', 'e'), L('a', 'B', 'c', 'D', 'e'), 'mismo hunk'));

  test('bloques en hunks distintos', () => {
    const old = Array.from({ length: 40 }, (_, i) => `l${i}`);
    const neu = old.map((l, i) => (i === 3 ? 'X3' : i === 30 ? 'X30' : l));
    neu.splice(20, 0, 'nueva');
    return checkAll(L(...old), L(...neu), 'varios hunks');
  });

  test('solo añadidos y solo borrados, al principio y al final', () =>
    checkAll(L('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'), L('nuevo', 'a', 'b', 'd', 'e', 'f', 'g', 'h', 'fin'), 'extremos'));

  test('sin salto de línea al final (antes, después y en los dos)', async () => {
    await checkAll('a\nb\nc', 'a\nB\nc\nd\n', 'sin \\n antes');
    await checkAll('x\na\nb\nc\nd\ne\nf\ng\nh\nb', 'X\na\nb\nc\nd\ne\nf\ng\nh\nb\n', 'sin \\n en otro bloque');
    await checkAll('a\nb\nc\n', 'A\nb\nc\nd', 'sin \\n después');
    await checkAll('a\nb\nc', 'A\nb\nC', 'sin \\n en los dos');
  });

  test('CRLF', () => checkAll('a\r\nb\r\nc\r\nd\r\n', 'a\r\nB\r\nc\r\nD\r\ne\r\n', 'crlf'));

  test('archivo vacío que pasa a tener contenido y al revés', async () => {
    await checkAll('', L('a', 'b'), 'desde vacío');
    await checkAll(L('a', 'b'), '', 'a vacío');
  });

  test('líneas con «-», «+», «@@» y «\\» al principio', () =>
    checkAll(L('-- x', '++ y', '@@ z', '\\ w', 'k'), L('--- x', '+++ y', '@@ z', '\\\\ w', 'k'), 'prefijos'));

  // Pocos casos: cada uno lanza decenas de procesos git (lento en Windows)
  test('aleatorio: cada bloque por separado, 10 casos', async () => {
    const rand = rng(12345);
    const pick = (n: number) => Math.floor(rand() * n);
    for (let iter = 0; iter < 10; iter++) {
      const old = Array.from({ length: 5 + pick(40) }, () => `t${pick(12)}`);
      const neu: string[] = [];
      for (const l of old) {
        const p = rand();
        if (p < 0.1) { continue; }                          // borrar
        if (p < 0.2) { neu.push(`n${pick(12)}`); continue; } // sustituir
        if (p < 0.27) { neu.push(`i${pick(12)}`); }          // insertar antes
        neu.push(l);
      }
      const end = (a: string[]) => a.join('\n') + (a.length && rand() < 0.8 ? '\n' : '');
      const o = end(old), n = end(neu);
      if (o === n) { continue; }
      await checkAll(o, n, `caso ${iter}`);
    }
  });
});
