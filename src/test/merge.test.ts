/**
 * Tests de parseHunks y diff3 (src/merge.ts), el visor de conflictos de tres columnas.
 * Los bloques salen de `git diff --no-index -U0` reales (como Git.diffFiles) y el resultado
 * se compara con `git merge-file` como oráculo.
 */
import './vscode-stub';
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { writeFileSync, readFileSync } from 'fs';
import * as path from 'path';
import { parseHunks, diff3, MergeSegment, MergePanel } from '../merge';
import { Git } from '../git';
import { tmpDir, rm, TestRepo, GIT_ENV } from './helpers';

const dir = tmpDir('jbgit-merge-test-');
process.on('exit', () => rm(dir));

/** Escribe un archivo como MergePanel.open (líneas + «\n» final, o vacío). */
function writeLines(name: string, lines: string[]): string {
  const p = path.join(dir, name);
  writeFileSync(p, lines.length ? lines.join('\n') + '\n' : '');
  return p;
}

function git(args: string[], cwd = dir) {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) { throw r.error; }
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** Igual que Git.diffFiles (+ opciones extra para el oráculo). */
function diffFiles(a: string, b: string, extra: string[] = []): string {
  const r = git(['diff', '--no-index', '--no-color', '--no-ext-diff', '-U0', ...extra, '--', a, b]);
  assert.ok(r.code === 0 || r.code === 1, r.err);
  return r.out;
}

/** diff3 con los bloques de git, como MergePanel.open. */
function merge3(base: string[], ours: string[], theirs: string[], extra: string[] = []): MergeSegment[] {
  const pb = writeLines('base', base), po = writeLines('ours', ours), pt = writeLines('theirs', theirs);
  return diff3(base, ours, theirs, parseHunks(diffFiles(pb, po, extra), 'o'), parseHunks(diffFiles(pb, pt, extra), 't'));
}

/** Las tres versiones se reconstruyen a partir de los segmentos; y cada tipo es coherente. */
function checkSegments(segs: MergeSegment[], base: string[], ours: string[], theirs: string[]) {
  const pick = (k: 'base' | 'ours' | 'theirs') => segs.flatMap(s => (s.kind === 'common' ? s.lines : s[k]));
  assert.deepEqual(pick('base'), base, 'la base se reconstruye');
  assert.deepEqual(pick('ours'), ours, 'ours se reconstruye');
  assert.deepEqual(pick('theirs'), theirs, 'theirs se reconstruye');
  segs.forEach((s, i) => {
    if (s.kind === 'common') {
      assert.ok(s.lines.length > 0, `segmento común vacío en ${i}`);
      assert.notEqual(segs[i + 1]?.kind, 'common', `dos comunes seguidos en ${i}`);
      return;
    }
    const eq = (a: string[], b: string[]) => a.length === b.length && a.every((l, k) => l === b[k]);
    if (s.kind === 'ours') { assert.ok(eq(s.theirs, s.base), `ours: theirs debe ser la base (${i})`); assert.ok(!eq(s.ours, s.base) || s.base.length === 0); }
    if (s.kind === 'theirs') { assert.ok(eq(s.ours, s.base), `theirs: ours debe ser la base (${i})`); }
    if (s.kind === 'same') { assert.ok(eq(s.ours, s.theirs), `same: los dos lados iguales (${i})`); }
    if (s.kind === 'conflict') { assert.ok(!eq(s.ours, s.theirs), `conflict con los dos lados iguales (${i})`); }
  });
}

/** Resultado aplicando los cambios sin conflicto y eligiendo un lado en los conflictos. */
function resolve(segs: MergeSegment[], side: 'ours' | 'theirs' | 'markers'): string {
  const out: string[] = [];
  for (const s of segs) {
    if (s.kind === 'common') { out.push(...s.lines); }
    else if (s.kind === 'ours' || s.kind === 'same') { out.push(...s.ours); }
    else if (s.kind === 'theirs') { out.push(...s.theirs); }
    else if (side === 'markers') {
      out.push('<<<<<<< ours', ...s.ours, '||||||| base', ...s.base, '=======', ...s.theirs, '>>>>>>> theirs');
    } else { out.push(...s[side]); }
  }
  return out.length ? out.join('\n') + '\n' : '';
}

