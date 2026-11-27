/**
 * media/fileicons.js: qué icono toca a cada archivo y carpeta según el tema de iconos (el script se
 * carga en un webview, no es un módulo: se evalúa con `new Function` y un `window` de mentira).
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import * as path from 'path';

const SRC = readFileSync(path.join(__dirname, '..', '..', 'media', 'fileicons.js'), 'utf8');

/** Carga el script con un window y, si se pide, un FontFace de mentira. Devuelve la API (window.jbFileIcons). */
function load(fontFace?: unknown, doc: unknown = {}): any {
  const win: any = {};
  new Function('window', 'document', 'FontFace', SRC)(win, doc, fontFace);
  return win.jbFileIcons;
}

const img = (n: string) => ({ src: `data:image/svg+xml;base64,${n}` });
/** Un tema como el que manda la extensión (ya resuelto para el tema de color actual). */
const theme = (extra: object = {}) => ({
  id: 't',
  defs: { file: img('F'), folder: img('D'), folderOpen: img('DO'), ts: img('TS'), dts: img('DTS'), test: img('TEST'), git: img('GIT'),
    src: img('SRC'), srcOpen: img('SRCO'), node: img('NODE'), py: img('PY'), make: img('MAKE') },
  fonts: [],
  file: 'file', folder: 'folder', folderExpanded: 'folderOpen',
  fileNames: { '.gitignore': 'git', 'dockerfile': 'make' },
  fileExtensions: { ts: 'ts', 'd.ts': 'dts', 'test.ts': 'test', gitignore: 'git' },
  folderNames: { src: 'src', node_modules: 'node' }, folderNamesExpanded: { src: 'srcOpen' },
  languageIds: { python: 'py', makefile: 'make' }, langByExt: { py: 'python' }, langByName: { makefile: 'makefile' },
  ...extra,
});
const srcOf = (html: string) => /src="data:image\/svg\+xml;base64,([^"]*)"/.exec(html)?.[1];
const fileIcon = (api: any, name: string) => srcOf(api.html(name, false));
const folderIcon = (api: any, name: string, open = false) => srcOf(api.html(name, true, open));

describe('icono de un archivo', () => {
  const api = load(); api.setTheme(theme());

  test('por nombre exacto, con cualquier ruta y sin distinguir mayúsculas', () => {
    assert.equal(fileIcon(api, '.gitignore'), 'GIT');
    assert.equal(fileIcon(api, 'src/deep/.GitIgnore'), 'GIT');
    assert.equal(fileIcon(api, 'Dockerfile'), 'MAKE');
  });

  test('por extensión, sin distinguir mayúsculas', () => {
    assert.equal(fileIcon(api, 'a.ts'), 'TS');
    assert.equal(fileIcon(api, 'src/A.TS'), 'TS');
  });

  test('la extensión más larga primero: «a.test.ts» y «a.d.ts» no son un «ts» cualquiera', () => {
    assert.equal(fileIcon(api, 'a.test.ts'), 'TEST');
    assert.equal(fileIcon(api, 'tipos.d.ts'), 'DTS');
    assert.equal(fileIcon(api, 'a.b.c.ts'), 'TS', 'se prueban «b.c.ts», «c.ts» y por último «ts»');
  });

  test('el nombre manda sobre la extensión', () => {
    api.setTheme(theme({ fileNames: { 'raro.ts': 'git' } }));
    assert.equal(fileIcon(api, 'raro.ts'), 'GIT');
    api.setTheme(theme());
  });

  test('por lenguaje, si el tema los usa: por extensión y por nombre de archivo', () => {
    assert.equal(fileIcon(api, 'script.py'), 'PY');
    assert.equal(fileIcon(api, 'Makefile'), 'MAKE');
  });

  test('sin asociación, el icono de archivo del tema', () => {
    assert.equal(fileIcon(api, 'datos.xyz'), 'F');
    assert.equal(fileIcon(api, 'LICENSE'), 'F');
    assert.equal(fileIcon(api, '.hidden'), 'F');
  });

  test('un archivo con la ruta con «/» al final no se confunde (se usa el último nombre)', () => {
    assert.equal(fileIcon(api, 'src/a.ts/'), 'TS');
  });

  test('si el tema no tiene icono de archivo por defecto, los desconocidos se quedan sin icono', () => {
    api.setTheme(theme({ file: undefined }));
    assert.equal(api.html('datos.xyz', false), '');
    assert.equal(fileIcon(api, 'a.ts'), 'TS');
    api.setTheme(theme());
  });

  test('si el icono asociado no se pudo leer (no está en defs), sin icono', () => {
    api.setTheme(theme({ fileExtensions: { zip: 'noExiste' } }));
    assert.equal(api.html('a.zip', false), '');
    api.setTheme(theme());
  });
});

