/**
 * Lectura de temas de iconos de archivos (src/iconTheme.ts) con temas de mentira en carpetas temporales.
 */
import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'fs';
import * as path from 'path';
import { tmpDir, rm } from './helpers';
import { buildFileIconTheme, parseGlyph, parseThemeJson, languageMaps, ICON_BUDGET, ThemeJson } from '../iconTheme';

describe('parseThemeJson (el JSON de un tema, que puede llevar comentarios)', () => {
  test('JSON normal', () => assert.deepEqual(parseThemeJson('{"file":"f","fileNames":{"a":"b"}}'), { file: 'f', fileNames: { a: 'b' } }));

  test('con comentarios de línea y de bloque y comas finales', () => {
    const t = parseThemeJson(`{
      // un comentario
      "file": "f", /* otro */
      "fileNames": { "a": "x", },   // coma final
    }`);
    assert.deepEqual(t, { file: 'f', fileNames: { a: 'x' } });
  });

  test('lo que parece un comentario dentro de una cadena no lo es', () => {
    const t = parseThemeJson('{ /* c */ "fileNames": { "a//b": "x", "c/*d*/e": "y" }, }');
    assert.deepEqual(t, { fileNames: { 'a//b': 'x', 'c/*d*/e': 'y' } });
  });

  test('con la marca de orden de bytes (BOM) al principio', () => {
    assert.deepEqual(parseThemeJson(String.fromCharCode(0xFEFF) + '{"file":"f"}'), { file: 'f' });
    assert.deepEqual(parseThemeJson(String.fromCharCode(0xFEFF) + '{"file":"f"} // c'), { file: 'f' });
  });

  test('un comentario de bloque sin cerrar se ignora', () => {
    assert.deepEqual(parseThemeJson('{"file":"f"} /* sin cerrar'), { file: 'f' });
  });

  test('lo que no es un objeto o no se puede leer: undefined', () => {
    for (const t of ['', '[]', '"x"', 'null', '7', '{', '{"a": }', '/* solo comentario */']) {
      assert.equal(parseThemeJson(t), undefined, JSON.stringify(t));
    }
  });
});

describe('parseGlyph (el carácter de un icono de fuente)', () => {
  test('«\\E001» y «\\1F600» (como los escriben los temas)', () => {
    assert.equal(parseGlyph('\\E001'), '');
    assert.equal(parseGlyph('\\e001'), '');
    assert.equal(parseGlyph('\\1F600'), '\u{1F600}');
  });
  test('el propio carácter se deja como está', () => {
    assert.equal(parseGlyph(''), '');
    assert.equal(parseGlyph('A'), 'A');
  });
  test('un código imposible no revienta', () => {
    assert.equal(parseGlyph('\\FFFFFF'), '\\FFFFFF');
    assert.equal(parseGlyph(''), '');
  });
});

describe('languageMaps', () => {
  test('lenguaje de cada extensión y de cada nombre de archivo; gana la primera extensión que lo declara', () => {
    const m = languageMaps([
      { contributes: { languages: [{ id: 'typescript', extensions: ['.ts', '.MTS'], filenames: ['Tsconfig.json'] }] } },
      { contributes: { languages: [{ id: 'otro', extensions: ['.ts'] }] } },
      { },
      { contributes: { languages: [{ extensions: ['.x'] } as any, { id: 'md', extensions: ['md'] }] } },   // sin id, y sin el punto
    ]);
    assert.deepEqual(m.byExt, { ts: 'typescript', mts: 'typescript' });
    assert.deepEqual(m.byName, { 'tsconfig.json': 'typescript' });
  });
});

