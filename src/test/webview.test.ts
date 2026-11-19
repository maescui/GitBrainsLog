/**
 * Tests de las funciones puras de los scripts del webview (media/*.js) y de las reglas
 * de CLAUDE.md sobre ellos. Los scripts son IIFE sin módulos: cada función se extrae del
 * código fuente por su nombre y se evalúa con `new Function`, con sustitutos para lo que
 * use de fuera (DOM, estado, etc.).
 */
import './vscode-stub';
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import * as path from 'path';
import { parseDiffBlocks } from '../git';
import { diff3, parseHunks } from '../merge';
import { validateSetting, MERGE_OPTIONS } from '../core';
import { tmpDir, rm, GIT_ENV } from './helpers';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const MAIN = read('media/main.js');
const COMPARE = read('media/compare.js');
const MERGE = read('media/merge.js');
const DIALOG = read('media/dialog.js');

// ---------------------------------------------------------------------------
// Extracción de funciones y constantes del nivel superior de la IIFE (sangría de 2)
// ---------------------------------------------------------------------------

/**
 * Código de la declaración `function name(` o `const|let name =` con sangría de 2: desde su
 * primera línea hasta la línea de cierre con la misma sangría (o hasta la siguiente
 * declaración si cabe en una línea o sigue con más sangría).
 */
function extract(src: string, name: string): string {
  const lines = src.split(/\r?\n/);
  const re = new RegExp(`^  (?:async )?(?:function ${name}\\(|(?:const|let) ${name} = )`);
  const start = lines.findIndex(l => re.test(l));
  assert.ok(start >= 0, `${name} no encontrado`);
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '' || /^ {3,}/.test(l)) { out.push(l); continue; }
    if (/^ {2}[}\])]/.test(l)) { out.push(l); }
    break;
  }
  return out.join('\n');
}

/**
 * Evalúa varias declaraciones juntas y devuelve un objeto con ellas. stubs: variables de
 * fuera que usan (DOM, estado…); pre: código previo (p. ej. `let x = …`); expose: expresiones
 * extra que se devuelven como funciones de lectura.
 */
function sandbox(src: string, names: string[], stubs: Record<string, unknown> = {}, pre = '', expose: string[] = []): any {
  const code = names.map(n => extract(src, n)).join('\n');
  const ret = `return { ${names.join(', ')}${expose.map(e => `, get_${e}: () => ${e}, set_${e}: v => { ${e} = v; }`).join('')} };`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(...Object.keys(stubs), `${pre}\n${code}\n${ret}`)(...Object.values(stubs));
}

const ESC = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

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

