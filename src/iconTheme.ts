/**
 * Temas de iconos de archivos de VS Code (`workbench.iconTheme`): lectura del JSON del tema y de
 * sus iconos para mandárselos a los webviews (sin `vscode`, para poder probarlo).
 *
 * Un tema asocia iconos (SVG/PNG o un carácter de una fuente) a archivos y carpetas por nombre,
 * por extensión y por lenguaje, con variantes para temas claros y de alto contraste. Aquí se
 * aplica la variante que toca, se leen solo los iconos que de verdad se usan y se convierten a
 * `data:` URI: así el webview no necesita permiso para leer la carpeta de la extensión del tema.
 * La búsqueda del icono de cada archivo la hace media/fileicons.js.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import { pathInside } from './core';

/** Una definición del tema: una imagen (`iconPath`) o un carácter de una fuente. */
export interface IconDef { iconPath?: string; fontCharacter?: string; fontColor?: string; fontSize?: string; fontId?: string }

type Names = Record<string, string>;

/** Lo que el JSON de un tema asocia a archivos y carpetas (también en sus secciones `light` y `highContrast`). */
interface Associations {
  file?: string; folder?: string; folderExpanded?: string;
  fileNames?: Names; fileExtensions?: Names; folderNames?: Names; folderNamesExpanded?: Names; languageIds?: Names;
}

export interface ThemeJson extends Associations {
  iconDefinitions?: Record<string, IconDef>;
  fonts?: { id?: string; src?: { path: string; format?: string }[]; weight?: string; style?: string; size?: string }[];
  light?: Associations;
  highContrast?: Associations;
}

/** Variante de color con la que se muestra el tema. */
export type IconThemeKind = 'dark' | 'light' | 'highContrast';

/** Lo que recibe el webview: las asociaciones ya resueltas para la variante y los iconos como `data:` URI. */
export interface FileIconTheme {
  id: string;
  defs: Record<string, { src?: string; glyph?: { font: string; ch: string; color?: string; size?: string } }>;
  fonts: { id: string; src: string; weight?: string; style?: string }[];
  file?: string; folder?: string; folderExpanded?: string;
  fileNames: Names; fileExtensions: Names; folderNames: Names; folderNamesExpanded: Names; languageIds: Names;
  /** Lenguaje de cada extensión («ts» → «typescript») y de cada nombre de archivo, para `languageIds`. */
  langByExt: Names; langByName: Names;
}

/** Como mucho, tantos bytes de iconos por tema (un tema enorme no debe llenar el webview). */
export const ICON_BUDGET = 8 * 1024 * 1024;

const MIME: Record<string, string> = {
  '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
};

const dataUri = (file: string, buf: Buffer): string | undefined => {
  const mime = MIME[path.extname(file).toLowerCase()];
  return mime ? `data:${mime};base64,${buf.toString('base64')}` : undefined;
};

/** Claves en minúsculas: los nombres y extensiones de archivo se comparan sin distinguir mayúsculas. */
const lowerKeys = (m: Names | undefined): Names => {
  const out: Names = {};
  for (const [k, v] of Object.entries(m ?? {})) { if (typeof v === 'string') { out[k.toLowerCase()] = v; } }
  return out;
};

/**
 * El JSON de un tema: VS Code admite comentarios (de línea y de bloque) y comas finales, así que
 * si no se puede leer tal cual se prueba sin ellos. undefined si no es un objeto JSON.
 */
export function parseThemeJson(text: string): ThemeJson | undefined {
  const asObject = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v as ThemeJson : undefined);
  const s = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;   // sin la marca de orden de bytes (BOM)
  try { return asObject(JSON.parse(s)); } catch { /* con comentarios */ }
  let out = '', i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') {                       // una cadena: se copia entera (sus «//» no son comentarios)
      let j = i + 1;
      while (j < s.length && s[j] !== '"') { j += s[j] === '\\' ? 2 : 1; }
      out += s.slice(i, j + 1); i = j + 1;
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') { i++; }
    } else if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end < 0 ? s.length : end + 2;
    } else { out += c; i++; }
  }
  try { return asObject(JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))); } catch { return undefined; }
}

/** «\E001» (la forma que usan los temas) o el propio carácter → el carácter. */
export function parseGlyph(s: string): string {
  const m = /^\\([0-9a-fA-F]{1,6})$/.exec(s);
  if (!m) { return s; }
  const cp = parseInt(m[1], 16);
  return cp <= 0x10ffff ? String.fromCodePoint(cp) : s;
}

/** Une las asociaciones de la variante (light, highContrast) a las base: los nombres se suman y los iconos por defecto se reemplazan. */
function merged(json: ThemeJson, kind: IconThemeKind): Required<Pick<Associations, 'fileNames' | 'fileExtensions' | 'folderNames' | 'folderNamesExpanded' | 'languageIds'>> & Pick<Associations, 'file' | 'folder' | 'folderExpanded'> {
  const over = kind === 'light' ? json.light : kind === 'highContrast' ? json.highContrast : undefined;
  const pick = (k: 'fileNames' | 'fileExtensions' | 'folderNames' | 'folderNamesExpanded') => ({ ...lowerKeys(json[k]), ...lowerKeys(over?.[k]) });
  return {
    file: over?.file ?? json.file, folder: over?.folder ?? json.folder, folderExpanded: over?.folderExpanded ?? json.folderExpanded,
    fileNames: pick('fileNames'), fileExtensions: pick('fileExtensions'), folderNames: pick('folderNames'), folderNamesExpanded: pick('folderNamesExpanded'),
    languageIds: { ...(json.languageIds ?? {}), ...(over?.languageIds ?? {}) },
  };
}