describe('buildFileIconTheme', () => {
  let root: string, outside: string;
  const svg = (name: string, color = 'red') => `<svg xmlns="http://www.w3.org/2000/svg"><rect fill="${color}"/><!--${name}--></svg>`;
  before(() => {
    root = tmpDir('jbgit-theme-');
    outside = tmpDir('jbgit-out-');
    mkdirSync(path.join(root, 'dist', 'icons'), { recursive: true });
    for (const n of ['file', 'folder', 'ts', 'md', 'light-file', 'light-ts', 'hc-file', 'src', 'src-open', 'git']) {
      writeFileSync(path.join(root, 'dist', 'icons', `${n}.svg`), svg(n));
    }
    writeFileSync(path.join(root, 'dist', 'icons', 'nota.txt'), 'no es una imagen');
    writeFileSync(path.join(outside, 'secreto.svg'), svg('secreto'));
    writeFileSync(path.join(root, 'dist', 'seti.woff'), Buffer.from([1, 2, 3, 4]));
  });
  after(() => { rm(root); rm(outside); });

  const themeFile = () => path.join(root, 'dist', 'theme.json');
  const base: ThemeJson = {
    iconDefinitions: {
      file: { iconPath: './icons/file.svg' }, folder: { iconPath: './icons/folder.svg' },
      ts: { iconPath: './icons/ts.svg' }, md: { iconPath: './icons/md.svg' },
      src: { iconPath: './icons/src.svg' }, 'src-open': { iconPath: './icons/src-open.svg' }, git: { iconPath: './icons/git.svg' },
      lightFile: { iconPath: './icons/light-file.svg' }, lightTs: { iconPath: './icons/light-ts.svg' }, hcFile: { iconPath: './icons/hc-file.svg' },
      nunca: { iconPath: './icons/no-existe.svg' }, unused: { iconPath: './icons/unused-no-existe.svg' },
    },
    file: 'file', folder: 'folder',
    fileExtensions: { TS: 'ts', md: 'md' }, fileNames: { '.GitIgnore': 'git', 'faltan': 'nunca' },
    folderNames: { SRC: 'src' }, folderNamesExpanded: { src: 'src-open' },
    light: { file: 'lightFile', fileExtensions: { ts: 'lightTs' } },
    highContrast: { file: 'hcFile' },
  };
  const build = (json: ThemeJson, kind: 'dark' | 'light' | 'highContrast' = 'dark', langs?: any) =>
    buildFileIconTheme('t', json, themeFile(), root, kind, langs);
  const decode = (uri: string | undefined) => Buffer.from((uri ?? '').split(',')[1] ?? '', 'base64').toString('utf8');

  test('los iconos van como data: URI de SVG, con su contenido', async () => {
    const t = await build(base);
    assert.match(t.defs.ts.src!, /^data:image\/svg\+xml;base64,/);
    assert.match(decode(t.defs.ts.src), /<!--ts-->/);
    assert.equal(t.file, 'file');
    assert.equal(t.folder, 'folder');
  });

  test('los nombres y extensiones se pasan a minúsculas', async () => {
    const t = await build(base);
    assert.deepEqual(t.fileExtensions, { ts: 'ts', md: 'md' });
    assert.equal(t.fileNames['.gitignore'], 'git');
    assert.deepEqual(t.folderNames, { src: 'src' });
    assert.deepEqual(t.folderNamesExpanded, { src: 'src-open' });
  });

  test('solo se leen los iconos que alguna asociación usa (los demás no hace falta ni que existan)', async () => {
    const t = await build(base);
    assert.ok(!('unused' in t.defs));
    assert.ok(!('lightFile' in t.defs), 'en la variante oscura no se usa el de la clara');
  });

  test('un icono que no se puede leer se omite, sin error', async () => {
    const t = await build(base);
    assert.ok(!('nunca' in t.defs));
    assert.ok('ts' in t.defs);
  });

  test('un icono que no es una imagen conocida o que está fuera de la extensión se ignora', async () => {
    const t = await build({
      ...base,
      iconDefinitions: { ...base.iconDefinitions, txt: { iconPath: './icons/nota.txt' }, fuera: { iconPath: path.relative(path.join(root, 'dist'), path.join(outside, 'secreto.svg')) } },
      fileExtensions: { a: 'txt', b: 'fuera', ts: 'ts' },
    });
    assert.ok(!('txt' in t.defs), 'un .txt no es una imagen');
    assert.ok(!('fuera' in t.defs), 'no se sale de la carpeta de la extensión');
    assert.ok('ts' in t.defs);
  });

  test('variante clara: sus asociaciones se suman a las base y sus iconos por defecto las reemplazan', async () => {
    const t = await build(base, 'light');
    assert.equal(t.file, 'lightFile');
    assert.deepEqual(t.fileExtensions, { ts: 'lightTs', md: 'md' });
    assert.ok('lightTs' in t.defs && 'lightFile' in t.defs);
    assert.equal(t.folder, 'folder', 'lo que la variante no toca, igual');
  });

  test('variante de alto contraste, y la oscura no usa ninguna de las dos', async () => {
    assert.equal((await build(base, 'highContrast')).file, 'hcFile');
    const dark = await build(base, 'dark');
    assert.equal(dark.file, 'file');
    assert.deepEqual(dark.fileExtensions, { ts: 'ts', md: 'md' });
  });

  test('tema de fuente (como Seti): la fuente va como data: URI y los iconos son caracteres', async () => {
    const t = await build({
      fonts: [{ id: 'seti', src: [{ path: './seti.woff', format: 'woff' }], weight: 'normal', style: 'normal' }],
      iconDefinitions: {
        file: { fontCharacter: '\\E001', fontColor: '#519aba' },
        ts: { fontCharacter: '\\E002', fontColor: '#6d8086', fontSize: '150%', fontId: 'seti' },
        sinFuente: { fontCharacter: '\\E003', fontId: 'otra' },
      },
      file: 'file', fileExtensions: { ts: 'ts', raro: 'sinFuente' },
    });
    assert.equal(t.fonts.length, 1);
    assert.match(t.fonts[0].src, /^data:font\/woff;base64,/);
    assert.deepEqual([t.fonts[0].id, t.fonts[0].weight, t.fonts[0].style], ['seti', 'normal', 'normal']);
    assert.deepEqual(t.defs.file.glyph, { font: 'seti', ch: '', color: '#519aba', size: undefined });
    assert.deepEqual(t.defs.ts.glyph, { font: 'seti', ch: '', color: '#6d8086', size: '150%' });
    assert.ok(!('sinFuente' in t.defs), 'una fuente que no existe: sin icono');
  });

  test('el tamaño de la fuente es el de sus iconos, salvo que el icono traiga el suyo (Seti: 150 %)', async () => {
    const t = await build({
      fonts: [{ id: 'seti', src: [{ path: './seti.woff' }], size: '150%' }],
      iconDefinitions: { a: { fontCharacter: '\\E001' }, b: { fontCharacter: '\\E002', fontSize: '100%' } },
      file: 'a', fileExtensions: { b: 'b' },
    });
    assert.equal(t.defs.a.glyph!.size, '150%');
    assert.equal(t.defs.b.glyph!.size, '100%');
  });

  test('si no se puede leer la fuente, tampoco hay iconos de carácter (y no se rompe)', async () => {
    const t = await build({
      fonts: [{ id: 'seti', src: [{ path: './no-existe.woff' }] }],
      iconDefinitions: { file: { fontCharacter: '\\E001' } }, file: 'file',
    });
    assert.deepEqual(t.fonts, []);
    assert.deepEqual(t.defs, {});
  });

  test('de varios orígenes de una fuente se usa el primero que se pueda leer', async () => {
    const t = await build({
      fonts: [{ id: 'f', src: [{ path: './no-existe.woff2' }, { path: './seti.woff', format: 'woff' }] }],
      iconDefinitions: { file: { fontCharacter: '\\E001' } }, file: 'file',
    });
    assert.match(t.fonts[0].src, /^data:font\/woff;/);
  });

  test('lenguajes: solo los que el tema usa, y solo si usa languageIds', async () => {
    const langs = { byExt: { ts: 'typescript', py: 'python', foo: 'sinicono' }, byName: { makefile: 'makefile', 'otro.cfg': 'sinicono' } };
    const t = await build({ ...base, languageIds: { typescript: 'ts', makefile: 'md' } }, 'dark', langs);
    assert.deepEqual(t.langByExt, { ts: 'typescript' });
    assert.deepEqual(t.langByName, { makefile: 'makefile' });
    const sin = await build(base, 'dark', langs);
    assert.deepEqual([sin.langByExt, sin.langByName], [{}, {}], 'sin languageIds no hace falta mandar nada');
  });

  test('presupuesto: un icono que no cabe se omite y los que caben se leen', async () => {
    writeFileSync(path.join(root, 'dist', 'icons', 'enorme.svg'), Buffer.alloc(ICON_BUDGET + 1, 32));
    const t = await build({
      ...base,
      iconDefinitions: { ...base.iconDefinitions, enorme: { iconPath: './icons/enorme.svg' } },
      fileExtensions: { big: 'enorme', ts: 'ts' },
    });
    assert.ok(!('enorme' in t.defs));
    assert.ok('ts' in t.defs);
  });

  test('varios iconos que comparten archivo tienen la misma imagen', async () => {
    const t = await build({
      iconDefinitions: { a: { iconPath: './icons/ts.svg' }, b: { iconPath: './icons/ts.svg' } },
      file: 'a', folder: 'b',
    });
    assert.equal(t.defs.a.src, t.defs.b.src);
    assert.ok(t.defs.a.src);
  });

  test('un tema vacío o con basura no rompe nada', async () => {
    const t = await build({} as ThemeJson);
    assert.deepEqual([t.defs, t.fonts, t.fileNames, t.file], [{}, [], {}, undefined]);
    const raro = await build({ fileNames: { a: 7 as any, b: 'x' }, iconDefinitions: { x: { iconPath: './icons/ts.svg' } } } as ThemeJson);
    assert.deepEqual(raro.fileNames, { b: 'x' });
  });
});