/** git merge-file -p como oráculo. */
function mergeFile(base: string[], ours: string[], theirs: string[], flags: string[]): string {
  const pb = writeLines('mf-base', base), po = writeLines('mf-ours', ours), pt = writeLines('mf-theirs', theirs);
  const r = git(['merge-file', '-p', ...flags, '-L', 'ours', '-L', 'base', '-L', 'theirs', po, pb, pt]);
  assert.ok(r.code !== null && r.code >= 0 && r.code < 128, r.err);
  return r.out;
}

// ---------------------------------------------------------------------------

describe('parseHunks', () => {
  test('cabeceras con y sin longitud, posiciones desde 0', () => {
    const d = [
      'diff --git a/x b/x', '--- a/x', '+++ b/x',
      '@@ -5 +5 @@ function foo() {', '-a', '+b',
      '@@ -3,0 +4,2 @@', '+x', '+y',
      '@@ -8,2 +9,0 @@', '-p', '-q',
      '@@ -0,0 +1,3 @@', '+1', '+2', '+3',
      '@@ -10,3 +11 @@', '-a', '-b', '-c', '+d',
    ].join('\n');
    assert.deepEqual(parseHunks(d, 'o'), [
      { side: 'o', bs: 4, bl: 1, ss: 4, sl: 1 },
      { side: 'o', bs: 3, bl: 0, ss: 3, sl: 2 },   // inserción tras la línea 3
      { side: 'o', bs: 7, bl: 2, ss: 9, sl: 0 },   // borrado de las líneas 8-9 (con longitud 0, «+9,0» = tras la línea 9 del lado)
      { side: 'o', bs: 0, bl: 0, ss: 0, sl: 3 },   // inserción al principio
      { side: 'o', bs: 9, bl: 3, ss: 10, sl: 1 },
    ]);
  });

  test('las líneas de contenido que parecen cabeceras no cuentan', () => {
    const d = '@@ -1 +1 @@\n-@@ -9 +9 @@\n+@@ -7 +7 @@\n';
    assert.equal(parseHunks(d, 't').length, 1);
  });

  test('salida vacía (sin cambios)', () => assert.deepEqual(parseHunks('', 'o'), []));

  test('coincide con git diff real en inserciones al principio, al final y borrados', () => {
    const base = ['a', 'b', 'c'];
    const pb = writeLines('pb', base);
    assert.deepEqual(parseHunks(diffFiles(pb, writeLines('p1', ['x', 'a', 'b', 'c'])), 'o'), [{ side: 'o', bs: 0, bl: 0, ss: 0, sl: 1 }]);
    assert.deepEqual(parseHunks(diffFiles(pb, writeLines('p2', ['a', 'b', 'c', 'z'])), 'o'), [{ side: 'o', bs: 3, bl: 0, ss: 3, sl: 1 }]);
    assert.deepEqual(parseHunks(diffFiles(pb, writeLines('p3', ['a', 'c'])), 'o'), [{ side: 'o', bs: 1, bl: 1, ss: 1, sl: 0 }]);
    assert.deepEqual(parseHunks(diffFiles(pb, writeLines('p4', [])), 'o'), [{ side: 'o', bs: 0, bl: 3, ss: 0, sl: 0 }]);
    assert.deepEqual(parseHunks(diffFiles(writeLines('p5', []), pb), 'o'), [{ side: 'o', bs: 0, bl: 0, ss: 0, sl: 3 }]);
  });
});

