/**
 * Lógica pura de la extensión, sin dependencias de VS Code, para poder probarla con
 * `npm test` (node --test) sin abrir VS Code: límites y validación de los ajustes jbGit.*,
 * colores automáticos de las ramas, opciones de Merge y la mezcla de logs de varios repos.
 */

import * as path from 'path';
import { MAIN_COLOR } from './graph';

/** Texto para un atributo del HTML de un webview (entre comillas dobles). */
export function escAttr(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

/** Nonce de la CSP de un webview: los <script> solo se cargan si lo llevan. */
export function nonce(): string {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------

/** En Windows (y macOS por defecto) las rutas no distinguen mayúsculas: «c:\x» = «C:\X». */
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';
const norm = (p: string) => { const n = path.resolve(p); return CASE_INSENSITIVE ? n.toLowerCase() : n; };

/** Misma ruta, aunque una venga de git («C:/x») y otra de VS Code («c:\x»). */
export function samePath(a: string, b: string): boolean {
  return norm(a) === norm(b);
}

/** p está dentro de root (o es root). */
export function pathInside(root: string, p: string): boolean {
  const rel = path.relative(norm(root), norm(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Rutas (relativas a `root`, con «/», sin barra final) de los demás repos de `others` que están
 * dentro de `root`. Para git son carpetas sin seguimiento del repo de fuera (`?? inner/`), pero la
 * extensión ya los muestra como repos propios, con sus cambios bajo su propio nodo.
 */
export function nestedRepos(root: string, others: string[]): string[] {
  return others
    .filter(o => !samePath(o, root) && pathInside(root, o))
    .map(o => path.relative(root, o).split(path.sep).join('/'));
}

/**
 * Ruta relativa de un repo que manda el webview, si es segura: dentro del repo (nada de «..»
 * ni rutas absolutas). Devuelve la ruta absoluta, o undefined si se sale.
 */
export function safeRepoPath(root: string, rel: unknown): string | undefined {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || path.isAbsolute(rel)) { return undefined; }
  const abs = path.resolve(root, rel);
  return pathInside(root, abs) && !samePath(root, abs) ? abs : undefined;
}

/** Lo mínimo de vscode.WorkspaceConfiguration que se usa aquí (así se prueba con un objeto). */
export interface ConfigLike { get<T>(key: string, def: T): T }

/**
 * Commits por página del log (jbGit.maxCommits), entre 100 y MAX_COMMITS_PAGE. Más de 10000 de
 * golpe hace lento git log, el grafo y el mensaje al webview sin aportar nada: para ir más
 * atrás está «Load more commits» o los filtros.
 */
export const MAX_COMMITS_PAGE = 10000;

/**
 * Niveles de subcarpetas en los que se buscan repos (jbGit.repositoryScanMaxDepth), entre 0 y
 * MAX_SCAN_DEPTH. Más niveles recorren medio disco en carpetas grandes y no encuentran nada útil.
 */
export const MAX_SCAN_DEPTH = 5;

export function scanDepth(c: ConfigLike): number {
  const n = Math.round(Number(c.get<number>('repositoryScanMaxDepth', 2)));
  return Number.isFinite(n) ? Math.min(MAX_SCAN_DEPTH, Math.max(0, n)) : 2;
}

export function commitsPerPage(c: ConfigLike): number {
  const n = Math.round(Number(c.get<number>('maxCommits', 1000)));
  return Number.isFinite(n) ? Math.min(MAX_COMMITS_PAGE, Math.max(100, n)) : 1000;
}

/** Opciones de git merge que admite la ventana Merge (Modify options); el mensaje va aparte con -m. */
export const MERGE_OPTIONS = ['--ff-only', '--no-ff', '--squash', '--no-commit', '--no-verify', '--allow-unrelated-histories'];

/**
 * Argumentos de `git merge` a partir de la respuesta de la ventana Merge: solo las opciones
 * conocidas y, si hay mensaje (y no es --ff-only ni --squash, que no crean commit de merge), -m.
 */
export function mergeArgs(options: unknown, message: unknown): string[] {
  const allowed = new Set(MERGE_OPTIONS);
  const args = (Array.isArray(options) ? options : []).filter((o: unknown): o is string => typeof o === 'string' && allowed.has(o));
  const msg = typeof message === 'string' ? message.trim() : '';
  if (msg && !args.includes('--ff-only') && !args.includes('--squash')) { args.push('-m', msg); }
  return args;
}

/** Las ramas principales, por orden de preferencia (como MAIN_BRANCHES de media/main.js). */
export const MAIN_BRANCHES = ['main', 'master'];

/**
 * La rama principal de un repo: la local `main` o, si no, `master`; y si no hay ninguna local, la
 * de su remoto por defecto. El grafo del Log deja su línea en el carril de la izquierda.
 */
export function pickMainRef<R extends { type: string; name: string; remote?: string; branch?: string }>(refs: R[], remote?: string): R | undefined {
  for (const n of MAIN_BRANCHES) {
    const local = refs.find(r => r.type === 'local' && r.name === n);
    if (local) { return local; }
  }
  const nameOf = (r: R) => r.branch ?? r.name.slice(r.name.indexOf('/') + 1);
  for (const n of MAIN_BRANCHES) {
    const remoteRef = refs.find(r => r.type === 'remote' && nameOf(r) === n && (!remote || !r.remote || r.remote === remote));
    if (remoteRef) { return remoteRef; }
  }
  return undefined;
}

/**
 * Color automático de una rama: main y master, MAIN_COLOR (amarillo); las demás, uno de los
 * otros nueve según un hash del nombre (siempre el mismo para el mismo nombre). Las que caerían
 * en el amarillo toman el 0 (azul), así las demás conservan el color que tenían antes.
 * Debe coincidir con autoBranchColor de media/main.js.
 */
export function autoBranchColor(name: string): number {
  if (name === 'main' || name === 'master') { return MAIN_COLOR; }
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) { h = Math.imul(h ^ name.charCodeAt(i), 16777619); }
  const c = 1 + ((h >>> 0) % 9);
  return c === MAIN_COLOR ? 0 : c;
}

/** Colores de carpeta por defecto (jbGit.folderColors) y los nombres de color admitidos. */
export const DEFAULT_FOLDER_COLORS: Record<string, string> = { bugfix: 'red', feature: 'blue', release: 'yellow', hotfix: 'orange', '@remote': 'foreground' };
export const FOLDER_COLOR_TOKENS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'foreground', 'gray-light', 'gray', 'gray-dark'];

/** Familia válida: lista CSS de fuentes, sin nada que pueda cerrar la declaración. */
export const validFontFamily = (v: unknown) => typeof v === 'string' && v.length <= 200 && !/[;{}<>\\]/.test(v);
export const validFontSize = (v: unknown) => Number.isInteger(v) && ((v as number) === 0 || ((v as number) >= 8 && (v as number) <= 32));

/**
 * Validación de los ajustes que guarda la pestaña Settings (setSetting): cada clave conocida
 * devuelve el valor normalizado, o undefined si no es válido (y entonces no se guarda nada).
 */
export const SETTING_VALIDATORS: Record<string, (v: any) => any> = {
  dateFormat: v => (v === 'relative' || v === 'absolute' ? v : undefined),
  maxCommits: v => (Number.isInteger(v) && v >= 100 && v <= MAX_COMMITS_PAGE ? v : undefined),
  repositoryScanMaxDepth: v => (Number.isInteger(v) && v >= 0 && v <= MAX_SCAN_DEPTH ? v : undefined),
  autoStage: v => (typeof v === 'boolean' ? v : undefined),
  protectedBranches: v => (Array.isArray(v) && v.every(x => typeof x === 'string')
    ? [...new Set(v.map((x: string) => x.trim()).filter(Boolean))] : undefined),
  folderColors: v => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) { return undefined; }
    const out: Record<string, string> = {};
    for (const [k, c] of Object.entries(v)) {
      const name = k.trim().toLowerCase();
      if (name && name.length <= 60 && typeof c === 'string' && (FOLDER_COLOR_TOKENS.includes(c) || /^#[0-9a-f]{6}$/i.test(c))) { out[name] = c; }
    }
    return out;
  },
  // Atajos: «vista.acción» → combinación («Ctrl+Shift+C», «Delete», «F2»…) o '' para quitar uno por defecto
  shortcuts: v => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) { return undefined; }
    const out: Record<string, string> = {};
    for (const [k, c] of Object.entries(v).slice(0, 300)) {
      // La tecla puede ser el propio «+» («Ctrl++», como lo graba eventKey en main.js)
      if (/^[a-zA-Z]+\.[a-zA-Z]+$/.test(k) && typeof c === 'string' && (c === '' || /^((Ctrl|Alt|Shift)\+){0,3}([^+\s]{1,12}|\+)$/.test(c))) { out[k] = c; }
    }
    return out;
  },
  fontFamily: v => (validFontFamily(v) ? String(v).trim() : undefined),
  fontSize: v => (validFontSize(v) ? v : undefined),
  tagColor: v => (typeof v === 'string' && (FOLDER_COLOR_TOKENS.includes(v) || /^#[0-9a-f]{6}$/i.test(v)) ? v : undefined),
  branchColors: v => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) { return undefined; }
    const out: Record<string, string> = {};
    for (const [k, c] of Object.entries(v)) {
      const name = k.trim();
      if (name && name.length <= 250 && typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)) { out[name] = c.toLowerCase(); }
    }
    return out;
  },
};

