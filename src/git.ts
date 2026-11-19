import { execFile } from 'child_process';
import { promises as fs, Dirent } from 'fs';
import * as path from 'path';

const FS = '\x1f'; // separador de campos

export type RefType = 'local' | 'remote' | 'tag';

export interface Ref {
  full: string;      // refs/heads/main
  name: string;      // main, origin/main, v1.0
  hash: string;      // commit al que apunta
  type: RefType;
  upstream?: string; // origin/main
  ahead?: number;
  behind?: number;
  remote?: string;   // solo ramas remotas: origin
  branch?: string;   // solo ramas remotas: main
}

/**
 * Operación a medias (rebase, merge, cherry-pick o revert parados, normalmente por
 * conflictos). ours / theirs: nombres legibles de cada lado, para los botones y menús
 * («Accept Yours ('main')»). En un rebase, ours es la rama sobre la que se rebasa y
 * theirs la rama que se está rebasando, igual que lo entiende git.
 */
export interface RepoOperation {
  kind: 'rebase' | 'merge' | 'cherry-pick' | 'revert';
  ours: string;
  theirs: string;
  step?: number;
  total?: number;
}

/** Filtros del log (además de la rama): autores, rango de fechas y rutas. */
export interface LogFilters {
  authors: string[];
  since?: string;    // lo que entiende git: «7 days ago», «2026-01-31»…
  until?: string;
  dateLabel?: string;
  paths: string[];   // en la extensión, absolutas; al llamar a getLog, relativas a la raíz del repo
  roots: string[];   // repos marcados en el filtro Paths (raíces absolutas); vacío = todos
  firstParent?: boolean;  // «Show Only First Parent» del ojo del Log (git log --first-parent)
}
export const EMPTY_FILTERS: LogFilters = { authors: [], paths: [], roots: [] };

export interface LogCommit {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  time: number;      // fecha de autor, segundos epoch (la que se muestra)
  ctime: number;     // fecha del commit: la que ordena el log (tras un rebase puede ser posterior a time)
  subject: string;
}

export interface FileChange {
  status: string;    // A M D R C T
  path: string;
  oldPath?: string;
}

/** Un commit del historial de un archivo o carpeta (Show History). */
export interface HistoryEntry {
  sha: string;
  parent: string | null;   // primer padre (null en el commit raíz)
  author: string;
  time: number;
  subject: string;
  status: string;          // del archivo en ese commit (A M D R…); vacío en una carpeta
  path: string;            // ruta del archivo en ese commit (en una carpeta, la carpeta)
  oldPath?: string;        // ruta anterior si se renombró en ese commit
}

export interface CommitDetails {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  time: number;
  committer: string;
  committerEmail: string;
  commitTime: number;
  message: string;
  files: FileChange[];
}

export interface StashEntry {
  ref: string;       // stash@{0} (cambia al borrar otros stashes)
  hash: string;      // commit del stash (estable)
  message: string;
  branch: string;    // rama en la que se creó
  time: number;
}

export interface StashFile extends FileChange {
  untracked?: boolean; // guardado con --include-untracked (vive en el tercer padre)
}

/** Grupo de un cambio local, como los de la pestaña Local Changes. */
export type ChangeGroup = 'conflicts' | 'staged' | 'unstaged' | 'untracked';

export interface LocalChange {
  group: ChangeGroup;
  status: string;    // letra de estado dentro de su grupo: A M D R C T U ?
  path: string;
  oldPath?: string;  // solo renombrados en el índice
}

/** Combinaciones XY de `git status` que indican un conflicto sin resolver. */
const CONFLICT_XY = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

export class Git {
  constructor(public readonly root: string) {}

  /**
   * Nombres de los tags que hay en el remoto (`git ls-remote --tags --refs`). Va por red, así
   * que tiene un tiempo máximo para no quedarse colgado si pide credenciales o no hay conexión.
   */
  async getRemoteTags(remote: string): Promise<Set<string>> {
    const out = await this.run(['ls-remote', '--tags', '--refs', remote], undefined, 20000);
    const names = new Set<string>();
    for (const line of out.split('\n')) {
      const m = /\trefs\/tags\/(.+)$/.exec(line.trim());
      if (m) { names.add(m[1]); }
    }
    return names;
  }

