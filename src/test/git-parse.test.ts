/**
 * Tests de los parsers puros de git.ts, con entradas escritas a mano (sin ejecutar git).
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseStatusZ, parseNameStatusZ, parseDiffBlocks, buildBlockPatch, splitRemoteRef } from '../git';

/** Salida de `git status --porcelain=v1 -z` a partir de sus entradas. */
const z = (...entries: string[]) => entries.map(e => e + '\0').join('');

describe('parseStatusZ', () => {
  test('salida vacía', () => assert.deepEqual(parseStatusZ(''), []));

  test('solo en el índice (columna X)', () => {
    for (const x of ['M', 'A', 'D', 'T']) {
      assert.deepEqual(parseStatusZ(z(`${x}  f.txt`)), [{ group: 'staged', status: x, path: 'f.txt', oldPath: undefined }], x);
    }
  });

  test('solo en el árbol de trabajo (columna Y)', () => {
    for (const y of ['M', 'D', 'T', 'A']) {
      assert.deepEqual(parseStatusZ(z(` ${y} f.txt`)), [{ group: 'unstaged', status: y, path: 'f.txt' }], y);
    }
  });

  test('en los dos: sale en staged y en unstaged', () => {
    assert.deepEqual(parseStatusZ(z('MM f.txt')), [
      { group: 'staged', status: 'M', path: 'f.txt', oldPath: undefined },
      { group: 'unstaged', status: 'M', path: 'f.txt' },
    ]);
    assert.deepEqual(parseStatusZ(z('AD f.txt')), [
      { group: 'staged', status: 'A', path: 'f.txt', oldPath: undefined },
      { group: 'unstaged', status: 'D', path: 'f.txt' },
    ]);
  });

  test('renombrado en el índice: con -z la ruta de origen va en la entrada siguiente', () => {
    assert.deepEqual(parseStatusZ(z('R  nuevo.txt', 'viejo.txt', ' M otro.txt')), [
      { group: 'staged', status: 'R', path: 'nuevo.txt', oldPath: 'viejo.txt' },
      { group: 'unstaged', status: 'M', path: 'otro.txt' },
    ]);
  });

  test('renombrado y luego modificado (RM)', () => {
    assert.deepEqual(parseStatusZ(z('RM b.txt', 'a.txt')), [
      { group: 'staged', status: 'R', path: 'b.txt', oldPath: 'a.txt' },
      { group: 'unstaged', status: 'M', path: 'b.txt' },
    ]);
  });

  test('copia (C) con ruta de origen', () => {
    assert.deepEqual(parseStatusZ(z('C  copia.txt', 'orig.txt')), [
      { group: 'staged', status: 'C', path: 'copia.txt', oldPath: 'orig.txt' },
    ]);
  });

  test('una ruta de origen corta (menos de 4 caracteres) no se confunde con una entrada', () => {
    assert.deepEqual(parseStatusZ(z('R  bb', 'a', '?? x')), [
      { group: 'staged', status: 'R', path: 'bb', oldPath: 'a' },
      { group: 'untracked', status: '?', path: 'x' },
    ]);
  });

  test('una ruta de origen que parece una entrada de status no se interpreta', () => {
    // «?? x» es un nombre de archivo válido en Linux
    assert.deepEqual(parseStatusZ(z('R  nuevo', '?? x', ' M y')), [
      { group: 'staged', status: 'R', path: 'nuevo', oldPath: '?? x' },
      { group: 'unstaged', status: 'M', path: 'y' },
    ]);
  });

  test('todos los códigos de conflicto van a conflicts con estado U', () => {
    for (const xy of ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']) {
      assert.deepEqual(parseStatusZ(z(`${xy} c.txt`)), [{ group: 'conflicts', status: 'U', path: 'c.txt' }], xy);
    }
  });

  test('sin seguimiento (??) e ignorados (!!)', () => {
    assert.deepEqual(parseStatusZ(z('?? nuevo.txt', '!! ign.log')), [{ group: 'untracked', status: '?', path: 'nuevo.txt' }]);
  });

  test('rutas con espacios, unicode y saltos de línea (con -z no van entre comillas)', () => {
    assert.deepEqual(parseStatusZ(z(' M con espacios.txt', '?? ñandú/ü €.md', 'A  línea\nnueva.txt')), [
      { group: 'unstaged', status: 'M', path: 'con espacios.txt' },
      { group: 'untracked', status: '?', path: 'ñandú/ü €.md' },
      { group: 'staged', status: 'A', path: 'línea\nnueva.txt', oldPath: undefined },
    ]);
  });

  test('renombrado con espacios y tabuladores en las dos rutas', () => {
    assert.deepEqual(parseStatusZ(z('R  dir b/new\tname', 'dir a/old name')), [
      { group: 'staged', status: 'R', path: 'dir b/new\tname', oldPath: 'dir a/old name' },
    ]);
  });

  // git (con un archivo añadido con `git add -N` y el original borrado) detecta el renombrado
  // en el árbol de trabajo: « R nuevo\0viejo\0». La ruta de origen también va en la entrada
  // siguiente, pero el parser solo la consume si X es R o C. Comprobado con git 2.50.
  test('renombrado en el árbol de trabajo ( R, intent-to-add) consume la ruta de origen', () => {
    assert.deepEqual(parseStatusZ(z(' R new.txt', 'old.txt', '?? u.txt')), [
      { group: 'unstaged', status: 'R', path: 'new.txt' },
      { group: 'untracked', status: '?', path: 'u.txt' },
    ]);
  });
});