describe('diff3: bloques a mano', () => {
  const B = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

  test('sin cambios: un solo segmento común', () => {
    assert.deepEqual(diff3(B, B, B, [], []), [{ kind: 'common', lines: B }]);
  });

  test('archivo vacío en las tres versiones: sin segmentos', () => {
    assert.deepEqual(diff3([], [], [], [], []), []);
  });

  test('cambio solo en ours se aplica solo; solo en theirs igual', () => {
    const ours = ['1', 'X', '3', '4', '5', '6', '7', '8', '9'];
    const segs = merge3(B, ours, B);
    assert.deepEqual(segs.map(s => s.kind), ['common', 'ours', 'common']);
    checkSegments(segs, B, ours, B);
    const segs2 = merge3(B, B, ours);
    assert.deepEqual(segs2.map(s => s.kind), ['common', 'theirs', 'common']);
  });

  test('el mismo cambio en los dos lados: same', () => {
    const x = ['1', '2', 'X', '4', '5', '6', '7', '8', '9'];
    const segs = merge3(B, x, x);
    assert.deepEqual(segs.map(s => s.kind), ['common', 'same', 'common']);
  });

  test('cambios que se solapan: un conflicto', () => {
    const ours = ['1', 'A', 'A', '4', '5', '6', '7', '8', '9'];
    const theirs = ['1', '2', 'T', 'T', '5', '6', '7', '8', '9'];
    const segs = merge3(B, ours, theirs);
    assert.deepEqual(segs.map(s => s.kind), ['common', 'conflict', 'common']);
    const c = segs[1] as Exclude<MergeSegment, { kind: 'common' }>;
    assert.deepEqual(c.base, ['2', '3', '4']);
    assert.deepEqual(c.ours, ['A', 'A', '4']);
    assert.deepEqual(c.theirs, ['2', 'T', 'T']);
  });

  test('cambios que se tocan (contiguos) forman un solo conflicto', () => {
    const ours = ['1', 'A', '3', '4', '5', '6', '7', '8', '9'];
    const theirs = ['1', '2', 'T', '4', '5', '6', '7', '8', '9'];
    const segs = merge3(B, ours, theirs);
    assert.deepEqual(segs.map(s => s.kind), ['common', 'conflict', 'common']);
    checkSegments(segs, B, ours, theirs);
  });

  test('cambios separados por una línea sin tocar: dos bloques independientes', () => {
    const ours = ['1', 'A', '3', '4', '5', '6', '7', '8', '9'];
    const theirs = ['1', '2', '3', 'T', '5', '6', '7', '8', '9'];
    const segs = merge3(B, ours, theirs);
    assert.deepEqual(segs.map(s => s.kind), ['common', 'ours', 'common', 'theirs', 'common']);
  });

  test('inserciones en el mismo punto con distinto contenido: conflicto con base vacía', () => {
    const ours = ['1', '2', 'o', '3', '4', '5', '6', '7', '8', '9'];
    const theirs = ['1', '2', 't', '3', '4', '5', '6', '7', '8', '9'];
    const segs = merge3(B, ours, theirs);
    const c = segs.find(s => s.kind === 'conflict') as Exclude<MergeSegment, { kind: 'common' }>;
    assert.ok(c);
    assert.deepEqual(c.base, []);
    checkSegments(segs, B, ours, theirs);
  });

  test('inserción en un lado justo donde el otro cambia una línea: conflicto (se tocan)', () => {
    const ours = ['1', '2', 'new', '3', '4', '5', '6', '7', '8', '9'];
    const theirs = ['1', '2', 'T', '4', '5', '6', '7', '8', '9'];
    const segs = merge3(B, ours, theirs);
    checkSegments(segs, B, ours, theirs);
    assert.equal(resolve(segs, 'markers'), mergeFile(B, ours, theirs, ['--diff3']));
  });

  test('inserciones al principio y al final del archivo', () => {
    const ours = ['top', ...B];
    const theirs = [...B, 'bottom'];
    const segs = merge3(B, ours, theirs);
    assert.deepEqual(segs.map(s => s.kind), ['ours', 'common', 'theirs']);
    assert.equal(resolve(segs, 'ours'), [...ours, 'bottom'].join('\n') + '\n');
  });

  test('base vacía y los dos lados añaden', () => {
    const segs = merge3([], ['a', 'b'], ['c']);
    assert.deepEqual(segs, [{ kind: 'conflict', base: [], ours: ['a', 'b'], theirs: ['c'] }]);
    assert.deepEqual(merge3([], ['a'], ['a']), [{ kind: 'same', base: [], ours: ['a'], theirs: ['a'] }]);
    assert.deepEqual(merge3([], ['a'], []), [{ kind: 'ours', base: [], ours: ['a'], theirs: [] }]);
  });

  test('un lado vacía el archivo y el otro no lo toca: se aplica el borrado', () => {
    const segs = merge3(B, [], B);
    assert.deepEqual(segs, [{ kind: 'ours', base: B, ours: [], theirs: B }]);
    assert.equal(resolve(segs, 'ours'), '');
  });

  test('un lado vacía el archivo y el otro cambia una línea: conflicto', () => {
    const theirs = ['1', '2', '3', 'T', '5', '6', '7', '8', '9'];
    const segs = merge3(B, [], theirs);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].kind, 'conflict');
    checkSegments(segs, B, [], theirs);
  });

  test('borrados en los dos lados de las mismas líneas: same', () => {
    const x = ['1', '2', '5', '6', '7', '8', '9'];
    const segs = merge3(B, x, x);
    assert.deepEqual(segs.map(s => s.kind), ['common', 'same', 'common']);
  });

  test('borrado en un lado que contiene el cambio del otro: un conflicto', () => {
    const ours = ['1', '7', '8', '9'];
    const theirs = ['1', '2', '3', 'T', '5', '6', '7', '8', '9'];
    const segs = merge3(B, ours, theirs);
    checkSegments(segs, B, ours, theirs);
    assert.deepEqual(segs.map(s => s.kind), ['common', 'conflict', 'common']);
  });

  test('cadena de bloques alternos que se tocan (o, t, o): un solo grupo', () => {
    // ours cambia 2 y 4, theirs cambia 3: todo se toca
    const ours = ['1', 'A', '3', 'B', '5', '6', '7', '8', '9'];
    const theirs = ['1', '2', 'T', '4', '5', '6', '7', '8', '9'];
    const segs = merge3(B, ours, theirs);
    assert.deepEqual(segs.map(s => s.kind), ['common', 'conflict', 'common']);
    checkSegments(segs, B, ours, theirs);
    assert.equal(resolve(segs, 'markers'), mergeFile(B, ours, theirs, ['--diff3']));
  });

  test('muchos bloques: los desplazamientos de cada lado se acumulan bien', () => {
    const base = Array.from({ length: 60 }, (_, i) => `l${i}`);
    const ours = [...base], theirs = [...base];
    // ours: inserta 2 líneas cada 10; theirs: borra una línea cada 10 (en otro sitio)
    for (let i = 50; i >= 0; i -= 10) { ours.splice(i + 2, 0, `o${i}a`, `o${i}b`); }
    for (let i = 55; i >= 5; i -= 10) { theirs.splice(i, 1); }
    const segs = merge3(base, ours, theirs);
    checkSegments(segs, base, ours, theirs);
    assert.ok(!segs.some(s => s.kind === 'conflict'));
    assert.equal(resolve(segs, 'ours'), mergeFile(base, ours, theirs, []));
  });

  test('bloques a mano sin git: hunks desordenados entre lados', () => {
    // ours cambia la línea 7 (índice 6); theirs la 1 (índice 0). Se pasan en cualquier orden
    const ours = ['1', '2', '3', '4', '5', '6', 'O', '8', '9'];
    const theirs = ['T', '2', '3', '4', '5', '6', '7', '8', '9'];
    const segs = diff3(B, ours, theirs, [{ side: 'o', bs: 6, bl: 1, ss: 6, sl: 1 }], [{ side: 't', bs: 0, bl: 1, ss: 0, sl: 1 }]);
    assert.deepEqual(segs.map(s => s.kind), ['theirs', 'common', 'ours', 'common']);
    checkSegments(segs, B, ours, theirs);
  });
});