describe('icono de una carpeta', () => {
  const api = load(); api.setTheme(theme());

  test('por nombre, y la carpeta de siempre si no tiene', () => {
    assert.equal(folderIcon(api, 'node_modules'), 'NODE');
    assert.equal(folderIcon(api, 'SRC'), 'SRC', 'sin distinguir mayúsculas');
    assert.equal(folderIcon(api, 'docs'), 'D');
  });

  test('abierta: su propia asociación, si no la de cerrada, y si no la de «carpeta abierta» del tema', () => {
    assert.equal(folderIcon(api, 'src', true), 'SRCO', 'asociación propia de abierta');
    assert.equal(folderIcon(api, 'node_modules', true), 'NODE', 'sin la propia, la de cerrada');
    assert.equal(folderIcon(api, 'docs', true), 'DO', 'carpeta abierta por defecto');
  });

  test('si el tema no distingue abierta y cerrada, la misma', () => {
    api.setTheme(theme({ folderExpanded: undefined, folderNamesExpanded: {} }));
    assert.equal(folderIcon(api, 'docs', true), 'D');
    assert.equal(folderIcon(api, 'src', true), 'SRC');
    api.setTheme(theme());
  });

  test('una cadena compactada («src/main/java») cuenta por su último nombre', () => {
    assert.equal(folderIcon(api, 'x/y/src'), 'SRC');
    assert.equal(folderIcon(api, 'src/main/node_modules/'), 'NODE');
  });
});

describe('html del icono', () => {
  test('sin tema (o con null o con algo que no es un tema): vacío, y cada fila usa su icono de siempre', () => {
    const api = load();
    assert.equal(api.hasTheme(), false);
    assert.equal(api.html('a.ts', false), '');
    api.setTheme(theme()); assert.equal(api.hasTheme(), true);
    api.setTheme(null); assert.equal(api.hasTheme(), false);
    assert.equal(api.html('a.ts', false), '');
    api.setTheme(theme()); api.setTheme({ raro: 1 } as any); assert.equal(api.hasTheme(), false);
    api.setTheme(theme()); api.setTheme(undefined); assert.equal(api.hasTheme(), false);
  });

  test('una imagen: un <img> sin texto alternativo ni arrastre', () => {
    const api = load(); api.setTheme(theme());
    assert.equal(api.html('a.ts', false), '<img class="ficon" src="data:image/svg+xml;base64,TS" alt="" draggable="false">');
  });

  test('lo que viene del tema se escapa (comillas y «<»)', () => {
    const api = load();
    api.setTheme(theme({ defs: { file: { src: 'data:x"><script>alert(1)</script>' }, folder: img('D') } }));
    const h = api.html('a.zip', false);
    assert.ok(!h.includes('<script>') && !h.includes('"><'), h);
    assert.match(h, /&quot;&gt;&lt;script&gt;/);
  });

  test('un icono de carácter: un <span> con la fuente, el color y el tamaño en atributos data-*', () => {
    const api = load();
    api.setTheme(theme({ defs: { file: { glyph: { font: 'seti', ch: '', color: '#519aba', size: '150%' } } }, fonts: [] }));
    assert.equal(api.html('a.zip', false), '<span class="ficon ficon-g" data-font="seti" data-color="#519aba" data-size="150%"></span>');
    api.setTheme(theme({ defs: { file: { glyph: { font: 'seti', ch: '<' } } } }));
    assert.equal(api.html('a.zip', false), '<span class="ficon ficon-g" data-font="seti">&lt;</span>', 'sin color ni tamaño, y escapado');
  });
});

