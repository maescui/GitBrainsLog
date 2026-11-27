import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import * as path from 'path';
import {
  scanDepth, commitsPerPage, MAX_SCAN_DEPTH, MAX_COMMITS_PAGE, mergeArgs, MERGE_OPTIONS, autoBranchColor,
  validateSetting, validFontFamily, validFontSize, mergeLogs, FOLDER_COLOR_TOKENS, samePath, pathInside, safeRepoPath,
  nestedRepos, pickPinnedRef, pinnedBranchNames, pinnedBranchList, DEFAULT_PINNED_BRANCHES, datePattern, DEFAULT_DATE_PATTERN,
} from '../core';
import { MAIN_COLOR } from '../graph';

const cfg = (values: Record<string, unknown>) => ({ get: <T>(k: string, d: T): T => (k in values ? values[k] as T : d) });
const ROOT = path.join(__dirname, '..', '..');

describe('scanDepth (jbGit.repositoryScanMaxDepth)', () => {
  test('por defecto 2', () => assert.equal(scanDepth(cfg({})), 2));
  test('dentro del rango se respeta', () => { for (let n = 0; n <= MAX_SCAN_DEPTH; n++) { assert.equal(scanDepth(cfg({ repositoryScanMaxDepth: n })), n); } });
  test('por encima del máximo se recorta a 5', () => {
    assert.equal(MAX_SCAN_DEPTH, 5);
    assert.equal(scanDepth(cfg({ repositoryScanMaxDepth: 20 })), 5);
  });
  test('negativos se quedan en 0', () => assert.equal(scanDepth(cfg({ repositoryScanMaxDepth: -3 })), 0));
  test('decimales se redondean', () => assert.equal(scanDepth(cfg({ repositoryScanMaxDepth: 2.6 })), 3));
  test('basura de settings.json vuelve al valor por defecto', () => {
    assert.equal(scanDepth(cfg({ repositoryScanMaxDepth: 'abc' })), 2);
    assert.equal(scanDepth(cfg({ repositoryScanMaxDepth: NaN })), 2);
  });
  test('package.json declara el mismo máximo y mínimo', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const p = pkg.contributes.configuration.properties['jbGit.repositoryScanMaxDepth'];
    assert.equal(p.maximum, MAX_SCAN_DEPTH);
    assert.equal(p.minimum, 0);
  });
});

describe('datePattern (jbGit.dateFormatPattern)', () => {
  test('por defecto, el de package.json', () => assert.equal(datePattern(cfg({})), DEFAULT_DATE_PATTERN));
  test('el patrón sin espacios alrededor', () => assert.equal(datePattern(cfg({ dateFormatPattern: ' yyyy-MM-dd ' })), 'yyyy-MM-dd'));
  test('un valor escrito a mano que no vale: el de por defecto', () => {
    for (const v of [5, {}, '', '   ', 'a\nb']) { assert.equal(datePattern(cfg({ dateFormatPattern: v })), DEFAULT_DATE_PATTERN, String(v)); }
  });
});

describe('commitsPerPage (jbGit.maxCommits)', () => {
  test('por defecto 1000', () => assert.equal(commitsPerPage(cfg({})), 1000));
  test('se recorta entre 100 y 10000', () => {
    assert.equal(commitsPerPage(cfg({ maxCommits: 5 })), 100);
    assert.equal(commitsPerPage(cfg({ maxCommits: 50000 })), MAX_COMMITS_PAGE);
    assert.equal(commitsPerPage(cfg({ maxCommits: 2500 })), 2500);
  });
  test('basura vuelve a 1000', () => assert.equal(commitsPerPage(cfg({ maxCommits: 'x' })), 1000));
});

