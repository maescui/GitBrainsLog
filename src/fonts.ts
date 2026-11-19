import * as vscode from 'vscode';
import { validFontFamily, validFontSize } from './core';

/**
 * Fuente de la interfaz de la extensión (Settings ▸ General ▸ Fonts): por defecto la de VS
 * Code; jbGit.fontFamily / fontSize la cambian ('' / 0 = la de VS Code). El código (diffs,
 * visor de conflictos, mensaje del commit) usa siempre la fuente y el tamaño del editor de VS
 * Code, sin ajuste propio, para que no se note la diferencia con el código real. Los CSS usan
 * --jb-font y --jb-font-size con la de VS Code como valor por defecto.
 */
export interface FontSettings { fontFamily: string; fontSize: number }

export function fontSettings(): FontSettings {
  const c = vscode.workspace.getConfiguration('jbGit');
  return {
    fontFamily: c.get<string>('fontFamily', ''),
    fontSize: c.get<number>('fontSize', 0),
  };
}


/**
 * Atributos del <body> de cada webview con las fuentes; su script las pasa a variables CSS
 * por CSSOM (la CSP no deja <style> ni style="" en línea).
 */
export function fontAttrs(): string {
  const f = fontSettings();
  const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  const attrs: string[] = [];
  if (validFontFamily(f.fontFamily) && f.fontFamily.trim()) { attrs.push(`data-font="${esc(f.fontFamily.trim())}"`); }
  if (validFontSize(f.fontSize) && f.fontSize) { attrs.push(`data-font-size="${f.fontSize}"`); }
  return attrs.length ? ' ' + attrs.join(' ') : '';
}