describe('parseNameStatusZ', () => {
  test('vacío', () => assert.deepEqual(parseNameStatusZ(''), []));

  test('A, M, D y T', () => {
    assert.deepEqual(parseNameStatusZ('A\0a.txt\0M\0m.txt\0D\0d.txt\0T\0t.txt\0'), [
      { status: 'A', path: 'a.txt' },
      { status: 'M', path: 'm.txt' },
      { status: 'D', path: 'd.txt' },
      { status: 'T', path: 't.txt' },
    ]);
  });

  test('R y C con porcentaje de similitud: origen y luego destino', () => {
    assert.deepEqual(parseNameStatusZ('R087\0viejo.txt\0nuevo.txt\0C100\0orig.txt\0copia.txt\0M\0x\0'), [
      { status: 'R', path: 'nuevo.txt', oldPath: 'viejo.txt' },
      { status: 'C', path: 'copia.txt', oldPath: 'orig.txt' },
      { status: 'M', path: 'x' },
    ]);
  });

  test('rutas con espacios, tabuladores, saltos de línea y unicode', () => {
    assert.deepEqual(parseNameStatusZ('M\0a b\tc\nd ñ.txt\0R100\0x y\0z\tw\0'), [
      { status: 'M', path: 'a b\tc\nd ñ.txt' },
      { status: 'R', path: 'z\tw', oldPath: 'x y' },
    ]);
  });

  test('sin el \\0 final también funciona', () => {
    assert.deepEqual(parseNameStatusZ('M\0a.txt'), [{ status: 'M', path: 'a.txt' }]);
  });
});

describe('splitRemoteRef', () => {
  test('remoto normal y rama con barras', () => {
    assert.deepEqual(splitRemoteRef('origin/feature/x', ['origin']), { remote: 'origin', branch: 'feature/x' });
  });
  test('remoto con barras: gana el más largo que encaja', () => {
    assert.deepEqual(splitRemoteRef('team/origin/main', ['team', 'team/origin']), { remote: 'team/origin', branch: 'main' });
    assert.deepEqual(splitRemoteRef('team/main', ['team', 'team/origin']), { remote: 'team', branch: 'main' });
  });
  test('un remoto que es prefijo sin barra no encaja («orig» no es «origin»)', () => {
    assert.deepEqual(splitRemoteRef('origin/main', ['orig', 'origin']), { remote: 'origin', branch: 'main' });
  });
  test('remoto desconocido: se corta en la primera barra', () => {
    assert.deepEqual(splitRemoteRef('upstream/feature/y', ['origin']), { remote: 'upstream', branch: 'feature/y' });
  });
  test('sin barra: sin remoto', () => {
    assert.deepEqual(splitRemoteRef('main', []), { remote: '', branch: 'main' });
  });
});

// ---------------------------------------------------------------------------
// Bloques de un diff unificado
// ---------------------------------------------------------------------------

const HDR = 'diff --git a/f.txt b/f.txt\nindex 1111111..2222222 100644\n--- a/f.txt\n+++ b/f.txt\n';