  /**
   * Diff de dos archivos cualesquiera (`git diff --no-index -U0`), para el visor de merge.
   * git devuelve 1 cuando hay diferencias: eso no es un error. Pero también devuelve 1 si no
   * puede leer un archivo («error: Could not access…»): eso sí lo es.
   */
  diffFiles(a: string, b: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('git', ['diff', '--no-index', '--no-color', '--no-ext-diff', '-U0', '--', a, b],
        { cwd: this.root, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout, stderr) => {
          const failed = err && ((err as any).code !== 1 || /^(error|fatal):/m.test(stderr));
          if (failed) { reject(new Error((stderr || err!.message).trim())); } else { resolve(stdout); }
        });
    });
  }

  /** input: texto que se pasa por stdin (p. ej. un parche para `git apply`). */
  run(args: string[], input?: string, timeout = 0): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        'git',
        args,
        { cwd: this.root, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8', timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error((stderr || err.message).trim()));
          } else {
            resolve(stdout);
          }
        }
      );
      if (input !== undefined) { child.stdin?.end(input); }
    });
  }

  async getStatus(): Promise<LocalChange[]> {
    // --no-optional-locks: status no reescribe el índice, así el watcher de .git/index no entra en bucle
    return parseStatusZ(await this.run(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all']));
  }

  async getStashes(): Promise<StashEntry[]> {
    const out = await this.run(['stash', 'list', `--format=%gd${FS}%H${FS}%gs${FS}%ct`]);
    return out.split('\n').filter(Boolean).map(line => {
      const [ref, hash, subject, ct] = line.split(FS);
      // "On main: mensaje" o "WIP on main: abc1234 último commit"
      const m = /^(WIP )?[Oo]n ([^:]+): (.*)$/.exec(subject);
      const message = !m ? subject : m[1] ? `WIP: ${m[3]}` : m[3];
      return { ref, hash, message, branch: m ? m[2] : '', time: Number(ct) };
    });
  }

  /** Archivos de un stash: cambios respecto a su base y, si los hay, archivos sin seguimiento. */
  async getStashFiles(hash: string): Promise<StashFile[]> {
    const files: StashFile[] = await this.diffNameStatus(`${hash}^1`, hash);
    try {
      const out = await this.run(['ls-tree', '-r', '--name-only', '-z', `${hash}^3`]);
      for (const p of out.split('\0').filter(Boolean)) { files.push({ status: 'A', path: p, untracked: true }); }
    } catch {
      // stash sin archivos sin seguimiento: no tiene tercer padre
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Mensaje completo del último commit ('' si el repo aún no tiene commits). */
  async getLastMessage(): Promise<string> {
    try {
      return (await this.run(['log', '-1', '--format=%B'])).trim();
    } catch {
      return '';
    }
  }

  /**
   * Raíz del repo que contiene dir, como ruta nativa: git da «C:/Users/…» en Windows y VS Code
   * compara con fsPath («c:\Users\…»; para comparar, samePath / pathInside de core.ts).
   */
  static async findRoot(dir: string): Promise<string | undefined> {
    try {
      const out = (await new Git(dir).run(['rev-parse', '--show-toplevel'])).trim();
      return out ? path.normalize(out) : undefined;
    } catch {
      return undefined;
    }
  }

  async getRemotes(): Promise<string[]> {
    const out = await this.run(['remote']);
    return out.split('\n').map(s => s.trim()).filter(Boolean);
  }

  /**
   * Directorios de git del repo: `dir` (el suyo: HEAD, index, MERGE_HEAD, rebase-*…) y `common`
   * (el compartido: refs, packed-refs, logs). Son el mismo en un repo normal; en un worktree
   * `.git` es un archivo y `dir` cuelga de `common/worktrees/`, y en un submódulo de `.git/modules/`.
   */
  async gitDirs(): Promise<{ dir: string; common: string }> {
    const out = (await this.run(['rev-parse', '--absolute-git-dir', '--git-common-dir'])).split('\n').map(s => s.trim());
    const dir = path.resolve(this.root, out[0] || '.git');
    return { dir, common: out[1] ? path.resolve(this.root, out[1]) : dir };
  }

  /** Ruta absoluta de un archivo dentro del directorio de git (vale también en worktrees y submódulos). */
  private async gitPath(p: string): Promise<string> {
    return path.resolve(this.root, (await this.run(['rev-parse', '--git-path', p])).trim());
  }

  /** Nombre legible de un commit: una rama que apunte a él o, si no, su hash corto. */
  private async refName(hash: string): Promise<string> {
    hash = hash.trim();
    if (!hash) { return ''; }
    const names = (await this.run(['for-each-ref', '--points-at', hash, '--format=%(refname:short)', 'refs/heads', 'refs/remotes']).catch(() => ''))
      .split('\n').map(s => s.trim()).filter(Boolean);
    return names.find(n => !n.includes('/')) ?? names[0] ?? hash.slice(0, 8);
  }

  /** Rebase, merge, cherry-pick o revert que se ha quedado a medias (null si no hay ninguno). */
  async getOperation(): Promise<RepoOperation | null> {
    const read = async (p: string) => (await fs.readFile(await this.gitPath(p), 'utf8').catch(() => '')).trim();
    const branch = (await this.getHead().catch(() => ({ branch: '', hash: '' }))).branch || 'HEAD';
    for (const dir of ['rebase-merge', 'rebase-apply']) {
      const headName = await read(`${dir}/head-name`);
      if (!headName) { continue; }
      const onto = await read(`${dir}/onto`);
      const step = Number(await read(dir === 'rebase-merge' ? `${dir}/msgnum` : `${dir}/next`)) || undefined;
      const total = Number(await read(dir === 'rebase-merge' ? `${dir}/end` : `${dir}/last`)) || undefined;
      return { kind: 'rebase', ours: await this.refName(onto), theirs: headName.replace(/^refs\/heads\//, ''), step, total };
    }
    const mergeHead = (await read('MERGE_HEAD')).split('\n')[0];
    if (mergeHead) {
      // El mensaje que prepara git dice qué se mergea («Merge branch 'x'», «… remote-tracking branch 'origin/x'»)
      const msg = await read('MERGE_MSG');
      // («Merge tag 'v1'» al mergear un tag)
      const m = /^Merge (?:remote-tracking branch|branch(?:es)?|tag) '([^']+)'/.exec(msg);
      return { kind: 'merge', ours: branch, theirs: m ? m[1] : await this.refName(mergeHead) };
    }
    for (const [file, kind] of [['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']] as const) {
      const h = await read(file);
      if (!h) { continue; }
      const subject = (await this.run(['log', '-1', '--format=%h %s', h]).catch(() => h.slice(0, 8))).trim();
      return { kind, ours: branch, theirs: subject };
    }
    return null;
  }

  /** Hash de HEAD y nombre de la rama actual ('' si HEAD está separado). */
  async getHead(): Promise<{ hash: string; branch: string }> {
    let hash = '';
    let branch = '';
    try { hash = (await this.run(['rev-parse', 'HEAD'])).trim(); } catch { /* repo vacío */ }
    try { branch = (await this.run(['symbolic-ref', '--short', '-q', 'HEAD'])).trim(); } catch { /* detached */ }
    return { hash, branch };
  }

  async getRefs(remotes: string[]): Promise<Ref[]> {
    // El nombre sale de refname quitando el prefijo: %(refname:short) es ambiguo si una rama y
    // un tag se llaman igual («heads/x» / «tags/x») o con una rama local «origin/main»
    const fmt = ['%(refname)', '%(objectname)', '%(*objectname)', '%(upstream:short)', '%(upstream:track)']
      .join('%1f');
    const out = await this.run(['for-each-ref', `--format=${fmt}`, 'refs/heads', 'refs/remotes', 'refs/tags']);
    const refs: Ref[] = [];
    for (const line of out.split('\n')) {
      if (!line) { continue; }
      const [full, obj, peeled, upstream, track] = line.split(FS);
      if (full.startsWith('refs/remotes/') && full.endsWith('/HEAD')) { continue; }
      const type: RefType = full.startsWith('refs/heads/') ? 'local' : full.startsWith('refs/remotes/') ? 'remote' : 'tag';
      const name = full.slice(type === 'local' ? 11 : type === 'remote' ? 13 : 10);
      const ref: Ref = { full, name, hash: peeled || obj, type };
      if (type === 'local' && upstream) {
        ref.upstream = upstream;
        const a = /ahead (\d+)/.exec(track);
        const b = /behind (\d+)/.exec(track);
        if (a) { ref.ahead = Number(a[1]); }
        if (b) { ref.behind = Number(b[1]); }
      }
      if (type === 'remote') {
        const split = splitRemoteRef(name, remotes);
        ref.remote = split.remote;
        ref.branch = split.branch;
      }
      refs.push(ref);
    }
    return refs;
  }

  /** Log en orden de fecha; con ref filtra a esa rama, sin ref muestra todo. */
  async getLog(ref: string | null, max: number, filters: LogFilters = EMPTY_FILTERS): Promise<LogCommit[]> {
    // Campos y commits separados por NUL (-z): es lo único que no puede ir en un mensaje (\x1f y
    // \x1e sí). time es la fecha de autor (la que se muestra); ctime, la del commit, con la que
    // git ordena (--date-order) y con la que mergeLogs junta varios repos
    const args = ['log', '-z', '--date-order', `--max-count=${max}`, `--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%ct%x00%s`];
    // Autores como texto literal (-F) y unidos con «o»: --author=A --author=B
    if (filters.authors.length) { args.push('-F', ...filters.authors.map(a => `--author=${a}`)); }
    if (filters.since) { args.push(`--since=${filters.since}`); }
    if (filters.until) { args.push(`--until=${filters.until}`); }
    if (filters.firstParent) { args.push('--first-parent'); }
    if (ref) {
      args.push(ref);
    } else {
      args.push('--exclude=refs/stash', '--all');
    }
    args.push('--', ...filters.paths);
    let out: string;
    try {
      out = await this.run(args);
    } catch (e: any) {
      // Rama inexistente (p. ej. recién borrada) o repo sin commits: log vacío
      if (/does not have any commits|bad default revision|unknown revision|bad revision/i.test(e.message)) { return []; }
      throw e;
    }
    const commits: LogCommit[] = [];
    for (const [hash, parents, author, email, time, ctime, subject] of nulRecords(out, 7)) {
      commits.push({
        hash,
        // Con --first-parent, %P sigue dando todos los padres: el grafo solo debe ver el primero
        parents: parents ? (filters.firstParent ? parents.split(' ').slice(0, 1) : parents.split(' ')) : [],
        author,
        email,
        time: Number(time),
        ctime: Number(ctime),
        subject,
      });
    }
    return commits;
  }

  async getCommitDetails(hash: string): Promise<CommitDetails> {
    const fmt = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%B'].join('%x1f');
    const out = await this.run(['show', '-s', `--format=${fmt}`, hash]);
    const [h, parents, author, email, time, committer, committerEmail, commitTime, ...msg] = out.split(FS);
    const parentList = parents ? parents.split(' ') : [];
    const files = await this.getChangedFiles(parentList[0] ?? null, h);
    return {
      hash: h,
      parents: parentList,
      author,
      email,
      time: Number(time),
      committer,
      committerEmail,
      commitTime: Number(commitTime),
      message: msg.join(FS).replace(/\s+$/, ''),
      files,
    };
  }

  /** Archivos cambiados entre parent y hash (o desde la raíz si no hay parent). */
  async getChangedFiles(parent: string | null, hash: string): Promise<FileChange[]> {
    const args = parent
      ? ['diff-tree', '-r', '-M', '--no-commit-id', '--name-status', '-z', parent, hash]
      : ['diff-tree', '-r', '-M', '--root', '--no-commit-id', '--name-status', '-z', hash];
    return parseNameStatusZ(await this.run(args));
  }

  /** Diferencias entre una ref y otra, o con el árbol de trabajo si right es undefined. */
  async diffNameStatus(left: string, right?: string, paths: string[] = []): Promise<FileChange[]> {
    const args = ['diff', '-M', '--name-status', '-z', left];
    if (right) { args.push(right); }
    args.push('--', ...paths);
    return parseNameStatusZ(await this.run(args));
  }

  /**
   * Historial de un archivo o carpeta (Show History, como JetBrains), del más nuevo al más
   * antiguo, desde rev (HEAD si no se da). En un archivo se siguen los renombrados
   * (--follow) y cada commit lleva la ruta que tenía entonces (path / oldPath). Con --follow git
   * nunca da los merges, así que se piden aparte (los que cambian el archivo respecto a todos
   * sus padres, en cualquiera de sus rutas) y se intercalan por fecha: no traen name-status y
   * se quedan con la ruta del commit más nuevo, con estado M. Todo va con -z: rutas sin
   * comillas ni escapes, y mensajes con cualquier carácter.
   */
  async getHistory(target: string, folder: boolean, rev?: string, max = 2000): Promise<HistoryEntry[]> {
    const FMT = '--format=%H%x00%P%x00%an%x00%ct%x00%s';
    const entry = ([sha, parents, author, ct, subject]: string[]): HistoryEntry =>
      ({ sha, parent: parents ? parents.split(' ')[0] : null, author, time: Number(ct), subject, status: '', path: target });
    const revArgs = rev ? [rev] : [];

    if (folder) {
      return nulRecords(await this.run(['log', '-z', `-n${max}`, FMT, ...revArgs, '--', target]), 5).map(entry);
    }

    // Commits normales, siguiendo los renombrados. Tras los 5 campos va el name-status: «\nM»,
    // ruta (o «\nR100», origen, destino) y enseguida el commit siguiente
    const out = await this.run(['log', '-z', `-n${max}`, FMT, '--follow', '-M', '--name-status', ...revArgs, '--', target]);
    const tok = out.split('\0');
    const list: HistoryEntry[] = [];
    let i = 0;
    while (i + 5 <= tok.length && /^[0-9a-f]{7,}$/.test(tok[i])) {
      const e = entry(tok.slice(i, i + 5));
      e.status = 'M';
      i += 5;
      const st = /^\n?([A-Z])\d*$/.exec(tok[i] ?? '');
      if (st) {
        e.status = st[1];
        if (st[1] === 'R' || st[1] === 'C') { e.oldPath = tok[i + 1]; e.path = tok[i + 2]; i += 3; } else { e.path = tok[i + 1]; i += 2; }
      }
      list.push(e);
    }

    // Merges que cambian el archivo en cualquiera de sus rutas (la simplificación por defecto de
    // git omite los que lo dejan igual que uno de sus padres)
    const paths = [...new Set(list.flatMap(e => (e.oldPath ? [e.path, e.oldPath] : [e.path])))];
    if (!paths.length) { return list; }
    const merges = nulRecords(await this.run(['log', '-z', `-n${max}`, '--min-parents=2', FMT, ...revArgs, '--', ...paths]), 5)
      .map(entry).filter(m => !list.some(e => e.sha === m.sha));
    if (!merges.length) { return list; }

    // Se intercalan por fecha (a igual fecha, el merge antes: es hijo de los demás) y toman la
    // ruta del commit más nuevo que tengan encima
    const all: HistoryEntry[] = [];
    let mi = 0;
    for (const e of list) {
      while (mi < merges.length && merges[mi].time >= e.time) { all.push(merges[mi++]); }
      all.push(e);
    }
    all.push(...merges.slice(mi));
    let cur = target;
    for (const e of all) {
      if (!e.status) { e.status = 'M'; e.path = cur; } else { cur = e.oldPath ?? e.path; }
    }
    return all.slice(0, max);
  }
}

/**
 * Registros de un `git log -z` con `n` campos separados por %x00: los commits también van
 * separados por NUL, así que se cortan cada n campos (y sobra el NUL final, si lo hay).
 */
function nulRecords(out: string, n: number): string[][] {
  if (!out) { return []; }
  const t = out.split('\0');
  if (t.length % n === 1 && t[t.length - 1] === '') { t.pop(); }
  const recs: string[][] = [];
  for (let i = 0; i + n <= t.length; i += n) { recs.push(t.slice(i, i + n)); }
  return recs;
}

/**
 * Parsea `git status --porcelain=v1 -z`. Un archivo puede salir dos veces: en
 * staged (columna X, índice) y en unstaged (columna Y, árbol de trabajo).
 */
export function parseStatusZ(out: string): LocalChange[] {
  const parts = out.split('\0');
  const changes: LocalChange[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) { continue; }
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    const x = xy[0], y = xy[1];
    let oldPath: string | undefined;
    // Con -z el origen de un renombrado o copia va en la entrada siguiente, sea en el índice
    // (X) o en el árbol de trabajo (Y: « R» con un archivo añadido con `git add -N`)
    if (x === 'R' || x === 'C') { oldPath = parts[++i]; } else if (y === 'R' || y === 'C') { i++; }
    if (xy === '??') { changes.push({ group: 'untracked', status: '?', path }); continue; }
    if (xy === '!!') { continue; }
    if (CONFLICT_XY.has(xy)) { changes.push({ group: 'conflicts', status: 'U', path }); continue; }
    if (x !== ' ') { changes.push({ group: 'staged', status: x, path, oldPath }); }
    if (y !== ' ') { changes.push({ group: 'unstaged', status: y, path }); }
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Bloques de cambio dentro de un diff unificado (rollback de un solo bloque)
// ---------------------------------------------------------------------------

interface DiffEntry {
  t: ' ' | '+' | '-';
  text: string;
  nAt: number;          // número de línea en la versión nueva donde está (o iría) la línea
  oAt: number;          // ídem en la versión antigua
  noNewline: boolean;   // va seguida de «\ No newline at end of file»
  block: number;        // índice global del bloque, -1 si es contexto
}

/**
 * Un bloque es una racha seguida de líneas «-» / «+» dentro de un hunk. Las líneas
 * «\ No newline…» no cortan la racha. El webview numera los bloques igual.
 */
export function parseDiffBlocks(diff: string): { hunks: DiffEntry[][]; blocks: string[][] } {
  const hunks: DiffEntry[][] = [];
  const blocks: string[][] = [];
  let cur: DiffEntry[] | null = null;
  let n = 0, o = 0;
  let inBlock = false;
  for (const l of diff.split('\n')) {
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))?/.exec(l);
      // Con 0 líneas git da la línea anterior («+0,0»): la siguiente sería la +1
      o = m ? Number(m[1]) + (m[2] === '0' ? 1 : 0) : 0;
      n = m ? Number(m[3]) + (m[4] === '0' ? 1 : 0) : 0;
      cur = [];
      hunks.push(cur);
      inBlock = false;
      continue;
    }
    if (!cur) { continue; }
    if (l.startsWith('\\')) { if (cur.length) { cur[cur.length - 1].noNewline = true; } continue; }
    const t = l[0];
    if (t !== ' ' && t !== '+' && t !== '-') { if (l.startsWith('diff --git')) { cur = null; } continue; }
    let block = -1;
    if (t === ' ') {
      inBlock = false;
    } else {
      if (!inBlock) { blocks.push([]); inBlock = true; }
      block = blocks.length - 1;
      blocks[block].push(l);
    }
    cur.push({ t, text: l.slice(1), nAt: n, oAt: o, noNewline: false, block });
    if (t !== '-') { n++; }
    if (t !== '+') { o++; }
  }
  return { hunks, blocks };
}

/**
 * Parche con un único bloque.
 *  - 'reverse' (por defecto): para aplicarlo al revés (`git apply -R`) sobre la versión
 *    nueva (rollback, o unstage sobre el índice). Los demás bloques del mismo hunk se tratan
 *    como ya aplicados: sus «+» pasan a contexto y sus «-» desaparecen.
 *  - 'forward': para aplicarlo tal cual sobre la versión antigua (stage de un bloque sobre
 *    el índice). Los demás bloques se tratan como no aplicados: sus «-» pasan a contexto y
 *    sus «+» desaparecen.
 */
export function buildBlockPatch(diff: string, blockIndex: number, filePath: string, mode: 'reverse' | 'forward' = 'reverse'): string | null {
  // -1 es el «bloque» de las líneas de contexto: no es un bloque de cambios
  if (!Number.isInteger(blockIndex) || blockIndex < 0) { return null; }
  const { hunks } = parseDiffBlocks(diff);
  const hunk = hunks.find(h => h.some(e => e.block === blockIndex));
  if (!hunk) { return null; }
  const fwd = mode === 'forward';
  const view = hunk.filter(e => e.block === blockIndex || e.t !== (fwd ? '+' : '-'));
  const first = view.findIndex(e => e.block === blockIndex);
  let last = first;
  while (last + 1 < view.length && view[last + 1].block === blockIndex) { last++; }
  const CTX = 3;
  const win = view.slice(Math.max(0, first - CTX), Math.min(view.length, last + 1 + CTX));
  let oldCount = 0, newCount = 0;
  const body: string[] = [];
  for (const e of win) {
    const t = e.block === blockIndex ? e.t : ' ';
    if (t !== '+') { oldCount++; }
    if (t !== '-') { newCount++; }
    body.push(t + e.text);
    if (e.noNewline) { body.push('\\ No newline at end of file'); }
  }
  // Las líneas anteriores a la ventana tienen el mismo número en ambas versiones
  const base = fwd ? win[0].oAt : win[0].nAt;
  const oldStart = oldCount ? base : base - 1;
  const newStart = newCount ? base : base - 1;
  const p = filePath.replace(/\\/g, '/');
  return [
    `diff --git a/${p} b/${p}`,
    `--- a/${p}`,
    `+++ b/${p}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...body,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Búsqueda de repositorios dentro de las carpetas abiertas
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', 'bower_components', 'vendor', 'target', 'dist', 'build', 'out']);

/**
 * Repositorios de las carpetas abiertas: el que contiene cada carpeta y los que haya
 * dentro, como JetBrains. También busca dentro de cada repo (submódulos y repos
 * anidados, aunque el de fuera los ignore, p. ej. «producto/repos/backend»). La
 * profundidad (maxDepth, como git.repositoryScanMaxDepth de VS Code) se cuenta desde la
 * carpeta abierta o desde el último repo encontrado. Se recorre por niveles, así los
 * menos profundos van primero. No sigue enlaces simbólicos ni entra en carpetas ocultas
 * o de dependencias.
 */
export async function findRepositories(folders: string[], maxDepth: number): Promise<string[]> {
  const roots: string[] = [];
  const add = (r?: string) => { if (r && !roots.includes(r)) { roots.push(r); } };
  const max = Math.max(0, maxDepth);
  for (const folder of folders) {
    add(await Git.findRoot(folder));
    // depth: niveles bajo la carpeta abierta o bajo el último repo encontrado
    let level = [{ dir: folder, depth: 0 }];
    while (level.length) {
      const next: { dir: string; depth: number }[] = [];
      for (const { dir, depth } of level) {
        if (depth >= max) { continue; }
        let entries: Dirent[];
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
        const subdirs = entries
          .filter(e => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
          .map(e => path.join(dir, e.name))
          .sort((a, b) => a.localeCompare(b));
        for (const sub of subdirs) {
          let isRepo = false;
          try { await fs.access(path.join(sub, '.git')); isRepo = true; } catch { /* no es un repo */ }
          if (isRepo) {
            add(await Git.findRoot(sub));
            next.push({ dir: sub, depth: 0 });
          } else {
            next.push({ dir: sub, depth: depth + 1 });
          }
        }
      }
      level = next;
    }
  }
  return roots;
}

export function parseNameStatusZ(out: string): FileChange[] {
  const t = out.split('\0');
  const files: FileChange[] = [];
  let i = 0;
  while (i < t.length) {
    const status = t[i++];
    if (!status) { break; }
    const s = status[0];
    if (s === 'R' || s === 'C') {
      const oldPath = t[i++];
      const path = t[i++];
      files.push({ status: s, path, oldPath });
    } else {
      files.push({ status: s, path: t[i++] });
    }
  }
  return files;
}

/** Separa "origin/feature/x" en { remote: "origin", branch: "feature/x" } usando la lista real de remotos. */
export function splitRemoteRef(name: string, remotes: string[]): { remote: string; branch: string } {
  const match = remotes
    .filter(r => name.startsWith(r + '/'))
    .sort((a, b) => b.length - a.length)[0];
  if (match) {
    return { remote: match, branch: name.slice(match.length + 1) };
  }
  const i = name.indexOf('/');
  return i < 0 ? { remote: '', branch: name } : { remote: name.slice(0, i), branch: name.slice(i + 1) };
}