/** Valor normalizado de un ajuste, o undefined si la clave no se conoce o el valor no vale. */
export function validateSetting(key: string, value: unknown): unknown {
  return Object.prototype.hasOwnProperty.call(SETTING_VALIDATORS, key) ? SETTING_VALIDATORS[key](value) : undefined;
}

/**
 * Junta los logs de varios repos por fecha sin cambiar nunca el orden de git dentro de cada
 * repo (así un hijo no puede quedar debajo de su padre aunque las fechas estén desordenadas,
 * p. ej. tras un rebase): en cada paso toma, de entre el siguiente commit de cada repo, el más
 * nuevo (fecha del commit, ctime, o time si no la hay; a igual fecha, el repo de menor índice).
 * Si un repo llegó al límite, se para al bajar de la fecha de su último commit: podrían faltar
 * commits suyos entre medias, y «Load more» los traerá.
 */
export function mergeLogs<R extends { idx: number }, C extends { time: number; ctime?: number }>(perRepo: { repo: R; commits: C[]; limited: boolean }[], max: number) {
  const total = perRepo.reduce((s, p) => s + p.commits.length, 0);
  if (perRepo.length <= 1) {
    return { commits: perRepo.flatMap(p => p.commits.map(c => ({ repo: p.repo, c }))), hasMore: perRepo.some(p => p.limited) };
  }
  const when = (c: C) => c.ctime ?? c.time;
  const cutoff = Math.max(-Infinity, ...perRepo.filter(p => p.limited && p.commits.length).map(p => when(p.commits[p.commits.length - 1])));
  const at = perRepo.map(() => 0);
  const kept: { repo: R; c: C }[] = [];
  while (kept.length < max) {
    let best = -1;
    for (let k = 0; k < perRepo.length; k++) {
      const c = perRepo[k].commits[at[k]];
      if (!c) { continue; }
      if (best < 0) { best = k; continue; }
      const b = perRepo[best].commits[at[best]];
      if (when(c) > when(b) || (when(c) === when(b) && perRepo[k].repo.idx < perRepo[best].repo.idx)) { best = k; }
    }
    if (best < 0) { break; }
    const c = perRepo[best].commits[at[best]];
    if (when(c) < cutoff) { break; }
    kept.push({ repo: perRepo[best].repo, c });
    at[best]++;
  }
  return { commits: kept, hasMore: perRepo.some(p => p.limited) || kept.length < total };
}