// ---------------------------------------------------------------------------
// Generador aleatorio: base con pocas palabras distintas (para que haya líneas repetidas)
// ---------------------------------------------------------------------------
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function mutate(base: string[], r: () => number, tag: string, rate: number): string[] {
  const out: string[] = [];
  for (let i = 0; i <= base.length; i++) {
    const x = r();
    if (x < rate / 3) { out.push(`${tag}${Math.floor(r() * 4)}`); }          // inserción antes
    if (i === base.length) { break; }
    const y = r();
    if (y < rate / 3) { continue; }                                         // borrado
    if (y < (2 * rate) / 3) { out.push(`${tag}${Math.floor(r() * 4)}`); continue; } // cambio
    out.push(base[i]);
  }
  return out;
}
const WORDS = ['a', 'b', 'c', 'd', '{', '}', '', 'x'];
function randomCase(seed: number) {
  const r = rng(seed);
  const n = Math.floor(r() * 25);
  const base = Array.from({ length: n }, (_, i) => (r() < 0.4 ? WORDS[Math.floor(r() * WORDS.length)] : `line${i}`));
  // A veces los dos lados hacen el mismo cambio
  const ours = mutate(base, r, 'o', 0.25);
  const theirs = r() < 0.15 ? [...ours] : mutate(base, r, r() < 0.3 ? 'o' : 't', 0.25);
  return { base, ours, theirs };
}