describe('apply (fuente, color y tamaño de los iconos de carácter, por CSSOM)', () => {
  const el = (font: string, color?: string, size?: string) => ({ dataset: { font, ...(color ? { color } : {}), ...(size ? { size } : {}) } as Record<string, string>, style: {} as Record<string, string> });
  const root = (els: any[]) => ({ querySelectorAll: (sel: string) => (sel === '.ficon-g:not([data-done])' ? els.filter(e => !e.dataset.done) : []) });

  test('pone la familia de la fuente del tema, el color y el tamaño, y lo marca como hecho', () => {
    const api = load();
    const a = el('seti', '#fff', '120%'), b = el('seti');
    api.apply(root([a, b]));
    assert.deepEqual(a.style, { fontFamily: 'jbicon-seti', color: '#fff', fontSize: '120%' });
    assert.deepEqual(b.style, { fontFamily: 'jbicon-seti' });
    assert.equal(a.dataset.done, '1');
  });

  test('no repite lo ya hecho', () => {
    const api = load();
    const a = el('seti', '#fff');
    api.apply(root([a]));
    a.style.color = 'cambiado';
    api.apply(root([a]));
    assert.equal(a.style.color, 'cambiado');
  });

  test('el nombre de la familia se sanea (un id raro del tema no rompe el CSS)', () => {
    const api = load();
    const a = el('mi fuente/1;x');
    api.apply(root([a]));
    assert.equal(a.style.fontFamily, 'jbicon-mi_fuente_1_x');
  });
});

describe('fuentes del tema', () => {
  test('al poner el tema se cargan sus fuentes con FontFace y se añaden al documento', async () => {
    const created: any[] = [], added: any[] = [];
    class FakeFace { constructor(public family: string, public src: string, public desc: any) { created.push(this); } load() { return Promise.resolve(this); } }
    const api = load(FakeFace, { fonts: { add: (f: any) => added.push(f) } });
    api.setTheme(theme({ fonts: [{ id: 'seti', src: 'data:font/woff;base64,AAAA', weight: 'normal', style: 'italic' }, { id: 'otra', src: 'data:font/woff2;base64,BBBB' }] }));
    assert.deepEqual(created.map(f => [f.family, f.src, f.desc]), [
      ['jbicon-seti', 'url("data:font/woff;base64,AAAA")', { weight: 'normal', style: 'italic' }],
      ['jbicon-otra', 'url("data:font/woff2;base64,BBBB")', { weight: 'normal', style: 'normal' }],
    ]);
    await new Promise(r => setTimeout(r, 5));
    assert.equal(added.length, 2);
  });

  test('si una fuente no carga o no es válida, no pasa nada', async () => {
    class Bad { constructor() { throw new Error('src no válido'); } }
    load(Bad).setTheme(theme({ fonts: [{ id: 'x', src: 'mal' }] }));
    class Rej { constructor() { /* nada */ } load() { return Promise.reject(new Error('404')); } }
    load(Rej, { fonts: { add() { throw new Error('no debería'); } } }).setTheme(theme({ fonts: [{ id: 'x', src: 'mal' }] }));
    await new Promise(r => setTimeout(r, 5));
  });

  test('sin FontFace en el navegador, solo se ignora', () => {
    load(undefined).setTheme(theme({ fonts: [{ id: 'x', src: 'data:font/woff;base64,AA' }] }));
  });
});
