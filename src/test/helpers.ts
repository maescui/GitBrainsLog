/**
 * Utilidades de los tests: repos git temporales con fechas fijas (los commits salen siempre
 * en el mismo orden) y sin depender de la configuración global de git del equipo.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

// En Windows, git 2.50 no acepta os.devNull («\\.\nul»: Invalid argument) como archivo de
// configuración, pero sí «NUL»
const NULL_CONFIG = process.platform === 'win32' ? 'NUL' : os.devNull;

/** Entorno de git aislado: sin config global/sistema, autor fijo y sin editor ni pager. */
export const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: NULL_CONFIG,
  GIT_AUTHOR_NAME: 'Test User',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test User',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_EDITOR: 'true',
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
};

// Git (la clase de git.ts) hereda process.env: se aísla también para ella
Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: NULL_CONFIG, GIT_EDITOR: 'true', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0',
});

/** Carpeta temporal nueva (ruta real, sin enlaces de 8.3 en Windows). */
export function tmpDir(prefix = 'jbgit-'): string {
  return realpathSync.native(mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function rm(dir: string) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** Repo de prueba: ejecuta git y escribe archivos con fechas de commit crecientes. */
export class TestRepo {
  private clock = 1_700_000_000;   // 14/11/2023; cada commit, un minuto después

  constructor(public readonly root: string) {}

  static init(dir = tmpDir(), branch = 'main'): TestRepo {
    const r = new TestRepo(dir);
    r.git('init', '-q', '-b', branch);
    r.git('config', 'user.name', 'Test User');
    r.git('config', 'user.email', 'test@example.com');
    r.git('config', 'core.autocrlf', 'false');
    r.git('config', 'commit.gpgsign', 'false');
    return r;
  }

  /** git con el entorno aislado; devuelve stdout. Lanza si git falla. */
  git(...args: string[]): string {
    return execFileSync('git', args, { cwd: this.root, env: { ...GIT_ENV, ...this.dateEnv() }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  }

  /** Como git(), pero sin lanzar: { ok, out } (para merges con conflictos, etc.). */
  tryGit(...args: string[]): { ok: boolean; out: string } {
    try { return { ok: true, out: this.git(...args) }; } catch (e: any) { return { ok: false, out: String(e.stdout ?? '') + String(e.stderr ?? '') }; }
  }

  private dateEnv() {
    const d = `${this.clock} +0000`;
    return { GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d };
  }

  write(rel: string, content: string) {
    const p = path.join(this.root, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
  }

  /** Escribe los archivos, los añade y hace commit. Devuelve el hash. */
  commit(message: string, files: Record<string, string> = {}): string {
    this.clock += 60;
    for (const [f, c] of Object.entries(files)) { this.write(f, c); }
    this.git('add', '-A');
    this.git('commit', '-q', '--allow-empty', '-m', message);
    return this.head();
  }

  head(ref = 'HEAD'): string { return this.git('rev-parse', ref).trim(); }

  /** Avanza el reloj de los commits (p. ej. para merges con fecha posterior). */
  tick(seconds = 60) { this.clock += seconds; }
}