describe('diff3: casos aleatorios contra git merge-file', () => {
  // git merge-file no usa la heurística de sangría de git diff; para comparar con él, los
  // bloques se calculan con --no-indent-heuristic (la lógica de diff3 es la misma)
  const NOIH = ['--no-indent-heuristic'];

  test('los segmentos reconstruyen las tres versiones (diff por defecto, como la extensión)', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const { base, ours, theirs } = randomCase(seed);
      checkSegments(merge3(base, ours, theirs), base, ours, theirs);
    }
  });

  test('con conflictos marcados, igual que git merge-file --diff3', () => {
    const diffs: string[] = [];
    for (let seed = 1; seed <= 100; seed++) {
      const { base, ours, theirs } = randomCase(seed);
      const segs = merge3(base, ours, theirs, NOIH);
      const got = resolve(segs, 'markers'), want = mergeFile(base, ours, theirs, ['--diff3']);
      if (got !== want) { diffs.push(`semilla ${seed}:\n--- jbgit\n${got}--- git\n${want}`); }
    }
    assert.equal(diffs.length, 0, diffs.slice(0, 3).join('\n'));
  });

  test('aceptando Yours / Theirs en todos los conflictos, igual que git merge-file --ours / --theirs', () => {
    const diffs: string[] = [];
    for (let seed = 1; seed <= 100; seed++) {
      const { base, ours, theirs } = randomCase(seed);
      const segs = merge3(base, ours, theirs, NOIH);
      for (const side of ['ours', 'theirs'] as const) {
        const got = resolve(segs, side), want = mergeFile(base, ours, theirs, [`--${side}`]);
        if (got !== want) { diffs.push(`semilla ${seed} (${side}):\n--- jbgit\n${got}--- git\n${want}`); }
      }
    }
    assert.equal(diffs.length, 0, diffs.slice(0, 3).join('\n'));
  });
});

// ---------------------------------------------------------------------------
// MergePanel.open / apply con un webview simulado (fin de línea y CRLF)
// ---------------------------------------------------------------------------