describe('mergeArgs (ventana Merge)', () => {
  test('sin opciones ni mensaje', () => assert.deepEqual(mergeArgs([], ''), []));
  test('solo pasan las opciones conocidas', () => {
    assert.deepEqual(mergeArgs(['--no-ff', '--exec=rm -rf /', '-s', 'ours', 42, null], ''), ['--no-ff']);
  });
  test('todas las opciones conocidas pasan', () => assert.deepEqual(mergeArgs([...MERGE_OPTIONS], ''), MERGE_OPTIONS));
  test('opciones que no son array se ignoran', () => assert.deepEqual(mergeArgs('--no-ff', ''), []));
  test('el mensaje va con -m y recortado', () => assert.deepEqual(mergeArgs(['--no-ff'], '  Merge x  '), ['--no-ff', '-m', 'Merge x']));
  test('mensaje vacío o en blanco no añade -m', () => assert.deepEqual(mergeArgs([], '   \n '), []));
  test('con --squash o --ff-only no se pasa -m (no hay commit de merge)', () => {
    assert.deepEqual(mergeArgs(['--squash'], 'msg'), ['--squash']);
    assert.deepEqual(mergeArgs(['--ff-only'], 'msg'), ['--ff-only']);
  });
  test('un mensaje que empieza por guion sigue siendo el argumento de -m', () => {
    assert.deepEqual(mergeArgs([], '--no-verify'), ['-m', '--no-verify']);
  });
  test('-m como opción suelta no se cuela', () => assert.deepEqual(mergeArgs(['-m'], ''), []));
});

