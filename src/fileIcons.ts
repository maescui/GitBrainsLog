/**
 * El tema de iconos de archivos que tiene activo VS Code (`workbench.iconTheme`), listo para
 * mandárselo a los webviews (la lectura del tema, sin `vscode`, está en iconTheme.ts).
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { buildFileIconTheme, languageMaps, parseThemeJson, FileIconTheme, IconThemeKind } from './iconTheme';

let cache: { key: string; theme: Promise<FileIconTheme | null> } | undefined;
const changed = new vscode.EventEmitter<void>();

/** La variante del tema que toca según el tema de color de VS Code. */
function currentKind(): IconThemeKind {
  const k = vscode.window.activeColorTheme?.kind;
  return k === vscode.ColorThemeKind.Light || k === vscode.ColorThemeKind.HighContrastLight ? 'light'
    : k === vscode.ColorThemeKind.HighContrast ? 'highContrast' : 'dark';
}

/** El id del tema (null: «None», sin iconos de archivos) y, si lo trae alguna extensión, dónde está. */
function locate(): { id: string; file: string; root: string } | null {
  const id = vscode.workspace.getConfiguration('workbench').get<string | null>('iconTheme');
  if (!id) { return null; }
  for (const ext of vscode.extensions.all) {
    const entry = (ext.packageJSON?.contributes?.iconThemes as { id: string; path: string }[] | undefined)?.find(t => t?.id === id);
    if (entry && typeof entry.path === 'string') { return { id, file: path.join(ext.extensionPath, entry.path), root: ext.extensionPath }; }
  }
  return null;
}

async function load(): Promise<FileIconTheme | null> {
  const where = locate();
  if (!where) { return null; }
  try {
    const json = parseThemeJson(await fs.readFile(where.file, 'utf8'));
    if (!json) { return null; }
    return await buildFileIconTheme(where.id, json, where.file, where.root, currentKind(), languageMaps(vscode.extensions.all.map(e => e.packageJSON)));
  } catch {
    return null;   // el tema no se puede leer: iconos de siempre
  }
}

/** El tema de iconos activo y la variante actual (en caché hasta que algo cambie), o null si no hay o no se puede leer. */
export function activeFileIconTheme(): Promise<FileIconTheme | null> {
  const key = `${vscode.workspace.getConfiguration('workbench').get('iconTheme')}|${currentKind()}`;
  if (!cache || cache.key !== key) { cache = { key, theme: load() }; }
  return cache.theme;
}

/** Se dispara cuando cambian el tema de iconos, el tema de color o las extensiones instaladas. */
export const onDidChangeFileIcons = changed.event;

/** Vigila lo que puede cambiar los iconos: olvida lo leído y avisa a quien esté escuchando. Se registra una vez, al activar. */
export function watchFileIcons(): vscode.Disposable {
  const fire = () => { cache = undefined; changed.fire(); };
  return vscode.Disposable.from(
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('workbench.iconTheme')) { fire(); } }),
    vscode.window.onDidChangeActiveColorTheme(fire),
    vscode.extensions.onDidChange(fire),
  );
}

/**
 * Manda el tema de iconos a un webview con el mensaje `iconTheme { theme }` (null: sin iconos
 * del tema): cuando la página lo pide (`sendNow`, al arrancar) y cada vez que cambia.
 */
export class FileIconsFeed implements vscode.Disposable {
  private readonly sub = onDidChangeFileIcons(() => this.sendNow());
  constructor(private readonly post: (msg: { type: 'iconTheme'; theme: FileIconTheme | null }) => unknown) {}
  sendNow() { void activeFileIconTheme().then(theme => this.post({ type: 'iconTheme', theme })); }
  dispose() { this.sub.dispose(); }
}