describe('MergePanel (con un webview simulado)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vscode = require('vscode');
  function fakePanel() {
    const sent: any[] = [];
    let handler: (m: any) => unknown = () => undefined;
    let disposed = false;
    const panel = {
      webview: {
        cspSource: 'csp', html: '',
        asWebviewUri: (u: unknown) => u,
        postMessage: (m: unknown) => { sent.push(m); return Promise.resolve(true); },
        onDidReceiveMessage: (h: (m: any) => unknown) => { handler = h; },
      },
      onDidDispose: () => undefined,
      reveal: () => undefined,
      dispose: () => { disposed = true; },
    };
    return { panel, sent, send: (m: unknown) => handler(m), isDisposed: () => disposed };
  }

  async function openPanel(repo: TestRepo, rel: string, versions: { base: string; ours: string; theirs: string }) {
    const fp = fakePanel();
    vscode.window.createWebviewPanel = () => fp.panel;
    let done = 0;
    await MergePanel.open({ path: '/media' } as any, new Git(repo.root), rel, versions, { ours: 'main', theirs: 'feature' },
      () => { done++; }, async () => undefined, vscode.ViewColumn.Active);
    await fp.send({ type: 'ready' });
    const init = fp.sent.find(m => m.type === 'init');
    return { ...fp, init, done: () => done };
  }

  test('init: segmentos de diff3 y eol; Apply escribe el archivo y hace git add', async () => {
    const repo = TestRepo.init();
    try {
      repo.commit('base', { 'f.txt': 'a\nb\nc\n' });
      const p = await openPanel(repo, 'f.txt', { base: 'a\nb\nc\n', ours: 'A\nb\nc\n', theirs: 'a\nb\nC\n' });
      assert.ok(p.init);
      assert.equal(p.init.eol, true);
      assert.deepEqual(p.init.segments.map((s: MergeSegment) => s.kind), ['ours', 'common', 'theirs']);
      await p.send({ type: 'apply', text: 'A\nb\nC\n' });
      assert.equal(readFileSync(path.join(repo.root, 'f.txt'), 'utf8'), 'A\nb\nC\n');
      assert.match(repo.git('status', '--porcelain'), /^M  f\.txt/m, 'queda en el índice');
      assert.equal(p.done(), 1);
      assert.ok(p.isDisposed());
    } finally { rm(repo.root); }
  });

  test('CRLF: los cambios se calculan sin \\r y Apply vuelve a escribir con CRLF', async () => {
    const repo = TestRepo.init();
    try {
      repo.commit('base', { 'w.txt': 'a\r\nb\r\n' });
      const p = await openPanel(repo, 'w.txt', { base: 'a\r\nb\r\n', ours: 'A\r\nb\r\n', theirs: 'a\r\nb\r\nc\r\n' });
      assert.deepEqual(p.init.segments.map((s: MergeSegment) => s.kind), ['ours', 'common', 'theirs']);
      assert.ok(!JSON.stringify(p.init.segments).includes('\\r'), 'sin \\r en las líneas');
      await p.send({ type: 'apply', text: 'A\nb\nc\n' });
      assert.equal(readFileSync(path.join(repo.root, 'w.txt'), 'utf8'), 'A\r\nb\r\nc\r\n');
    } finally { rm(repo.root); }
  });

  test('sin salto de línea final en ningún lado: eol = false', async () => {
    const repo = TestRepo.init();
    try {
      repo.commit('base', { 'n.txt': 'a\nb\nc' });
      const p = await openPanel(repo, 'n.txt', { base: 'a\nb\nc', ours: 'A\nb\nc', theirs: 'a\nb\nC' });
      assert.equal(p.init.eol, false);
      assert.deepEqual(p.init.segments.map((s: MergeSegment) => s.kind), ['ours', 'common', 'theirs']);
    } finally { rm(repo.root); }
  });

  test('si theirs quita el salto de línea final y ours no toca el final, el resultado lo quita (como git merge-file)', async () => {
    const repo = TestRepo.init();
    try {
      repo.commit('base', { 'e.txt': 'a\nb\n' });
      const p = await openPanel(repo, 'e.txt', { base: 'a\nb\n', ours: 'A\nb\n', theirs: 'a\nb' });
      assert.equal(p.init.eol, false);
    } finally { rm(repo.root); }
  });

  test('un archivo con el mismo contenido en las tres versiones salvo el fin de línea final no da bloques vacíos', async () => {
    const repo = TestRepo.init();
    try {
      repo.commit('base', { 'z.txt': 'a\n' });
      const p = await openPanel(repo, 'z.txt', { base: 'a\n', ours: 'a', theirs: 'a\n' });
      assert.deepEqual(p.init.segments, [{ kind: 'common', lines: ['a'] }]);
    } finally { rm(repo.root); }
  });
});