// Repo temporal para generar diffs reales con git
const tmp = tmpDir('jbgit-webview-test-');
process.on('exit', () => rm(tmp));
function git(args: string[], input?: string) {
  const r = spawnSync('git', args, { cwd: tmp, env: GIT_ENV, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) { throw r.error; }
  return r;
}
/** git diff entre dos textos (archivos a y b en la carpeta temporal). */
function gitDiff(a: string, b: string, extra: string[] = []): string {
  writeFileSync(path.join(tmp, 'a.txt'), a);
  writeFileSync(path.join(tmp, 'b.txt'), b);
  const r = git(['diff', '--no-index', '--no-color', ...extra, '--', 'a.txt', 'b.txt']);
  assert.ok(r.status === 0 || r.status === 1, r.stderr);
  return r.stdout;
}
/** Par de textos aleatorios con cambios dispersos (y a veces sin salto de línea final). */
function randomPair(r: () => number) {
  const n = 1 + Math.floor(r() * 40);
  const base = Array.from({ length: n }, (_, i) => (r() < 0.3 ? ['x', '}', '', 'a'][Math.floor(r() * 4)] : `line ${i}`));
  const other: string[] = [];
  for (const l of base) {
    const x = r();
    if (x < 0.1) { continue; }
    if (x < 0.2) { other.push(l + ' changed'); continue; }
    if (x < 0.27) { other.push(`new ${Math.floor(r() * 100)}`); }
    other.push(l);
  }
  const nl = (ls: string[]) => ls.join('\n') + (r() < 0.8 ? '\n' : '');
  return [nl(base), nl(other)];
}

// ---------------------------------------------------------------------------
// intraLine (main.js) e intra (compare.js): regla del 40 %
// ---------------------------------------------------------------------------

describe('intraLine (Local Changes) e intra (comparación)', () => {
  const { intraLine } = sandbox(MAIN, ['esc', 'intraLine']);
  const { intra } = sandbox(COMPARE, ['esc', 'intra']);

  test('resalta lo que hay entre el prefijo y el sufijo comunes', () => {
    assert.deepEqual(intraLine('const a = 1;', 'const b = 1;'),
      ['const <span class="ch">a</span> = 1;', 'const <span class="ch">b</span> = 1;']);
  });

  test('una inserción pura: el lado viejo no lleva marca vacía', () => {
    assert.deepEqual(intraLine('foo(a)', 'foo(a, b)'), ['foo(a)', 'foo(a<span class="ch">, b</span>)']);
  });

  test('exactamente el 40 % común sí se resalta; por debajo, no', () => {
    assert.ok(intraLine('aaaaXXXXXX', 'aaaaYYYYYY'));           // 4/10
    assert.equal(intraLine('aaaXXXXXXX', 'aaaYYYYYYY'), null);  // 3/10
  });

  test('el 40 % se mide sobre la línea más larga', () => {
    assert.equal(intraLine('ab', 'abXXXXXXXX'), null);           // 2/10
    assert.ok(intraLine('abcd', 'abcdXXXXXX'));                  // 4/10
  });

  test('líneas iguales, vacías o sin nada en común: null', () => {
    assert.equal(intraLine('same', 'same'), null);
    assert.equal(intraLine('', ''), null);
    assert.equal(intraLine('', 'abc'), null);
    assert.equal(intraLine('abc', 'xyz'), null);
  });

  test('prefijo y sufijo no se solapan (aa → aaa)', () => {
    assert.deepEqual(intraLine('aa', 'aaa'), ['aa', 'aa<span class="ch">a</span>']);
  });

  test('escapa el HTML', () => {
    assert.deepEqual(intraLine('<a href="x">', '<a href="y">'),
      ['&lt;a href=&quot;<span class="ch">x</span>&quot;&gt;', '&lt;a href=&quot;<span class="ch">y</span>&quot;&gt;']);
  });

  test('el visor de comparación aplica la misma regla y el mismo resaltado', () => {
    const r = rng(7);
    const alpha = 'ab c<';
    const rnd = () => Array.from({ length: Math.floor(r() * 12) }, () => alpha[Math.floor(r() * alpha.length)]).join('');
    for (let i = 0; i < 3000; i++) {
      const a = rnd(), b = r() < 0.5 ? rnd() : a.slice(0, Math.floor(r() * a.length)) + rnd() + a.slice(Math.floor(r() * a.length));
      if (a === b) { continue; }
      const m = intraLine(a, b) ?? [ESC(a), ESC(b)];
      assert.deepEqual(intra(a, b).map((s: string) => s.replace(/<span class="ch"><\/span>/g, '')), m, `${JSON.stringify(a)} / ${JSON.stringify(b)}`);
    }
  });
});

// ---------------------------------------------------------------------------
// diffRows (vista previa de Local Changes) frente a parseDiffBlocks (git.ts)
// ---------------------------------------------------------------------------

describe('diffRows (vista previa de Local Changes)', () => {
  const ICON = { plus: '[+]', minus: '[-]', undo: '[u]' };
  const sb = sandbox(MAIN, ['esc', 'intraLine', 'blkButtons', 'dl', 'PREVIEW_MAX_LINES', 'diffRows'], { ICON },
    "let previewBlocks = []; let blkStage = '';", ['previewBlocks', 'blkStage']);
  const rows = (text: string, canRollback = true) => { const html = sb.diffRows(text, canRollback); return { html, blocks: sb.get_previewBlocks() as string[][] }; };

  test('numera los bloques igual que parseDiffBlocks en diffs reales de git', () => {
    const r = rng(11);
    for (let i = 0; i < 150; i++) {
      const [a, b] = randomPair(r);
      for (const extra of [[], ['-U0'], ['-U1']]) {
        const d = gitDiff(a, b, extra);
        assert.deepEqual(rows(d).blocks, parseDiffBlocks(d).blocks, `caso ${i} ${extra.join(' ')}`);
      }
    }
  });

  test('también con varios archivos en el mismo diff', () => {
    const d1 = gitDiff('a\nb\nc\n', 'a\nB\nc\n'), d2 = gitDiff('x\ny\n', 'x\ny\nz');
    const d = d1 + d2;
    assert.deepEqual(rows(d).blocks, parseDiffBlocks(d).blocks);
    assert.equal(rows(d).blocks.length, 2);
  });

  test('un botón de rollback por bloque, ninguno en archivos borrados', () => {
    const d = gitDiff('1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n', '1\nX\n3\n4\n5\n6\n7\n8\nY\n10\n', ['-U1']);
    assert.equal((rows(d).html.match(/data-blk-act="rollback"/g) || []).length, 2);
    assert.equal((rows(d, false).html.match(/data-blk-act="rollback"/g) || []).length, 0);
  });

  test('con blkStage, cada bloque lleva además stage / unstage', () => {
    sb.set_blkStage('stage');
    try {
      const d = gitDiff('a\nb\n', 'a\nc\n');
      assert.equal((rows(d).html.match(/data-blk-act="stage"/g) || []).length, 1);
    } finally { sb.set_blkStage(''); }
  });

  test('sin cabeceras @@ ni el aviso «No newline at end of file»; un separador entre hunks', () => {
    const a = Array.from({ length: 30 }, (_, i) => `l${i}`);
    const b = [...a]; b[2] = 'X'; b[25] = 'Y';
    const d = gitDiff(a.join('\n') + '\n', b.join('\n'));
    assert.match(d, /No newline/);
    const { html } = rows(d);
    assert.ok(!html.includes('@@'));
    assert.ok(!html.includes('No newline'));
    assert.equal((html.match(/class="dl gap"/g) || []).length, 1);
  });

  test('números de línea antiguos y nuevos', () => {
    const d = gitDiff('a\nb\nc\n', 'a\nB\nc\nd\n');
    const { html } = rows(d);
    const lns = [...html.matchAll(/<div class="dl ([a-z]*)"[^>]*><span class="ln">([^<]*)<\/span><span class="ln">([^<]*)<\/span>/g)].map(m => [m[1], m[2], m[3]]);
    assert.deepEqual(lns, [['', '1', '1'], ['del', '2', ''], ['add', '', '2'], ['', '3', '3'], ['add', '', '4']]);
  });

  test('empareja la k-ésima «-» con la k-ésima «+» para resaltar', () => {
    const d = gitDiff('const a = 1;\nconst b = 2;\n', 'const a = 3;\nconst b = 4;\n');
    assert.equal((rows(d).html.match(/class="ch"/g) || []).length, 4);
  });

  test('mensajes sin cambios de contenido', () => {
    assert.match(rows('diff --git a/x b/x\nindex 1..2\nBinary files a/x and b/x differ\n').html, /Binary file changed/);
    assert.match(rows('diff --git a/x b/y\nsimilarity index 100%\nrename from x\nrename to y\n').html, /Renamed without content changes/);
    assert.match(rows('diff --git a/x b/x\nold mode 100644\nnew mode 100755\n').html, /Only the file mode changed/);
    assert.match(rows('').html, /No content changes/);
  });

  test('un bloque cortado por PREVIEW_MAX_LINES no se puede deshacer con líneas a medias', () => {
    const n = 6000;
    const a = Array.from({ length: n }, (_, i) => `l${i}`).join('\n') + '\n';
    const b = Array.from({ length: n }, (_, i) => `m${i}`).join('\n') + '\n';
    const d = gitDiff(a, b);
    const { html, blocks } = rows(d);
    const full = parseDiffBlocks(d).blocks;
    // O el bloque se manda entero, o no se ofrece su botón
    const shown = blocks.length - 1;
    const hasButton = html.includes(`data-blk="${shown}" data-blk-act="rollback"`);
    assert.ok(!hasButton || JSON.stringify(blocks[shown]) === JSON.stringify(full[shown]));
  });
});

// ---------------------------------------------------------------------------
// parseDiff (visor de comparación)
// ---------------------------------------------------------------------------

describe('parseDiff (visor de comparación)', () => {
  const { parseDiff } = sandbox(COMPARE, ['MAX_ROWS', 'parseDiff']);

  test('empareja borradas y añadidas en filas mod / del / add con números de línea', () => {
    const d = gitDiff('a\nb\nc\nd\n', 'a\nB\nC2\nX\nd\n', ['--unified=1000000']);
    const { out, bl, msg } = parseDiff(d);
    assert.equal(msg, '');
    assert.deepEqual(out.map((r: any) => [r.k, r.l, r.r]), [['', 1, 1], ['mod', 2, 2], ['mod', 3, 3], ['add', '', 4], ['', 4, 5]]);
    assert.deepEqual(bl, [1]);
    assert.equal(out[3].lt, null);
  });

  test('borrado puro: filas del con hueco a la derecha', () => {
    const { out } = parseDiff(gitDiff('a\nb\nc\n', 'a\nc\n', ['--unified=1000000']));
    assert.deepEqual(out[1], { k: 'del', l: 2, r: '', lt: 'b', rt: null });
  });

  test('un bloque por cada racha de cambios (los mismos que parseDiffBlocks), F7 salta entre ellos', () => {
    const r = rng(21);
    for (let i = 0; i < 150; i++) {
      const [a, b] = randomPair(r);
      const d = gitDiff(a, b, ['--unified=1000000']);
      const { out, bl } = parseDiff(d);
      assert.equal(bl.length, parseDiffBlocks(d).blocks.length, `caso ${i}`);
      // Reconstrucción de los dos lados
      const left = out.filter((x: any) => x.lt !== null && x.k !== 'gap').map((x: any) => x.lt);
      const right = out.filter((x: any) => x.rt !== null && x.k !== 'gap').map((x: any) => x.rt);
      const strip = (t: string) => t.replace(/\n$/, '').split('\n');
      if (!d) { assert.equal(a, b); continue; }   // sin cambios: git no da diff
      if (a !== '') { assert.deepEqual(left, strip(a), `izquierda ${i}`); }
      if (b !== '') { assert.deepEqual(right, strip(b), `derecha ${i}`); }
    }
  });

  test('entre hunks (con poco contexto) se pone una fila gap', () => {
    const a = Array.from({ length: 30 }, (_, i) => `l${i}`);
    const b = [...a]; b[1] = 'X'; b[28] = 'Y';
    const { out } = parseDiff(gitDiff(a.join('\n') + '\n', b.join('\n') + '\n', ['-U1']));
    assert.equal(out.filter((x: any) => x.k === 'gap').length, 1);
  });

  test('mensajes sin contenido', () => {
    assert.equal(parseDiff('diff --git a/x b/x\nBinary files a/x and b/x differ\n').msg, 'Binary file changed.');
    assert.equal(parseDiff('').msg, 'No content changes.');
  });
});

// ---------------------------------------------------------------------------
// Atajos: eventKey, keyLabel, SHORTCUT_ACTIONS
// ---------------------------------------------------------------------------

describe('atajos de teclado', () => {
  const mk = (isMac: boolean) => sandbox(MAIN, ['SHORTCUT_SCOPES', 'SHORTCUT_ACTIONS', 'RESERVED_KEYS', 'VSCODE_KEYS', 'eventKey', 'keyLabel'], { IS_MAC: isMac });
  const sb = mk(false);
  const ev = (key: string, code: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
    sb.eventKey({ key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

  test('eventKey: letras y números por code, modificadores en orden Ctrl, Alt, Shift', () => {
    assert.equal(ev('c', 'KeyC', { ctrlKey: true }), 'Ctrl+C');
    assert.equal(ev('c', 'KeyC', { metaKey: true }), 'Ctrl+C', 'Cmd cuenta como Ctrl');
    assert.equal(ev('C', 'KeyC', { ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+C');
    assert.equal(ev('ç', 'KeyC', { altKey: true }), 'Alt+C', 'con Alt en macOS key cambia, code no');
    assert.equal(ev('!', 'Digit1', { shiftKey: true }), 'Shift+1');
    assert.equal(ev('C', 'KeyC', { ctrlKey: true, altKey: true, shiftKey: true }), 'Ctrl+Alt+Shift+C');
  });

  test('eventKey: teclas con nombre', () => {
    assert.equal(ev('Delete', 'Delete'), 'Delete');
    assert.equal(ev('F2', 'F2'), 'F2');
    assert.equal(ev('F12', 'F12', { shiftKey: true }), 'Shift+F12');
    assert.equal(ev(' ', 'Space'), 'Space');
    assert.equal(ev('`', 'Backquote', { ctrlKey: true }), 'Ctrl+`');
    assert.equal(ev('ArrowUp', 'ArrowUp', { shiftKey: true }), 'Shift+ArrowUp');
    assert.equal(ev(',', 'Comma', { ctrlKey: true }), 'Ctrl+,');
  });

  test('eventKey: solo un modificador → vacío', () => {
    for (const k of ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Dead', 'Unidentified']) { assert.equal(ev(k, ''), ''); }
  });

  test('keyLabel: símbolos en macOS, texto en Windows / Linux', () => {
    assert.equal(sb.keyLabel('Ctrl+Shift+C'), 'Ctrl+Shift+C');
    assert.equal(sb.keyLabel(''), '');
    const mac = mk(true);
    assert.equal(mac.keyLabel('Ctrl+Shift+C'), '⌘⇧C');
    assert.equal(mac.keyLabel('Ctrl+Alt+Shift+F2'), '⌘⌥⇧F2');
    assert.equal(mac.keyLabel('Delete'), 'Delete');
  });

  test('lo que graba eventKey lo acepta validateSetting (setSetting shortcuts)', () => {
    const cases = [ev('c', 'KeyC', { ctrlKey: true, altKey: true, shiftKey: true }), ev('F12', 'F12'), ev('Delete', 'Delete', { shiftKey: true }),
      ev('`', 'Backquote', { ctrlKey: true }), ev(',', 'Comma', { ctrlKey: true }), ev('ñ', 'Semicolon', { ctrlKey: true }), ev('Insert', 'Insert')];
    for (const k of cases) { assert.deepEqual(validateSetting('shortcuts', { 'log.copyHash': k }), { 'log.copyHash': k }, k); }
  });

  test('la tecla «+» se puede grabar y guardar', () => {
    const k = ev('+', 'NumpadAdd', { ctrlKey: true });
    assert.deepEqual(validateSetting('shortcuts', { 'log.copyHash': k }), { 'log.copyHash': k });
  });

  test('SHORTCUT_ACTIONS: ids únicos y de una vista conocida', () => {
    const ids = sb.SHORTCUT_ACTIONS.map((a: string[]) => a[0]);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) {
      assert.ok(id.split('.')[0] in sb.SHORTCUT_SCOPES, id);
      assert.match(id, /^[a-zA-Z]+\.[a-zA-Z]+$/, 'clave que acepta validateSetting');
    }
  });

  test('SHORTCUT_ACTIONS: por defecto, sin teclas repetidas en una vista ni reservadas', () => {
    const seen = new Map<string, string>();
    for (const [id, , key] of sb.SHORTCUT_ACTIONS as string[][]) {
      if (!key) { continue; }
      const scope = id.split('.')[0];
      assert.ok(!sb.RESERVED_KEYS.has(key), `${id}: ${key} está reservada`);
      assert.ok(!sb.VSCODE_KEYS.has(key), `${id}: ${key} también la usa VS Code`);
      const k = `${scope}|${key}`;
      assert.ok(!seen.has(k), `${key} repetida en ${scope}: ${seen.get(k)} y ${id}`);
      seen.set(k, id);
      assert.deepEqual(validateSetting('shortcuts', { [id]: key }), { [id]: key });
    }
    // Los de CLAUDE.md
    const def = Object.fromEntries((sb.SHORTCUT_ACTIONS as string[][]).map(([id, , k]) => [id, k || '']));
    assert.equal(def['log.copyHash'], 'Ctrl+C');
    assert.equal(def['branches.copyName'], 'Ctrl+C');
    assert.equal(def['stash.drop'], 'Delete');
  });

  test('las teclas reservadas son las de CLAUDE.md', () => {
    for (const k of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Enter', 'Tab', 'Shift+ArrowUp', 'Shift+ArrowDown', 'Ctrl+A', 'Shift+F10']) {
      assert.ok(sb.RESERVED_KEYS.has(k), k);
    }
  });

  test('cada acción de SHORTCUT_ACTIONS aparece en algún menú (sc), y cada sc existe', () => {
    const ids = new Set((sb.SHORTCUT_ACTIONS as string[][]).map(a => a[0]));
    const used = new Set([...MAIN.matchAll(/sc: '([a-zA-Z]+\.[a-zA-Z]+)'/g)].map(m => m[1]));
    for (const u of used) { assert.ok(ids.has(u), `sc '${u}' sin entrada en SHORTCUT_ACTIONS`); }
    for (const id of ids) {
      if (used.has(id)) { continue; }
      // Las de ramas se montan como `branches.${sc}` con el nombre de la acción
      const [scope, act] = id.split('.');
      assert.ok(scope === 'branches' && new RegExp(`['"]${act}['"]`).test(MAIN), `la acción ${id} no está en ningún menú`);
    }
  });
});

// ---------------------------------------------------------------------------
// ignoreEscape (.gitignore / .git/info/exclude), con git check-ignore como oráculo
// ---------------------------------------------------------------------------

describe('ignoreEscape', () => {
  const { ignoreEscape } = sandbox(MAIN, ['ignoreEscape']);

  /** Para cada ruta, ¿la ignora git con estos patrones? */
  function ignored(patterns: string[], paths: string[]): boolean[] {
    const repo = tmpDir('jbgit-ign-');
    try {
      spawnSync('git', ['init', '-q'], { cwd: repo, env: GIT_ENV });
      writeFileSync(path.join(repo, '.gitignore'), patterns.join('\n') + '\n');
      const r = spawnSync('git', ['check-ignore', '--no-index', '--stdin', '-z', '-v', '-n'], { cwd: repo, env: GIT_ENV, input: paths.join('\0') + '\0', encoding: 'utf8' });
      const f = r.stdout.split('\0');
      const res: boolean[] = [];
      for (let i = 0; i + 3 < f.length; i += 4) { res.push(f[0 + i] !== ''); }
      assert.equal(res.length, paths.length, r.stderr);
      return res;
    } finally { rm(repo); }
  }

  const NAMES = ['a*b.txt', 'q?.txt', '[ab].txt', '!important.txt', '#hash.txt', 'dir/#x', 'dir/!y', 'x]y', 'a**b', 'sp ace.txt',
    'trail ', 'two  ', 'normal.txt', 'src/main/App.java',
    // En Windows git trata «\» de la ruta como separador: la barra invertida solo se prueba fuera
    ...(process.platform === 'win32' ? [] : ['back\\slash'])];

  test('cada archivo queda ignorado por su propio patrón anclado', () => {
    const res = ignored(NAMES.map(p => '/' + ignoreEscape(p)), NAMES);
    NAMES.forEach((p, i) => assert.ok(res[i], `${JSON.stringify(p)} → ${JSON.stringify('/' + ignoreEscape(p))}`));
  });

  test('el patrón no ignora otras rutas (comodines escapados, anclado en la raíz)', () => {
    const decoys = ['aXb.txt', 'qZ.txt', 'a.txt', 'b.txt', 'important.txt', 'trail', 'two', 'two ', 'sub/normal.txt', 'aXXb', 'xy', 'dir/x', 'dir/y'];
    const res = ignored(NAMES.map(p => '/' + ignoreEscape(p)), decoys);
    decoys.forEach((p, i) => assert.ok(!res[i], `${JSON.stringify(p)} no debería quedar ignorado`));
  });

  test('carpetas: /carpeta/ ignora lo de dentro', () => {
    const res = ignored(['/' + ignoreEscape('my [dir]') + '/'], ['my [dir]/a.txt', 'my d/a.txt', 'other/my [dir]/a.txt']);
    assert.deepEqual(res, [true, false, false]);
  });
});

// ---------------------------------------------------------------------------
// fileTreeRows (Group By de Local Changes y Stash)
// ---------------------------------------------------------------------------

describe('fileTreeRows', () => {
  const ICON = { repo: '[R]', folder: '[F]', chevron: '>' };
  const repos = ['backend', 'frontend'];
  const sb = sandbox(MAIN, ['esc', 'twisty', 'fileTreeRows'], { ICON, ui: { expanded: new Set<string>() }, repoName: (i: number) => repos[i] ?? '' });
  const fileRow = (f: { path: string }, depth: number, showDir: boolean) => `<FILE ${f.path} ${depth} ${showDir}>`;
  /** Filas como texto: carpetas «D label (n files) pad» y archivos «F ruta depth showDir». */
  function render(files: { path: string; repo: number }[], groupBy: { directory: boolean; repository: boolean }, multi = false) {
    const folders = new Map<string, unknown[]>();
    const html: string = sb.fileTreeRows(files, 0, 'p:', groupBy, fileRow, folders, multi);
    const rows = [...html.matchAll(/data-fold="([^"]*)" data-pad="(\d+)">.*?<span class="label">([^<]*)<\/span><span class="hint">([^<]*)<\/span>|<FILE ([^ ]+) (\d+) (\w+)>/g)]
      .map(m => (m[1] !== undefined ? `D ${m[3]} (${m[4]}) ${m[2]}` : `F ${m[5]} ${m[6]} ${m[7]}`));
    return { rows, folders };
  }
  const F = (p: string, repo = 0) => ({ path: p, repo });

  test('Directory: junta cadenas de carpetas con una sola subcarpeta (src/main/java)', () => {
    const { rows, folders } = render([F('src/main/java/B.java'), F('src/main/java/A.java'), F('README.md')], { directory: true, repository: false });
    assert.deepEqual(rows, ['D src/main/java (2 files) 6', 'F src/main/java/A.java 1 false', 'F src/main/java/B.java 1 false', 'F README.md 0 false']);
    assert.equal(folders.get('p:dir:src/main/java')!.length, 2);
  });

  test('Directory: una carpeta con archivos propios no se junta con su subcarpeta', () => {
    const { rows } = render([F('src/a.ts'), F('src/lib/b.ts'), F('src/lib/c.ts')], { directory: true, repository: false });
    assert.deepEqual(rows, ['D src (3 files) 6', 'D lib (2 files) 20', 'F src/lib/b.ts 2 false', 'F src/lib/c.ts 2 false', 'F src/a.ts 1 false']);
  });

  test('sin Directory: lista plana ordenada, con la carpeta (showDir)', () => {
    const { rows } = render([F('z/b.txt'), F('a.txt'), F('m/n/c.txt')], { directory: false, repository: false });
    assert.deepEqual(rows, ['F a.txt 0 true', 'F m/n/c.txt 0 true', 'F z/b.txt 0 true']);
  });

  test('Repository: un nodo por repo con sus archivos (claves separadas por repo)', () => {
    const { rows, folders } = render([F('src/x.ts', 1), F('src/y.ts', 0)], { directory: true, repository: true }, true);
    assert.deepEqual(rows, ['D backend (1 file) 6', 'D src (1 file) 20', 'F src/y.ts 2 false', 'D frontend (1 file) 6', 'D src (1 file) 20', 'F src/x.ts 2 false']);
    assert.ok(folders.has('p:r0:dir:src') && folders.has('p:r1:dir:src'));
  });

  test('las carpetas plegadas no muestran su contenido', () => {
    const closed = sandbox(MAIN, ['esc', 'twisty', 'fileTreeRows'], { ICON, ui: { expanded: new Set(['closed:p:dir:src']) }, repoName: () => '' });
    const html: string = closed.fileTreeRows([F('src/a.ts')], 0, 'p:', { directory: true, repository: false }, fileRow, new Map(), false);
    assert.ok(!html.includes('<FILE'));
  });

  // Decidido: con Repository activo sale el nodo del repo aunque solo haya uno (como JetBrains)
  test('Repository con un solo repo también añade el nodo del repo', () => {
    const { rows } = render([F('a.txt')], { directory: true, repository: true }, false);
    assert.equal(rows.length, 2);
    assert.match(rows[0], /^D .*\(1 file\)/);
    assert.match(rows[1], /^F a\.txt /);
  });
});

// ---------------------------------------------------------------------------
// Constantes: MERGE_OPTS, LOGVIEW_DEFAULTS, GROUPBY_DEFAULTS
// ---------------------------------------------------------------------------

describe('constantes del webview', () => {
  const sb = sandbox(MAIN, ['MERGE_OPTS', 'LOGVIEW_DEFAULTS', 'GROUPBY_DEFAULTS']);

  test('MERGE_OPTS: incompatibilidades simétricas y entre opciones que existen', () => {
    const opts: [string, string, string[]][] = sb.MERGE_OPTS;
    const names = new Set(opts.map(o => o[0]));
    for (const [o, , inc] of opts) {
      for (const x of inc) {
        assert.ok(names.has(x), `${o}: incompatible con ${x}, que no existe`);
        assert.ok(opts.find(p => p[0] === x)![2].includes(o), `${o} ↔ ${x} no es simétrica`);
      }
      assert.ok(!inc.includes(o), `${o} incompatible consigo misma`);
    }
  });

  test('MERGE_OPTS: las mismas opciones que acepta mergeArgs (core.ts), más -m', () => {
    const names = sb.MERGE_OPTS.map((o: string[]) => o[0]).filter((o: string) => o !== '-m').sort();
    assert.deepEqual(names, [...MERGE_OPTIONS].sort());
  });

  test('LOGVIEW_DEFAULTS: booleanos; todas las columnas y paneles visibles, Compact desactivado', () => {
    const d = sb.LOGVIEW_DEFAULTS;
    for (const v of Object.values(d)) { assert.equal(typeof v, 'boolean'); }
    for (const k of ['details', 'subject', 'author', 'date', 'hash', 'tags']) { assert.equal(d[k], true, k); }
    assert.equal(d.compact, false);
    // First Parent y Long Edges no van aquí (van a la extensión con logOption)
    assert.ok(!('firstParent' in d) && !('longEdges' in d));
  });

  test('GROUPBY_DEFAULTS: por defecto, Directory y Repository (CLAUDE.md)', () => {
    assert.deepEqual(sb.GROUPBY_DEFAULTS, { directory: true, repository: true });
  });

  test('PALETTE (main.js) tiene PALETTE_SIZE (graph.ts) colores #rrggbb', () => {
    const { PALETTE } = sandbox(MAIN, ['PALETTE']);
    const size = Number(/const PALETTE_SIZE = (\d+);/.exec(read('src/graph.ts'))![1]);
    assert.equal(PALETTE.length, size);
    for (const c of PALETTE) { assert.match(c, /^#[0-9A-Fa-f]{6}$/); }
  });
});

// ---------------------------------------------------------------------------
// merge.js: estado de los bloques del visor de conflictos
// ---------------------------------------------------------------------------

describe('merge.js (visor de conflictos)', () => {
  const el = () => ({ textContent: '', classList: { toggle() { /* nada */ } }, disabled: false });
  const make = () => sandbox(MERGE, ['init', 'isConflict', 'resolved', 'conflictIndexes', 'apply', 'ignore', 'acceptAll', 'resultText'],
    { $: el, render: () => undefined, reveal: () => undefined },
    "let segs = []; let eol = true; let labels = { ours: '', theirs: '' };", ['segs', 'eol']);
  const SEGS = [
    { kind: 'common', lines: ['c1'] },
    { kind: 'ours', base: ['b'], ours: ['O'], theirs: ['b'] },
    { kind: 'theirs', base: ['b2'], ours: ['b2'], theirs: ['T'] },
    { kind: 'same', base: ['b3'], ours: ['S'], theirs: ['S'] },
    { kind: 'conflict', base: ['base'], ours: ['mine'], theirs: ['yours'] },
    { kind: 'common', lines: ['c2'] },
  ];
  const start = (segments = SEGS, eol = true) => { const m = make(); m.init({ path: 'f', ours: 'main', theirs: 'feat', segments, eol }); return m; };

  test('init: los cambios sin conflicto se aplican solos y el conflicto empieza con la base', () => {
    const m = start();
    assert.equal(m.resultText(), 'c1\nO\nT\nS\nbase\nc2\n');
    assert.deepEqual(m.conflictIndexes(), [4]);
  });

  test('» aplica Yours; « después lo añade debajo (orden de los clics)', () => {
    const m = start();
    m.apply(4, 'left');
    assert.equal(m.resultText(), 'c1\nO\nT\nS\nmine\nc2\n');
    assert.deepEqual(m.conflictIndexes(), [4], 'sigue pendiente el otro lado');
    m.apply(4, 'right');
    assert.equal(m.resultText(), 'c1\nO\nT\nS\nmine\nyours\nc2\n');
    assert.deepEqual(m.conflictIndexes(), []);
    const m2 = start();
    m2.apply(4, 'right');
    m2.apply(4, 'left');
    assert.equal(m2.resultText(), 'c1\nO\nT\nS\nyours\nmine\nc2\n');
  });

  test('× en un lado y » en el otro: solo ese lado', () => {
    const m = start();
    m.ignore(4, 'left');
    m.apply(4, 'right');
    assert.equal(m.resultText(), 'c1\nO\nT\nS\nyours\nc2\n');
    assert.deepEqual(m.conflictIndexes(), []);
  });

  test('× en los dos lados: queda la base y cuenta como resuelto', () => {
    const m = start();
    m.ignore(4, 'left');
    m.ignore(4, 'right');
    assert.equal(m.resultText(), 'c1\nO\nT\nS\nbase\nc2\n');
    assert.deepEqual(m.conflictIndexes(), []);
  });

  test('× en un cambio sin conflicto lo deshace', () => {
    const m = start();
    m.ignore(1, 'left');
    m.ignore(2, 'right');
    assert.equal(m.resultText(), 'c1\nb\nb2\nS\nbase\nc2\n');
  });

  test('Accept Yours / Accept Theirs: solo los conflictos pendientes', () => {
    const segs = [...SEGS, { kind: 'conflict', base: ['B2'], ours: ['m2'], theirs: ['y2'] }];
    const m = start(segs);
    m.apply(6, 'right');
    m.ignore(6, 'left');   // el segundo ya está resuelto con Theirs
    m.acceptAll('left');
    assert.equal(m.resultText(), 'c1\nO\nT\nS\nmine\nc2\ny2\n');
    assert.deepEqual(m.conflictIndexes(), []);
  });

  test('resultText: sin salto final con eol = false; archivo vacío → cadena vacía', () => {
    assert.equal(start(SEGS, false).resultText(), 'c1\nO\nT\nS\nbase\nc2');
    assert.equal(start([{ kind: 'ours', base: ['x'], ours: [], theirs: ['x'] }]).resultText(), '');
  });

  test('con diff3 de git real: Accept Yours / Theirs da lo mismo que git merge-file --ours / --theirs', () => {
    const r = rng(5);
    const write = (name: string, ls: string[]) => { const p = path.join(tmp, name); writeFileSync(p, ls.length ? ls.join('\n') + '\n' : ''); return p; };
    for (let i = 0; i < 40; i++) {
      const base = Array.from({ length: Math.floor(r() * 15) }, (_, k) => (r() < 0.3 ? 'x' : `l${k}`));
      const mut = (tag: string) => base.flatMap(l => { const x = r(); return x < 0.15 ? [] : x < 0.3 ? [`${tag}${Math.floor(r() * 3)}`] : x < 0.38 ? [l, `${tag}+`] : [l]; });
      const ours = mut('o'), theirs = mut('t');
      const pb = write('mb', base), po = write('mo', ours), pt = write('mt', theirs);
      const d = (a: string, b: string) => git(['diff', '--no-index', '--no-color', '-U0', '--no-indent-heuristic', '--', a, b]).stdout;
      const segs = diff3(base, ours, theirs, parseHunks(d(pb, po), 'o'), parseHunks(d(pb, pt), 't'));
      for (const side of ['left', 'right']) {
        const m = make();
        m.init({ path: 'f', ours: '', theirs: '', segments: JSON.parse(JSON.stringify(segs)), eol: true });
        m.acceptAll(side);
        const want = git(['merge-file', '-p', side === 'left' ? '--ours' : '--theirs', po, pb, pt]).stdout;
        assert.equal(m.resultText(), want, `caso ${i} ${side}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Reglas de CLAUDE.md sobre el código del webview
// ---------------------------------------------------------------------------

/** Quita los comentarios (// y /* *\/) de forma aproximada, sin tocar las cadenas. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');
}
const SCRIPTS: [string, string][] = [['main.js', MAIN], ['compare.js', COMPARE], ['merge.js', MERGE], ['dialog.js', DIALOG]];

describe('reglas de CSP en media/*.js', () => {
  for (const [name, src] of SCRIPTS) {
    const code = stripComments(src);
    test(`${name}: sin atributos style="…" en el HTML generado ni setAttribute('style')`, () => {
      const hits = code.split('\n').map((l, i) => [i + 1, l] as const).filter(([, l]) => /\sstyle\s*=\s*\\?["'$]|setAttribute\(\s*['"]style['"]/.test(l));
      assert.deepEqual(hits, []);
    });
    test(`${name}: sin manejadores inline (onclick=…) ni <script> en el HTML`, () => {
      const hits = code.split('\n').map((l, i) => [i + 1, l] as const).filter(([, l]) => /<[a-z][^>]*\son[a-z]+\s*=|<script/i.test(l));
      assert.deepEqual(hits, []);
    });
  }
  test('los HTML de los webview cargan los scripts con nonce y sin script inline', () => {
    for (const f of ['src/extension.ts', 'src/compare.ts', 'src/merge.ts', 'src/dialog.ts']) {
      const s = read(f);
      for (const m of s.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
        assert.match(m[1], /nonce="\$\{nonce\}"/, `${f}: script sin nonce`);
        assert.match(m[1], /src="/, `${f}: script inline`);
        assert.equal(m[2].trim(), '', `${f}: script con contenido inline`);
      }
      assert.ok(!/'unsafe-inline'/.test(s), `${f}: la CSP no debe permitir unsafe-inline`);
    }
  });
});

describe('tipos de mensaje (docs/messages.md ↔ código)', () => {
  const doc = read('docs/messages.md');
  const section = /## Hacia la extensión[^\n]*\n([\s\S]*?)## Hacia el webview[^\n]*\n([\s\S]*)$/.exec(doc);
  const ticks = (s: string) => new Set([...s.matchAll(/`([a-zA-Z]+)`/g)].map(m => m[1]));
  const docToExt = ticks(section?.[1] ?? '');
  const docToWeb = ticks(section?.[2] ?? '');
  const ext = read('src/extension.ts');
  const onMsg = /private async onMessage\(m: any\) \{\n    switch \(m\.type\) \{([\s\S]*?)\n    \}\n  \}/.exec(ext)![1];
  const extHandles = new Set([...onMsg.matchAll(/case '([a-zA-Z]+)':/g)].map(m => m[1]));
  const listener = /window\.addEventListener\('message', ev => \{([\s\S]*?)\n  \}\);/.exec(MAIN)![1];
  const webHandles = new Set([...listener.matchAll(/case '([a-zA-Z]+)':/g)].map(m => m[1]));
  // Lo que manda el webview: postMessage({ type: … }), msg: { type: … }, post('…') y el ternario de los bloques
  const webSends = new Set([
    ...[...MAIN.matchAll(/(?:postMessage\(\{\s*|msg: \{ )type: '([a-zA-Z]+)'/g)].map(m => m[1]),
    ...[...MAIN.matchAll(/[^a-zA-Z.]post\('([a-zA-Z]+)'/g)].map(m => m[1]),
    ...[...MAIN.matchAll(/type: act === '[a-z]+' \? '([a-zA-Z]+)' : '([a-zA-Z]+)'/g)].flatMap(m => [m[1], m[2]]),
  ]);
  // Lo que manda la extensión a la vista: this.post({ type: … }) y dialogInPanel('…')
  const extSends = new Set([
    ...[...ext.matchAll(/this\.post\(\{\s*type: '([a-zA-Z]+)'/g)].map(m => m[1]),
    ...[...ext.matchAll(/dialogInPanel\('([a-zA-Z]+)'/g)].map(m => m[1]),
  ]);
  const minus = (a: Set<string>, b: Set<string>) => [...a].filter(x => !b.has(x)).sort();

  test('docs/messages.md tiene la lista de tipos', () => {
    assert.ok(section, 'no se encontró la lista en docs/messages.md');
    assert.ok(docToExt.size > 20 && docToWeb.size > 5);
  });

  test('todo lo que manda el webview lo atiende la extensión', () => {
    assert.deepEqual(minus(webSends, extHandles), []);
  });

  test('todo lo que manda la extensión lo atiende el webview', () => {
    assert.deepEqual(minus(extSends, webHandles), []);
  });

  test('ningún manejador de la extensión sobra (nadie lo manda)', () => {
    assert.deepEqual(minus(extHandles, webSends), []);
  });

  test('ningún manejador del webview sobra (la extensión no lo manda)', () => {
    assert.deepEqual(minus(webHandles, extSends), []);
  });

  test('los tipos hacia la extensión de docs/messages.md coinciden con los manejados', () => {
    assert.deepEqual({ faltanEnDoc: minus(extHandles, docToExt), sobranEnDoc: minus(docToExt, extHandles) }, { faltanEnDoc: [], sobranEnDoc: [] });
  });

  test('los tipos hacia el webview de docs/messages.md coinciden con los manejados', () => {
    assert.deepEqual({ faltanEnDoc: minus(webHandles, docToWeb), sobranEnDoc: minus(docToWeb, webHandles) }, { faltanEnDoc: [], sobranEnDoc: [] });
  });

  test('compare.js ↔ compare.ts y dialog.js ↔ dialog.ts / push', () => {
    const cmpTs = read('src/compare.ts');
    const cmpHandles = new Set([...cmpTs.matchAll(/case '([a-zA-Z]+)':/g)].map(m => m[1]));
    const cmpSends = new Set([...COMPARE.matchAll(/postMessage\(\{ type: '([a-zA-Z]+)'/g)].map(m => m[1]));
    assert.deepEqual(minus(cmpSends, cmpHandles), []);
    const cmpWeb = new Set([...COMPARE.matchAll(/m\.type === '([a-zA-Z]+)'/g)].map(m => m[1]));
    const cmpTsSends = new Set([...cmpTs.matchAll(/type: '([a-zA-Z]+)'/g)].map(m => m[1]));
    assert.deepEqual(minus(cmpTsSends, cmpWeb), []);
    // dialog: lo que manda la página lo atiende dialog.ts (ready/result) o el onMessage del Push
    const dlgSends = new Set([...DIALOG.matchAll(/postMessage\(\{ type: '([a-zA-Z]+)'/g)].map(m => m[1]));
    const dlgTs = read('src/dialog.ts');
    const handled = new Set([...dlgTs.matchAll(/'([a-zA-Z]+)'/g)].map(m => m[1]).concat([...ext.matchAll(/m\?\.type === '([a-zA-Z]+)'/g)].map(m => m[1])));
    assert.deepEqual(minus(dlgSends, handled), []);
  });
});