describe('parseDiffBlocks', () => {
  test('diff vacío: ni hunks ni bloques', () => assert.deepEqual(parseDiffBlocks(''), { hunks: [], blocks: [] }));

  test('varios bloques por hunk y varios hunks, con números de línea', () => {
    const diff = HDR +
      '@@ -1,7 +1,7 @@\n a\n-b\n+B\n c\n d\n e\n-f\n+F\n g\n' +
      '@@ -20,3 +20,4 @@\n x\n+y\n z\n\\ No newline at end of file\n';
    const { hunks, blocks } = parseDiffBlocks(diff);
    assert.deepEqual(blocks, [['-b', '+B'], ['-f', '+F'], ['+y']]);
    assert.equal(hunks.length, 2);
    const h0 = hunks[0].map(e => [e.t, e.text, e.oAt, e.nAt, e.block]);
    assert.deepEqual(h0, [
      [' ', 'a', 1, 1, -1], ['-', 'b', 2, 2, 0], ['+', 'B', 3, 2, 0], [' ', 'c', 3, 3, -1],
      [' ', 'd', 4, 4, -1], [' ', 'e', 5, 5, -1], ['-', 'f', 6, 6, 1], ['+', 'F', 7, 6, 1], [' ', 'g', 7, 7, -1],
    ]);
    const h1 = hunks[1];
    assert.deepEqual(h1.map(e => [e.t, e.text, e.oAt, e.nAt, e.block]), [[' ', 'x', 20, 20, -1], ['+', 'y', 21, 21, 2], [' ', 'z', 21, 22, -1]]);
    // «\ No newline» marca la línea anterior y no es una entrada
    assert.equal(h1[2].noNewline, true);
    assert.equal(h1[0].noNewline, false);
  });

  test('«\\ No newline» entre «-» y «+» no corta el bloque', () => {
    const { blocks, hunks } = parseDiffBlocks(HDR + '@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n');
    assert.deepEqual(blocks, [['-b', '+b']]);
    assert.equal(hunks[0][1].noNewline, true);
    assert.equal(hunks[0][2].noNewline, false);
  });

  test('archivo nuevo (-0,0): la primera línea es la 1 en las dos versiones', () => {
    const { hunks, blocks } = parseDiffBlocks('diff --git a/n b/n\nnew file mode 100644\n--- /dev/null\n+++ b/n\n@@ -0,0 +1,2 @@\n+x\n+y\n');
    assert.deepEqual(blocks, [['+x', '+y']]);
    assert.deepEqual(hunks[0].map(e => [e.oAt, e.nAt]), [[1, 1], [1, 2]]);
  });

  test('archivo borrado (+0,0)', () => {
    const { hunks, blocks } = parseDiffBlocks('diff --git a/n b/n\ndeleted file mode 100644\n--- a/n\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-x\n-y\n');
    assert.deepEqual(blocks, [['-x', '-y']]);
    assert.deepEqual(hunks[0].map(e => [e.oAt, e.nAt]), [[1, 1], [2, 1]]);
  });

  test('borrado puro en medio (+N,0): nAt es la línea siguiente', () => {
    const { hunks } = parseDiffBlocks(HDR + '@@ -3,2 +2,0 @@\n-x\n-y\n');
    assert.deepEqual(hunks[0].map(e => [e.oAt, e.nAt]), [[3, 3], [4, 3]]);
  });

  test('hunk de una sola línea sin contador (@@ -5 +5 @@)', () => {
    const { hunks } = parseDiffBlocks(HDR + '@@ -5 +5 @@\n-a\n+b\n');
    assert.deepEqual(hunks[0].map(e => [e.t, e.oAt, e.nAt]), [['-', 5, 5], ['+', 6, 5]]);
  });

  test('líneas cuyo contenido empieza por «--», «++» o «@@» dentro de un hunk', () => {
    const { blocks } = parseDiffBlocks(HDR + '@@ -1,3 +1,3 @@\n--- a/x\n+++ b/x\n @@ ctx\n-@@ -1 +1 @@\n+\\ barra\n');
    assert.deepEqual(blocks, [['--- a/x', '+++ b/x'], ['-@@ -1 +1 @@', '+\\ barra']]);
  });

  test('diff de varios archivos: las cabeceras del segundo no entran en el hunk del primero', () => {
    const diff = HDR + '@@ -1 +1 @@\n-a\n+b\n' +
      'diff --git a/g b/g\nindex 3..4 100644\n--- a/g\n+++ b/g\n@@ -1 +1 @@\n-c\n+d\n';
    const { hunks, blocks } = parseDiffBlocks(diff);
    assert.deepEqual(blocks, [['-a', '+b'], ['-c', '+d']]);
    assert.deepEqual(hunks.map(h => h.length), [2, 2]);
  });

  test('CRLF: el \\r se conserva en el texto', () => {
    const { blocks, hunks } = parseDiffBlocks(HDR + '@@ -1,2 +1,2 @@\n a\r\n-b\r\n+B\r\n');
    assert.deepEqual(blocks, [['-b\r', '+B\r']]);
    assert.equal(hunks[0][0].text, 'a\r');
  });

  test('sin cabecera @@ no hay nada', () => assert.deepEqual(parseDiffBlocks(HDR + '-a\n+b\n').blocks, []));
});