/**
 * Cola de ejecución en serie: cada tarea empieza cuando acaba la anterior, también si esa
 * falló (su error solo le llega a quien la pidió). La extensión la usa para las escrituras
 * al índice (auto-stage y acciones del usuario), que no pueden solaparse.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/**
 * Numera las ejecuciones de algo asíncrono para quedarse solo con la última: cada una pide
 * su número con `begin()` y, tras cada espera, comprueba con `stale(n)` si ha empezado otra.
 */
export class Generation {
  private n = 0;
  begin(): number { return ++this.n; }
  stale(gen: number): boolean { return gen !== this.n; }
}

/** Qué vigila cada watcher de un repo: carpeta base, patrón y qué refresca. */
export interface WatchSpec { dir: string; pattern: string; kind: 'refs' | 'index' | 'tree' }

/**
 * Watchers de un repo a partir de sus directorios de git (`gitDirs`): lo propio del worktree
 * (HEAD, operaciones a medias) y lo compartido (ramas, tags, stash) pueden estar en carpetas
 * distintas, y el índice es el del worktree. El árbol de trabajo se vigila entero desde la raíz.
 */
export function watchSpecs(root: string, dirs: { dir: string; common: string }): WatchSpec[] {
  return [
    { dir: dirs.dir, pattern: '{HEAD,FETCH_HEAD,MERGE_HEAD,CHERRY_PICK_HEAD,REVERT_HEAD,rebase-merge/**,rebase-apply/**}', kind: 'refs' },
    { dir: dirs.common, pattern: '{packed-refs,refs/**,logs/refs/stash}', kind: 'refs' },
    { dir: dirs.dir, pattern: 'index', kind: 'index' },
    { dir: root, pattern: '**/*', kind: 'tree' },
  ];
}