describe('autoBranchColor', () => {
  test('main y master usan MAIN_COLOR (amarillo, 3)', () => {
    assert.equal(MAIN_COLOR, 3);
    assert.equal(autoBranchColor('main'), 3);
    assert.equal(autoBranchColor('master'), 3);
  });
  test('ninguna otra rama usa MAIN_COLOR y todas caen en la paleta', () => {
    for (let i = 0; i < 2000; i++) {
      const c = autoBranchColor(`feature/x-${i}`);
      assert.ok(Number.isInteger(c) && c >= 0 && c <= 9, `color ${c}`);
      assert.notEqual(c, MAIN_COLOR);
    }
  });
  test('es estable para el mismo nombre', () => assert.equal(autoBranchColor('feature/login'), autoBranchColor('feature/login')));
  test('coincide con autoBranchColor de media/main.js', () => {
    // La copia del webview: se extrae su cuerpo y se compara con el de la extensión
    const js = readFileSync(path.join(ROOT, 'media', 'main.js'), 'utf8');
    const m = js.match(/function autoBranchColor\(name\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, 'autoBranchColor no encontrado en main.js');
    const PALETTE = js.match(/const PALETTE = (\[[^\]]*\]);/);
    assert.ok(PALETTE);
    const palette: string[] = JSON.parse(PALETTE[1].replace(/'/g, '"'));
    const webFn = new Function('PALETTE', 'name', m[1]) as (p: string[], n: string) => string;
    for (const name of ['main', 'master', 'develop', 'feature/a', 'bugfix/b', 'release/1.0', 'x', '']) {
      assert.equal(webFn(palette, name), palette[autoBranchColor(name)], name);
    }
  });
});

describe('validateSetting (setSetting)', () => {
  test('claves desconocidas o heredadas de Object se rechazan', () => {
    assert.equal(validateSetting('foo', 1), undefined);
    assert.equal(validateSetting('constructor', {}), undefined);
    assert.equal(validateSetting('__proto__', {}), undefined);
  });
  test('dateFormat', () => {
    assert.equal(validateSetting('dateFormat', 'relative'), 'relative');
    assert.equal(validateSetting('dateFormat', 'absolute'), 'absolute');
    assert.equal(validateSetting('dateFormat', 'custom'), 'custom');
    assert.equal(validateSetting('dateFormat', 'iso'), undefined);
  });
  test('dateFormatPattern: texto de una línea, no vacío y de hasta 100 caracteres', () => {
    assert.equal(validateSetting('dateFormatPattern', ' yyyy-MM-dd HH:mm '), 'yyyy-MM-dd HH:mm');
    assert.equal(validateSetting('dateFormatPattern', "EEE d MMM 'a las' HH:mm"), "EEE d MMM 'a las' HH:mm");
    assert.equal(validateSetting('dateFormatPattern', ''), undefined);
    assert.equal(validateSetting('dateFormatPattern', '   '), undefined);
    assert.equal(validateSetting('dateFormatPattern', 'dd\nMM'), undefined);
    assert.equal(validateSetting('dateFormatPattern', 'd'.repeat(101)), undefined);
    assert.equal(validateSetting('dateFormatPattern', 3), undefined);
  });
  test('maxCommits: entero entre 100 y 10000', () => {
    assert.equal(validateSetting('maxCommits', 100), 100);
    assert.equal(validateSetting('maxCommits', 10000), 10000);
    assert.equal(validateSetting('maxCommits', 99), undefined);
    assert.equal(validateSetting('maxCommits', 10001), undefined);
    assert.equal(validateSetting('maxCommits', 500.5), undefined);
    assert.equal(validateSetting('maxCommits', '500'), undefined);
  });
  test('repositoryScanMaxDepth: entero entre 0 y 5', () => {
    assert.equal(validateSetting('repositoryScanMaxDepth', 0), 0);
    assert.equal(validateSetting('repositoryScanMaxDepth', 5), 5);
    assert.equal(validateSetting('repositoryScanMaxDepth', 6), undefined);
    assert.equal(validateSetting('repositoryScanMaxDepth', -1), undefined);
  });
  test('autoStage: solo booleanos', () => {
    assert.equal(validateSetting('autoStage', false), false);
    assert.equal(validateSetting('autoStage', 'false'), undefined);
  });
  test('protectedBranches: recorta, quita vacíos y repetidos', () => {
    assert.deepEqual(validateSetting('protectedBranches', [' main', 'master ', '', 'main']), ['main', 'master']);
    assert.equal(validateSetting('protectedBranches', ['main', 3]), undefined);
    assert.equal(validateSetting('protectedBranches', 'main'), undefined);
  });
  test('folderColors: nombres en minúsculas, colores del tema o #rrggbb', () => {
    assert.deepEqual(validateSetting('folderColors', { ' Feature ': 'blue', bugfix: '#AABBCC', bad: 'rgb(1,2,3)', x: 3, '': 'red' }),
      { feature: 'blue', bugfix: '#AABBCC' });
    assert.equal(validateSetting('folderColors', ['red']), undefined);
    assert.equal(validateSetting('folderColors', null), undefined);
    for (const t of FOLDER_COLOR_TOKENS) { assert.deepEqual(validateSetting('folderColors', { a: t }), { a: t }); }
  });
  test('tagColor', () => {
    assert.equal(validateSetting('tagColor', 'yellow'), 'yellow');
    assert.equal(validateSetting('tagColor', '#123abc'), '#123abc');
    assert.equal(validateSetting('tagColor', '#123'), undefined);
    assert.equal(validateSetting('tagColor', 'url(x)'), undefined);
  });
  test('branchColors: solo #rrggbb, en minúsculas', () => {
    assert.deepEqual(validateSetting('branchColors', { main: '#D4A72C', ' dev ': '#00ff00', bad: 'red' }), { main: '#d4a72c', dev: '#00ff00' });
  });
  test('shortcuts: «vista.acción» → combinación o vacío', () => {
    assert.deepEqual(validateSetting('shortcuts', {
      'log.copyHash': 'Ctrl+C', 'branches.rename': 'F2', 'changes.delete': 'Delete', 'stash.drop': '',
      'changes.copyPath': 'Ctrl+Shift+C', 'bad key': 'Ctrl+C', 'log.x': 'Ctrl+Shift+Alt+Meta+C', 'log.y': 'Ctrl + C',
      'log.plus': 'Ctrl++', 'log.bad': 'Ctrl+++',
    }), { 'log.copyHash': 'Ctrl+C', 'branches.rename': 'F2', 'changes.delete': 'Delete', 'stash.drop': '', 'changes.copyPath': 'Ctrl+Shift+C', 'log.plus': 'Ctrl++' });
  });
  test('shortcuts: como mucho 300 entradas', () => {
    const many = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`log.a${String.fromCharCode(97 + (i % 26))}${'b'.repeat(Math.floor(i / 26))}`, 'F2']));
    assert.equal(Object.keys(validateSetting('shortcuts', many) as object).length, 300);
  });
  test('fontFamily: sin caracteres que cierren la declaración CSS', () => {
    assert.equal(validateSetting('fontFamily', '  Inter, sans-serif '), 'Inter, sans-serif');
    assert.equal(validateSetting('fontFamily', ''), '');
    assert.equal(validateSetting('fontFamily', 'x; color: red'), undefined);
    assert.equal(validateSetting('fontFamily', 'a}b'), undefined);
    assert.equal(validateSetting('fontFamily', '<script>'), undefined);
    assert.equal(validateSetting('fontFamily', 'x'.repeat(201)), undefined);
    assert.equal(validFontFamily(3), false);
  });
  test('fontSize: 0 (el de VS Code) o 8–32', () => {
    assert.equal(validateSetting('fontSize', 0), 0);
    assert.equal(validateSetting('fontSize', 8), 8);
    assert.equal(validateSetting('fontSize', 32), 32);
    assert.equal(validateSetting('fontSize', 7), undefined);
    assert.equal(validateSetting('fontSize', 33), undefined);
    assert.equal(validFontSize(13.5), false);
  });
});