describe('buildBlockPatch (texto del parche)', () => {
  // Un hunk con dos bloques separados por una línea de contexto
  const DIFF = HDR + '@@ -1,5 +1,5 @@\n a\n-b\n+B\n c\n-d\n+D\n e\n';
  const head = (h: string) => `diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n${h}\n`;

  test('reverse: los demás bloques cuentan como aplicados (sus «+» son contexto, sus «-» desaparecen)', () => {
    assert.equal(buildBlockPatch(DIFF, 1, 'f.txt'), head('@@ -1,5 +1,5 @@') + ' a\n B\n c\n-d\n+D\n e\n');
    assert.equal(buildBlockPatch(DIFF, 0, 'f.txt', 'reverse'), head('@@ -1,5 +1,5 @@') + ' a\n-b\n+B\n c\n D\n e\n');
  });

  test('forward: los demás bloques cuentan como no aplicados (sus «-» son contexto, sus «+» desaparecen)', () => {
    assert.equal(buildBlockPatch(DIFF, 0, 'f.txt', 'forward'), head('@@ -1,5 +1,5 @@') + ' a\n-b\n+B\n c\n d\n e\n');
    assert.equal(buildBlockPatch(DIFF, 1, 'f.txt', 'forward'), head('@@ -1,5 +1,5 @@') + ' a\n b\n c\n-d\n+D\n e\n');
  });

  test('bloque inexistente: null', () => {
    assert.equal(buildBlockPatch(DIFF, 2, 'f.txt'), null);
    assert.equal(buildBlockPatch('', 0, 'f.txt'), null);
  });

  // -1 es el «bloque» de las líneas de contexto: se encuentra un hunk y sale un parche solo de
  // contexto. La extensión solo comprueba Number.isInteger(block), y blocks[-1] (undefined)
  // coincide con lines si el mensaje no trae lines.
  test('bloque -1 (contexto): null', () => {
    assert.equal(buildBlockPatch(DIFF, -1, 'f.txt'), null);
  });

  test('la ventana es de 3 líneas de contexto y empieza en el número correcto', () => {
    // Hunk con mucho contexto (como con -U10): 1..10, cambia la 6
    const lines = Array.from({ length: 10 }, (_, i) => `l${i + 1}`);
    const body = lines.map((l, i) => (i === 5 ? `-${l}\n+L6` : ` ${l}`)).join('\n') + '\n';
    const diff = HDR + '@@ -1,10 +1,10 @@\n' + body;
    assert.equal(buildBlockPatch(diff, 0, 'f.txt'), head('@@ -3,7 +3,7 @@') + ' l3\n l4\n l5\n-l6\n+L6\n l7\n l8\n l9\n');
  });

  test('solo añadidos o solo borrados: el lado vacío empieza en la línea anterior', () => {
    const add = HDR + '@@ -2,0 +3,2 @@\n+x\n+y\n';
    assert.equal(buildBlockPatch(add, 0, 'f.txt', 'forward'), head('@@ -2,0 +3,2 @@') + '+x\n+y\n');
    const del = HDR + '@@ -3,2 +2,0 @@\n-x\n-y\n';
    assert.equal(buildBlockPatch(del, 0, 'f.txt'), head('@@ -3,2 +2,0 @@') + '-x\n-y\n');
  });

  test('archivo nuevo y archivo borrado entero', () => {
    const nuevo = 'diff --git a/n b/n\nnew file mode 100644\n--- /dev/null\n+++ b/n\n@@ -0,0 +1,2 @@\n+x\n+y\n';
    assert.equal(buildBlockPatch(nuevo, 0, 'n'), 'diff --git a/n b/n\n--- a/n\n+++ b/n\n@@ -0,0 +1,2 @@\n+x\n+y\n');
  });

  test('«\\ No newline» se copia detrás de su línea', () => {
    const diff = HDR + '@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+B\n\\ No newline at end of file\n';
    assert.equal(buildBlockPatch(diff, 0, 'f.txt'),
      head('@@ -1,2 +1,2 @@') + ' a\n-b\n\\ No newline at end of file\n+B\n\\ No newline at end of file\n');
  });

  test('las barras invertidas de la ruta pasan a «/»', () => {
    const p = buildBlockPatch(DIFF, 0, 'dir\\sub\\f.txt')!;
    assert.match(p, /^diff --git a\/dir\/sub\/f\.txt b\/dir\/sub\/f\.txt\n--- a\/dir\/sub\/f\.txt\n\+\+\+ b\/dir\/sub\/f\.txt\n/);
  });

  test('un bloque del segundo hunk solo lleva líneas de ese hunk', () => {
    const diff = HDR + '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -10,3 +10,3 @@\n x\n-y\n+Y\n z\n';
    assert.equal(buildBlockPatch(diff, 1, 'f.txt'), head('@@ -10,3 +10,3 @@') + ' x\n-y\n+Y\n z\n');
  });
});
