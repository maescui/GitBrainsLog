/**
 * media/dateformat.js: la fecha con un patrón personalizado (jbGit.dateFormatPattern). El script se
 * carga en un webview, no es un módulo: se evalúa con `new Function` y un `window` de mentira.
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import * as path from 'path';

const SRC = readFileSync(path.join(__dirname, '..', '..', 'media', 'dateformat.js'), 'utf8');
const win: any = {};
new Function('window', SRC)(win);
const format: (pattern: string, d: Date) => string = win.jbDateFormat.format;

// Miércoles 9 de septiembre de 2026, 08:05:07 (hora local)
const d = new Date(2026, 8, 9, 8, 5, 7);
const pm = new Date(2026, 11, 28, 22, 58, 0);
const intl = (date: Date, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(undefined, o).format(date);

describe('formato de fecha personalizado (dateformat.js)', () => {
  test('el patrón por defecto y los habituales', () => {
    assert.equal(format('dd/MM/yyyy HH:mm', d), '09/09/2026 08:05');
    assert.equal(format('yyyy-MM-dd HH:mm:ss', d), '2026-09-09 08:05:07');
    assert.equal(format('d/M/yy H:m:s', d), '9/9/26 8:5:7');
    assert.equal(format('dd/MM/yyyy HH:mm', pm), '28/12/2026 22:58');
  });

  test('hora de 12 horas con AM / PM (las 0 y las 12 son 12)', () => {
    assert.equal(format('hh:mm a', d), '08:05 AM');
    assert.equal(format('h:mm a', pm), '10:58 PM');
    assert.equal(format('h a', new Date(2026, 0, 1, 0, 0)), '12 AM');
    assert.equal(format('h a', new Date(2026, 0, 1, 12, 0)), '12 PM');
  });

  test('nombres de mes y de día en el idioma actual', () => {
    assert.equal(format('MMMM', d), intl(d, { month: 'long' }));
    assert.equal(format('MMM', d), intl(d, { month: 'short' }));
    assert.equal(format('EEEE', d), intl(d, { weekday: 'long' }));
    assert.equal(format('EEE d MMM', d), `${intl(d, { weekday: 'short' })} 9 ${intl(d, { month: 'short' })}`);
  });

  test('el texto entre comillas simples sale tal cual, y \'\' es una comilla', () => {
    assert.equal(format("dd/MM 'a las' HH:mm", d), '09/09 a las 08:05');
    assert.equal(format("'day' d", d), 'day 9');
    assert.equal(format("HH'h'mm", d), '08h05');
    assert.equal(format("''yy", d), "'26");
    assert.equal(format("'it''s' d", d), "it's 9");
  });

  test('los demás caracteres no se tocan', () => {
    assert.equal(format('[dd.MM.yyyy] · HH:mm', d), '[09.09.2026] · 08:05');
    assert.equal(format('<b>&', d), '<b>&', 'sin escapar: lo escapa quien lo pinta (esc)');
    assert.equal(format('', d), '');
  });
});