describe('mergeLogs (log de varios repos)', () => {
  const R0 = { idx: 0 }, R1 = { idx: 1 };
  const cs = (...times: number[]) => times.map(time => ({ time, id: time }));
  test('un solo repo: tal cual, hasMore si llegó al límite', () => {
    const r = mergeLogs([{ repo: R0, commits: cs(5, 3, 4), limited: true }], 10);
    assert.deepEqual(r.commits.map(x => x.c.time), [5, 3, 4]);
    assert.equal(r.hasMore, true);
  });
  test('varios repos: ordenados por fecha, del más nuevo al más antiguo', () => {
    const r = mergeLogs([{ repo: R0, commits: cs(9, 5, 1), limited: false }, { repo: R1, commits: cs(8, 6, 2), limited: false }], 100);
    assert.deepEqual(r.commits.map(x => x.c.time), [9, 8, 6, 5, 2, 1]);
    assert.equal(r.hasMore, false);
  });
  test('a igual fecha se respeta el orden de git dentro del repo, y luego el índice del repo', () => {
    const r = mergeLogs([
      { repo: R1, commits: [{ time: 5, id: 'b1' }, { time: 5, id: 'b2' }], limited: false },
      { repo: R0, commits: [{ time: 5, id: 'a1' }, { time: 5, id: 'a2' }], limited: false },
    ], 100);
    assert.deepEqual(r.commits.map(x => x.c.id), ['a1', 'a2', 'b1', 'b2']);
  });
  test('un repo que llegó al límite corta los commits más antiguos que su último', () => {
    const r = mergeLogs([{ repo: R0, commits: cs(10, 8), limited: true }, { repo: R1, commits: cs(9, 7, 3), limited: false }], 100);
    assert.deepEqual(r.commits.map(x => x.c.time), [10, 9, 8]);
    assert.equal(r.hasMore, true);
  });
  test('max recorta y marca hasMore', () => {
    const r = mergeLogs([{ repo: R0, commits: cs(4, 2), limited: false }, { repo: R1, commits: cs(3, 1), limited: false }], 3);
    assert.equal(r.commits.length, 3);
    assert.equal(r.hasMore, true);
  });
  test('un repo limitado sin commits no corta nada', () => {
    const r = mergeLogs([{ repo: R0, commits: [], limited: true }, { repo: R1, commits: cs(3, 1), limited: false }], 10);
    assert.deepEqual(r.commits.map(x => x.c.time), [3, 1]);
  });
  test('sin repos', () => assert.deepEqual(mergeLogs([], 10), { commits: [], hasMore: false }));
  test('ordena por fecha del commit (ctime), no por la de autor', () => {
    // b se rebasó: su fecha de autor (time) es antigua, pero la del commit es la más nueva
    const r = mergeLogs([
      { repo: R0, commits: [{ id: 'b', time: 1, ctime: 50 }, { id: 'a', time: 40, ctime: 40 }], limited: false },
      { repo: R1, commits: [{ id: 'x', time: 45, ctime: 45 }], limited: false },
    ], 10);
    assert.deepEqual(r.commits.map(x => x.c.id), ['b', 'x', 'a']);
  });
  test('nunca cambia el orden de git dentro de un repo, aunque las fechas estén desordenadas', () => {
    const r = mergeLogs([
      { repo: R0, commits: [{ id: 'c2', time: 100 }, { id: 'c1', time: 200 }, { id: 'c0', time: 50 }], limited: false },
      { repo: R1, commits: [{ id: 'x0', time: 150 }], limited: false },
    ], 10);
    const ids = r.commits.map(x => x.c.id);
    assert.ok(ids.indexOf('c2') < ids.indexOf('c1') && ids.indexOf('c1') < ids.indexOf('c0'), ids.join(','));
  });
});