/**
 * Construye lo que el webview necesita de un tema: `themeFile` es su JSON y `root` la carpeta de su
 * extensión (de la que no se sale al leer iconos). `langs` dice el lenguaje de cada extensión y
 * nombre de archivo (solo hace falta si el tema usa `languageIds`).
 */
export async function buildFileIconTheme(
  id: string, json: ThemeJson, themeFile: string, root: string, kind: IconThemeKind,
  langs: { byExt: Names; byName: Names } = { byExt: {}, byName: {} },
): Promise<FileIconTheme> {
  const a = merged(json, kind);
  const dir = path.dirname(themeFile);
  const theme: FileIconTheme = {
    id, defs: {}, fonts: [], file: a.file, folder: a.folder, folderExpanded: a.folderExpanded,
    fileNames: a.fileNames, fileExtensions: a.fileExtensions, folderNames: a.folderNames, folderNamesExpanded: a.folderNamesExpanded,
    languageIds: a.languageIds, langByExt: {}, langByName: {},
  };
  let budget = ICON_BUDGET;
  const read = async (rel: string): Promise<Buffer | undefined> => {
    const abs = path.resolve(dir, rel);
    if (!pathInside(root, abs)) { return undefined; }
    try {
      const buf = await fs.readFile(abs);
      if (buf.length > budget) { return undefined; }
      budget -= buf.length;
      return buf;
    } catch { return undefined; }
  };

  // Solo los iconos que alguna asociación usa
  const used = new Set<string>();
  for (const v of [a.file, a.folder, a.folderExpanded]) { if (v) { used.add(v); } }
  for (const m of [a.fileNames, a.fileExtensions, a.folderNames, a.folderNamesExpanded, a.languageIds]) { for (const v of Object.values(m)) { used.add(v); } }

  // Fuentes: el primer origen que se pueda leer de cada una (y el tamaño por defecto de sus iconos)
  const fontIds = new Set<string>();
  const fontSize = new Map<string, string | undefined>();
  for (const f of json.fonts ?? []) {
    if (!f.id || !Array.isArray(f.src)) { continue; }
    for (const s of f.src) {
      const buf = typeof s?.path === 'string' ? await read(s.path) : undefined;
      const src = buf && dataUri(s.path, buf);
      if (src) { theme.fonts.push({ id: f.id, src, weight: f.weight, style: f.style }); fontIds.add(f.id); fontSize.set(f.id, f.size); break; }
    }
  }

  const defs = json.iconDefinitions ?? {};
  const first = json.fonts?.find(f => f.id && fontIds.has(f.id))?.id;
  const cache = new Map<string, string | undefined>();   // varios iconos pueden compartir archivo
  for (const key of used) {
    const d = defs[key];
    if (!d) { continue; }
    if (d.iconPath) {
      if (!cache.has(d.iconPath)) {
        const buf = await read(d.iconPath);
        cache.set(d.iconPath, buf && dataUri(d.iconPath, buf));
      }
      const src = cache.get(d.iconPath);
      if (src) { theme.defs[key] = { src }; }
    } else if (d.fontCharacter) {
      const font = d.fontId ?? first;
      if (font && fontIds.has(font)) { theme.defs[key] = { glyph: { font, ch: parseGlyph(d.fontCharacter), color: d.fontColor, size: d.fontSize ?? fontSize.get(font) } }; }
    }
  }

  // Lenguaje de cada extensión y nombre (solo si el tema asocia iconos a lenguajes)
  if (Object.keys(a.languageIds).length) {
    for (const [k, v] of Object.entries(langs.byExt)) { if (a.languageIds[v]) { theme.langByExt[k] = v; } }
    for (const [k, v] of Object.entries(langs.byName)) { if (a.languageIds[v]) { theme.langByName[k] = v; } }
  }
  return theme;
}

/** Del `contributes.languages` de las extensiones: lenguaje de cada extensión de archivo y de cada nombre. */
export function languageMaps(packages: { contributes?: { languages?: { id?: string; extensions?: string[]; filenames?: string[] }[] } }[]): { byExt: Names; byName: Names } {
  const byExt: Names = {}, byName: Names = {};
  for (const p of packages) {
    for (const l of p?.contributes?.languages ?? []) {
      if (!l || typeof l.id !== 'string') { continue; }
      for (const e of l.extensions ?? []) { if (typeof e === 'string' && e.startsWith('.')) { byExt[e.slice(1).toLowerCase()] ??= l.id; } }
      for (const f of l.filenames ?? []) { if (typeof f === 'string') { byName[f.toLowerCase()] ??= l.id; } }
    }
  }
  return { byExt, byName };
}