describe('rutas (samePath, pathInside, safeRepoPath)', () => {
  const root = path.resolve('/repos/proyecto');
  test('samePath: separadores y, en Windows/macOS, mayúsculas', () => {
    assert.ok(samePath(root, root + path.sep));
    assert.ok(samePath(root.split(path.sep).join('/'), root));
    if (process.platform === 'win32') { assert.ok(samePath('C:/Users/x', 'c:\\users\\X')); }
  });
  test('pathInside: dentro, la propia raíz, fuera y un prefijo que no es carpeta', () => {
    assert.ok(pathInside(root, path.join(root, 'src', 'a.ts')));
    assert.ok(pathInside(root, root));
    assert.ok(!pathInside(root, path.dirname(root)));
    assert.ok(!pathInside(root, root + '-otro'));
    if (process.platform === 'win32') { assert.ok(pathInside('C:/Repos/P', 'c:\\repos\\p\\x.txt')); }
  });
  test('safeRepoPath: solo rutas relativas dentro del repo', () => {
    assert.equal(safeRepoPath(root, 'src/a.ts'), path.join(root, 'src', 'a.ts'));
    assert.equal(safeRepoPath(root, '../fuera.txt'), undefined);
    assert.equal(safeRepoPath(root, 'src/../../fuera.txt'), undefined);
    assert.equal(safeRepoPath(root, path.resolve('/etc/passwd')), undefined);
    assert.equal(safeRepoPath(root, ''), undefined);
    assert.equal(safeRepoPath(root, '.'), undefined);
    assert.equal(safeRepoPath(root, 'a\0b'), undefined);
    assert.equal(safeRepoPath(root, 42), undefined);
  });
});

// Refs de mentira para pickPinnedRef
const local = (name: string) => ({ type: 'local', name, full: `refs/heads/${name}` });
const remote = (remote: string, branch: string) => ({ type: 'remote', name: `${remote}/${branch}`, remote, branch, full: `refs/remotes/${remote}/${branch}` });

describe('pickPinnedRef con main/master (la rama principal de un repo, para el grafo)', () => {
  const pickMain = <R extends { type: string; name: string; remote?: string; branch?: string }>(refs: R[], remote?: string) => pickPinnedRef(refs, remote, DEFAULT_PINNED_BRANCHES);

  test('la local main', () => assert.equal(pickMain([local('dev'), local('main')])?.name, 'main'));
  test('la local master si no hay main', () => assert.equal(pickMain([local('dev'), local('master')])?.name, 'master'));
  test('main antes que master si hay las dos', () => assert.equal(pickMain([local('master'), local('main')])?.name, 'main'));
  test('manda la prioridad: main del remoto antes que master local', () => assert.equal(pickMain([remote('origin', 'main'), local('master')])?.name, 'origin/main'));
  test('de la misma rama, la local antes que la remota', () => assert.equal(pickMain([remote('origin', 'main'), local('main')])?.name, 'main'));

  test('sin la local, la del remoto por defecto', () => {
    assert.equal(pickMain([remote('upstream', 'main'), remote('origin', 'main')], 'origin')?.name, 'origin/main');
    assert.equal(pickMain([remote('origin', 'master')], 'origin')?.name, 'origin/master');
  });

  test('un remoto sin «branch» (se saca del nombre) también vale', () => {
    assert.equal(pickMain([{ type: 'remote', name: 'origin/main', remote: 'origin' }], 'origin')?.name, 'origin/main');
  });

  test('ni main ni master: ninguna (ni un tag ni una rama que se llame parecido)', () => {
    assert.equal(pickMain([local('develop'), local('main2'), local('feature/main'), { type: 'tag', name: 'main', full: 'refs/tags/main' }]), undefined);
    assert.equal(pickMain([]), undefined);
  });
});

describe('pinnedBranchNames y pickPinnedRef con una lista de ramas (jbGit.graphPinBranch / graphPinnedBranch)', () => {
  const pin = (enabled: unknown, names: unknown) => pinnedBranchNames(cfg({ graphPinBranch: enabled, graphPinnedBranch: names }));

  test('por defecto: main y, si no hay, master', () => assert.deepEqual(pinnedBranchNames(cfg({})), ['main', 'master']));
  test('la lista tal cual, en su orden, sin espacios, vacías ni repetidas', () => {
    assert.deepEqual(pin(true, ['branchA', ' branchB ', '', 'branchA']), ['branchA', 'branchB']);
    assert.deepEqual(pin(true, ['master']), ['master'], 'master solo ya no añade main');
  });
  test('desactivado, lista vacía o valor raro: ninguna', () => {
    assert.deepEqual(pin(false, ['main']), []);
    assert.deepEqual(pin(true, []), []);
    assert.deepEqual(pin(true, ''), []);
    assert.deepEqual(pin(true, 3), []);
    assert.deepEqual(pin(true, ['dos palabras', 7]), []);
  });

  test('pinnedBranchList (lo que recibe Settings): siempre una lista, también desactivado o escrito a mano', () => {
    assert.deepEqual(pinnedBranchList(cfg({ graphPinBranch: false, graphPinnedBranch: ['develop'] })), ['develop']);
    assert.deepEqual(pinnedBranchList(cfg({ graphPinnedBranch: 'develop, main' })), [], 'un texto no es una lista');
    assert.deepEqual(pinnedBranchList(cfg({ graphPinnedBranch: {} })), []);
    assert.deepEqual(pinnedBranchList(cfg({ graphPinnedBranch: null })), []);
    assert.deepEqual(pinnedBranchList(cfg({})), ['main', 'master']);
  });

  test('pickPinnedRef: la primera de la lista que exista', () => {
    const refs = [local('main'), local('branchB')];
    assert.equal(pickPinnedRef([...refs, local('branchA')], 'origin', ['branchA', 'branchB'])?.name, 'branchA');
    assert.equal(pickPinnedRef(refs, 'origin', ['branchA', 'branchB'])?.name, 'branchB', 'sin branchA, branchB');
    assert.equal(pickPinnedRef(refs, 'origin', ['branchA', 'branchC']), undefined, 'ninguna: no cae a main');
    assert.equal(pickPinnedRef(refs, 'origin', []), undefined);
  });
  test('pickPinnedRef: la prioridad manda sobre local/remota (branchA del remoto antes que branchB local)', () => {
    assert.equal(pickPinnedRef([local('branchB'), remote('origin', 'branchA')], 'origin', ['branchA', 'branchB'])?.name, 'origin/branchA');
    assert.equal(pickPinnedRef([remote('origin', 'branchA'), local('branchA')], 'origin', ['branchA'])?.name, 'branchA');
    assert.equal(pickPinnedRef([local('branchB'), remote('upstream', 'branchA')], 'origin', ['branchA', 'branchB'])?.name, 'branchB', 'solo el remoto por defecto');
  });
});

describe('validateSetting de graphPinBranch y graphPinnedBranch', () => {
  test('graphPinBranch: solo booleanos', () => {
    assert.equal(validateSetting('graphPinBranch', false), false);
    assert.equal(validateSetting('graphPinBranch', true), true);
    assert.equal(validateSetting('graphPinBranch', 'no'), undefined);
  });
  test('graphPinnedBranch: lista de nombres sin espacios (vacía vale)', () => {
    assert.deepEqual(validateSetting('graphPinnedBranch', [' feature/x ', 'main', '', 'main']), ['feature/x', 'main']);
    assert.deepEqual(validateSetting('graphPinnedBranch', []), []);
    assert.equal(validateSetting('graphPinnedBranch', ['main', 'dos palabras']), undefined);
    assert.equal(validateSetting('graphPinnedBranch', ['x'.repeat(251)]), undefined);
    assert.equal(validateSetting('graphPinnedBranch', ['main', 3]), undefined);
    assert.equal(validateSetting('graphPinnedBranch', 'main'), undefined);
  });
});

describe('nestedRepos (repos que viven dentro de otro repo de la lista)', () => {
  const root = path.resolve('/w/outer');
  const at = (...p: string[]) => path.join(root, ...p);

  test('devuelve los de dentro, relativos al de fuera y con «/»', () => {
    assert.deepEqual(nestedRepos(root, [root, at('api'), at('libs', 'core'), path.resolve('/w/otro')]), ['api', 'libs/core']);
  });

  test('él mismo, los hermanos y los de fuera no cuentan', () => {
    assert.deepEqual(nestedRepos(root, [root, path.resolve('/w/outer2'), path.resolve('/w'), path.resolve('/x/outer/api')]), []);
    assert.deepEqual(nestedRepos(root, []), []);
  });

  test('un repo de nombre parecido («outer2») no se toma por uno de dentro de «outer»', () => {
    assert.deepEqual(nestedRepos(root, [path.resolve('/w/outer-api')]), []);
  });

  test('también cuenta los repos anidados dentro de otros anidados', () => {
    assert.deepEqual(nestedRepos(root, [at('a'), at('a', 'b')]), ['a', 'a/b']);
  });

  test('en Windows y macOS no distingue mayúsculas, como samePath', { skip: process.platform === 'linux' }, () => {
    assert.deepEqual(nestedRepos(root, [at('API').replace('outer', 'OUTER')]), ['API']);
  });
});
