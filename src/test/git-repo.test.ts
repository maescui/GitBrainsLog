/**
 * Tests de la clase Git (git.ts) contra repos temporales reales.
 */
import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { writeFileSync, rmSync, mkdirSync } from 'fs';
import * as path from 'path';
import { TestRepo, GIT_ENV, tmpDir, rm } from './helpers';
import { Git, LogFilters, EMPTY_FILTERS } from '../git';

const F = (f: Partial<LogFilters>): LogFilters => ({ ...EMPTY_FILTERS, ...f });
/** Fecha de los commits de TestRepo: el n-ésimo commit (desde 1) va a 1_700_000_000 + 60·n. */
const T0 = 1_700_000_000;

/** Commit con otro autor (se rehace el último con --amend, misma fecha). */
function commitAs(r: TestRepo, author: string, msg: string, files: Record<string, string>): string {
  r.commit(msg, files);
  r.git('commit', '-q', '--amend', '--no-edit', `--author=${author}`);
  return r.head();
}

/** Commit con el mensaje leído de un archivo (para mensajes con caracteres de control). */
function commitFile(r: TestRepo, message: string, files: Record<string, string> = {}): string {
  const mf = path.join(r.root, '..', `msg-${path.basename(r.root)}.txt`);
  writeFileSync(mf, message);
  r.commit('tmp', files);
  r.git('commit', '-q', '--amend', '--allow-empty', '--cleanup=verbatim', '-F', mf);
  rmSync(mf, { force: true });
  return r.head();
}

const same = (a: string | undefined, b: string) => assert.equal(path.resolve(a ?? ''), path.resolve(b));

// ---------------------------------------------------------------------------

describe('getLog', () => {
  let r: TestRepo;
  let git: Git;
  const h: Record<string, string> = {};
  before(() => {
    r = TestRepo.init();
    git = new Git(r.root);
    h.c1 = r.commit('init', { 'a.txt': '1\n' });                         // T0+60
    h.c2 = r.commit('second', { 'b.txt': '1\n' });                       // +120
    r.git('branch', 'feature');
    r.git('checkout', '-q', 'feature');
    h.f1 = r.commit('feat 1', { 'f.txt': '1\n' });                       // +180
    r.git('checkout', '-q', 'main');
    h.c3 = commitAs(r, 'Alice <alice@example.com>', 'third', { 'a.txt': '2\n' }); // +240
    r.git('checkout', '-q', 'feature');
    h.f2 = r.commit('feat 2', { 'f.txt': '2\n' });                       // +300
    r.git('checkout', '-q', 'main');
    r.tick();                                                            // +360
    r.git('merge', '-q', '--no-ff', '-m', 'Merge feature', 'feature');
    h.m = r.head();
    r.git('tag', 'v1', h.c2);
  });
  after(() => rm(r.root));

  test('todas las ramas, en orden de fecha (más nuevo primero)', async () => {
    const log = await git.getLog(null, 100);
    assert.deepEqual(log.map(c => c.hash), [h.m, h.f2, h.c3, h.f1, h.c2, h.c1]);
  });

  test('campos de cada commit', async () => {
    const log = await git.getLog(null, 100);
    const m = log[0];
    assert.deepEqual(m.parents, [h.c3, h.f2]);
    assert.equal(m.subject, 'Merge feature');
    assert.equal(m.time, T0 + 360);
    const c3 = log.find(c => c.hash === h.c3)!;
    assert.deepEqual({ author: c3.author, email: c3.email, time: c3.time, subject: c3.subject, parents: c3.parents },
      { author: 'Alice', email: 'alice@example.com', time: T0 + 240, subject: 'third', parents: [h.c2] });
    assert.deepEqual(log.at(-1)!.parents, [], 'el commit raíz no tiene padres');
  });

  test('max limita el número de commits', async () => {
    assert.deepEqual((await git.getLog(null, 2)).map(c => c.hash), [h.m, h.f2]);
  });

  test('con ref, solo esa rama', async () => {
    assert.deepEqual((await git.getLog('feature', 100)).map(c => c.hash), [h.f2, h.f1, h.c2, h.c1]);
    assert.deepEqual((await git.getLog('v1', 100)).map(c => c.hash), [h.c2, h.c1]);
  });

  // getLog intenta devolver [] con «unknown revision», pero como siempre pasa «--», git 2.50
  // responde «fatal: bad revision 'x'» y el error sube (p. ej. con el log filtrado por una
  // rama que se acaba de borrar)
  test('ref inexistente: lista vacía', async () => {
    assert.deepEqual(await git.getLog('no-existe', 100), []);
  });

  test('filtro de autor', async () => {
    assert.deepEqual((await git.getLog(null, 100, F({ authors: ['Alice'] }))).map(c => c.hash), [h.c3]);
    // Varios autores: unidos con «o»
    assert.equal((await git.getLog(null, 100, F({ authors: ['Alice', 'Test User'] }))).length, 6);
    // Por correo
    assert.deepEqual((await git.getLog(null, 100, F({ authors: ['alice@example.com'] }))).map(c => c.hash), [h.c3]);
  });

  test('filtro de fechas (since / until)', async () => {
    // c3 es 2023-11-14 22:17:20 UTC
    const since = await git.getLog(null, 100, F({ since: '2023-11-14 22:17:00 +0000' }));
    assert.deepEqual(since.map(c => c.hash), [h.m, h.f2, h.c3]);
    const until = await git.getLog(null, 100, F({ until: '2023-11-14 22:16:00 +0000' }));
    assert.deepEqual(until.map(c => c.hash), [h.c2, h.c1]);
    const both = await git.getLog(null, 100, F({ since: '2023-11-14 22:15:00 +0000', until: '2023-11-14 22:17:30 +0000' }));
    assert.deepEqual(both.map(c => c.hash), [h.c3, h.f1, h.c2]);
  });

  test('filtro de rutas (relativas a la raíz)', async () => {
    assert.deepEqual((await git.getLog(null, 100, F({ paths: ['a.txt'] }))).map(c => c.hash), [h.c3, h.c1]);
    assert.deepEqual((await git.getLog(null, 100, F({ paths: ['f.txt', 'b.txt'] }))).map(c => c.hash), [h.f2, h.f1, h.c2]);
  });

  test('First Parent en una rama: no entra en la rama mergeada y el merge tiene un solo padre', async () => {
    const log = await git.getLog('main', 100, F({ firstParent: true }));
    assert.deepEqual(log.map(c => c.hash), [h.m, h.c3, h.c2, h.c1]);
    assert.deepEqual(log[0].parents, [h.c3]);
  });

  test('First Parent sin rama (--all): los padres se recortan al primero', async () => {
    const log = await git.getLog(null, 100, F({ firstParent: true }));
    assert.ok(log.every(c => c.parents.length <= 1));
    assert.deepEqual(log.find(c => c.hash === h.m)!.parents, [h.c3]);
  });

  test('filtros combinados (autor + ruta)', async () => {
    assert.deepEqual(await git.getLog(null, 100, F({ authors: ['Alice'], paths: ['f.txt'] })), []);
  });
});

describe('getLog: autores como texto literal', () => {
  let r: TestRepo;
  before(() => {
    r = TestRepo.init();
    commitAs(r, 'A.b <x@example.com>', 'uno', { 'x': '1' });
    commitAs(r, 'Axb <y@example.com>', 'dos', { 'x': '2' });
    commitAs(r, 'C[1] <z@example.com>', 'tres', { 'x': '3' });
  });
  after(() => rm(r.root));

  test('«.» y «[» no son comodines', async () => {
    const git = new Git(r.root);
    assert.deepEqual((await git.getLog(null, 10, F({ authors: ['A.b'] }))).map(c => c.subject), ['uno']);
    assert.deepEqual((await git.getLog(null, 10, F({ authors: ['C[1]'] }))).map(c => c.subject), ['tres']);
  });
});

describe('getLog: el stash no sale en el log', () => {
  let r: TestRepo;
  after(() => rm(r.root));
  test('--all excluye refs/stash y sus commits de índice y sin seguimiento', async () => {
    r = TestRepo.init();
    const base = r.commit('base', { 'a.txt': '1\n' });
    r.write('a.txt', '2\n');
    r.write('u.txt', 'u\n');
    r.git('stash', 'push', '-q', '-u', '-m', 'guardado');
    const log = await new Git(r.root).getLog(null, 100);
    assert.deepEqual(log.map(c => c.hash), [base]);
  });
});

describe('getLog: mensajes difíciles', () => {
  let r: TestRepo;
  let git: Git;
  before(() => { r = TestRepo.init(); git = new Git(r.root); });
  after(() => rm(r.root));

  test('unicode, emojis y mensajes muy largos', async () => {
    const long = 'x'.repeat(5000);
    r.commit('ñandú 🚀 «comillas» "dobles" \'simples\' %s %x1f', { 'a': '1' });
    r.commit(long, { 'a': '2' });
    const log = await git.getLog(null, 10);
    assert.equal(log[0].subject, long);
    assert.equal(log[1].subject, 'ñandú 🚀 «comillas» "dobles" \'simples\' %s %x1f');
  });

  test('el asunto es solo la primera línea (el cuerpo no rompe los registros)', async () => {
    r.commit('asunto\n\ncuerpo\ncon varias líneas\n\x1e no', { 'a': '3' });
    const log = await git.getLog(null, 1);
    assert.equal(log.length, 1);
    assert.equal(log[0].subject, 'asunto');
  });

  // git conserva los caracteres de control del mensaje (comprobado con git 2.50), y getLog
  // usa \x1f / \x1e como separadores sin escaparlos
  test('un asunto con \\x1f (separador de campos)', async () => {
    const h = commitFile(r, 'antes\x1fdespués', { 'a': '4' });
    const log = await git.getLog(null, 1);
    assert.equal(log[0].hash, h);
    assert.equal(log[0].subject, 'antes\x1fdespués');
  });

  test('un asunto con \\x1e (separador de registros)', async () => {
    const h = commitFile(r, 'antes\x1edespués', { 'a': '5' });
    const log = await git.getLog(null, 100);
    assert.equal(log[0].hash, h);
    assert.equal(log[0].subject, 'antes\x1edespués');
    assert.ok(log.every(c => /^[0-9a-f]{40}$/.test(c.hash)), 'todos los registros son commits');
  });
});

describe('repo vacío (sin commits)', () => {
  let r: TestRepo;
  let git: Git;
  before(() => { r = TestRepo.init(); git = new Git(r.root); r.write('nuevo.txt', 'x'); });
  after(() => rm(r.root));

  test('getLog sin ref (--all) devuelve []', async () => {
    assert.deepEqual(await git.getLog(null, 10), []);
  });
  test('getLog con la rama actual (aún sin commits) devuelve []', async () => {
    assert.deepEqual(await git.getLog('main', 10), []);
    assert.deepEqual(await git.getLog('HEAD', 10), []);
  });
  test('getHead: sin hash, con la rama', async () => assert.deepEqual(await git.getHead(), { hash: '', branch: 'main' }));
  test('getRefs: []', async () => assert.deepEqual(await git.getRefs([]), []));
  test('getStatus: el archivo nuevo sale sin seguimiento', async () =>
    assert.deepEqual(await git.getStatus(), [{ group: 'untracked', status: '?', path: 'nuevo.txt' }]));
  test('getStashes: []', async () => assert.deepEqual(await git.getStashes(), []));
  test('getLastMessage: vacío', async () => assert.equal(await git.getLastMessage(), ''));
  test('getOperation: null', async () => assert.equal(await git.getOperation(), null));
  test('getRemotes: []', async () => assert.deepEqual(await git.getRemotes(), []));
});

// ---------------------------------------------------------------------------

describe('getRefs, getRemotes y getRemoteTags (con un remoto)', () => {
  let bare: string, r: TestRepo, other: TestRepo;
  const h: Record<string, string> = {};
  before(() => {
    bare = tmpDir('jbgit-bare-');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { env: GIT_ENV });
    r = TestRepo.init();
    h.c1 = r.commit('c1', { 'a.txt': '1\n' });
    r.git('remote', 'add', 'origin', bare);
    r.git('push', '-q', '-u', 'origin', 'main');
    r.git('tag', 'v1');
    r.git('tag', '-a', 'v2', '-m', 'anotado');
    r.git('push', '-q', 'origin', 'v1');
    // Otro clon sube un commit (main local quedará 1 por detrás)
    const od = tmpDir('jbgit-clone-');
    execFileSync('git', ['clone', '-q', bare, od], { env: GIT_ENV });
    other = new TestRepo(od);
    other.git('config', 'core.autocrlf', 'false');
    other.tick(600);
    h.remote = other.commit('remoto', { 'r.txt': '1\n' });
    other.git('push', '-q', 'origin', 'main');
    // Y la local tiene uno propio (1 por delante)
    h.local = r.commit('local', { 'l.txt': '1\n' });
    r.git('fetch', '-q', 'origin');
    // Rama con barras, con upstream
    r.git('branch', 'feature/x', h.c1);
    r.git('push', '-q', '-u', 'origin', 'feature/x');
    // Un remoto con barra en el nombre
    r.git('remote', 'add', 'team/origin', bare);
    r.git('fetch', '-q', 'team/origin');
    // Rama cuyo upstream se borra en el remoto
    r.git('branch', 'gone', h.c1);
    r.git('push', '-q', '-u', 'origin', 'gone');
    r.git('push', '-q', 'origin', '--delete', 'gone');
    r.git('fetch', '-q', '--prune', 'origin');
    r.git('fetch', '-q', '--prune', 'team/origin');
  });
  after(() => { rm(r.root); rm(other.root); rm(bare); });

  test('getRemotes', async () => {
    assert.deepEqual((await new Git(r.root).getRemotes()).sort(), ['origin', 'team/origin']);
  });

  test('rama local con upstream, ahead y behind', async () => {
    const refs = await new Git(r.root).getRefs(['origin', 'team/origin']);
    const main = refs.find(x => x.full === 'refs/heads/main')!;
    assert.deepEqual(main, { full: 'refs/heads/main', name: 'main', hash: h.local, type: 'local', upstream: 'origin/main', ahead: 1, behind: 1 });
    const fx = refs.find(x => x.full === 'refs/heads/feature/x')!;
    assert.deepEqual(fx, { full: 'refs/heads/feature/x', name: 'feature/x', hash: h.c1, type: 'local', upstream: 'origin/feature/x' });
  });

  test('upstream borrado en el remoto ([gone]): sin ahead/behind', async () => {
    const refs = await new Git(r.root).getRefs(['origin', 'team/origin']);
    const g = refs.find(x => x.full === 'refs/heads/gone')!;
    assert.equal(g.ahead, undefined);
    assert.equal(g.behind, undefined);
  });

  test('ramas remotas: remote y branch (también con barras en el remoto o en la rama)', async () => {
    const refs = await new Git(r.root).getRefs(['origin', 'team/origin']);
    const rem = refs.filter(x => x.type === 'remote').map(x => [x.name, x.remote, x.branch, x.hash]);
    assert.deepEqual(rem.sort(), [
      ['origin/feature/x', 'origin', 'feature/x', h.c1],
      ['origin/main', 'origin', 'main', h.remote],
      ['team/origin/feature/x', 'team/origin', 'feature/x', h.c1],
      ['team/origin/main', 'team/origin', 'main', h.remote],
    ].sort());
  });

  test('tags ligeros y anotados apuntan al commit', async () => {
    const refs = await new Git(r.root).getRefs(['origin']);
    const tags = refs.filter(x => x.type === 'tag').map(x => [x.name, x.hash]);
    assert.deepEqual(tags, [['v1', h.c1], ['v2', h.c1]]);
  });

  test('un tag anotado de un tag anotado apunta también al commit', async () => {
    r.git('tag', '-a', 'v3', '-m', 'tag de tag', 'v2');
    try {
      const refs = await new Git(r.root).getRefs(['origin']);
      assert.equal(refs.find(x => x.name === 'v3')!.hash, h.c1);
    } finally { r.git('tag', '-d', 'v3'); }
  });

  test('origin/HEAD no sale (clon)', async () => {
    const refs = await new Git(other.root).getRefs(['origin']);
    assert.ok(refs.some(x => x.full === 'refs/remotes/origin/main'));
    assert.ok(!refs.some(x => x.full.endsWith('/HEAD')), 'sin origin/HEAD');
  });

  test('getRemoteTags: nombres de los tags del remoto (sin ^{})', async () => {
    assert.deepEqual([...await new Git(r.root).getRemoteTags('origin')], ['v1']);
  });

  test('getRemoteTags con un remoto que no existe falla', async () => {
    await assert.rejects(new Git(r.root).getRemoteTags('nope'));
  });

  // Si una rama y un tag se llaman igual, %(refname:short) da «heads/x» y «tags/x»: el árbol y
  // las etiquetas del log mostrarían «heads/dup». Lo mismo con una rama local «origin/main».
  test('rama y tag con el mismo nombre: name sin el prefijo heads/ o tags/', async () => {
    r.git('branch', 'dup', h.c1);
    r.git('tag', 'dup', h.c1);
    try {
      const refs = await new Git(r.root).getRefs(['origin']);
      assert.equal(refs.find(x => x.full === 'refs/heads/dup')!.name, 'dup');
      assert.equal(refs.find(x => x.full === 'refs/tags/dup')!.name, 'dup');
    } finally { r.git('branch', '-D', 'dup'); r.git('tag', '-d', 'dup'); }
  });

  test('rama local llamada como una remota («origin/main»): name es el de la rama', async () => {
    r.git('branch', 'origin/main', h.c1);
    try {
      const refs = await new Git(r.root).getRefs(['origin']);
      assert.equal(refs.find(x => x.full === 'refs/heads/origin/main')!.name, 'origin/main');
    } finally { r.git('branch', '-D', 'origin/main'); }
  });
});

describe('getHead', () => {
  let r: TestRepo;
  after(() => rm(r.root));
  test('rama actual, rama con barras y HEAD separado', async () => {
    r = TestRepo.init();
    const c1 = r.commit('c1');
    const c2 = r.commit('c2');
    const git = new Git(r.root);
    assert.deepEqual(await git.getHead(), { hash: c2, branch: 'main' });
    r.git('checkout', '-q', '-b', 'feature/a/b');
    assert.deepEqual(await git.getHead(), { hash: c2, branch: 'feature/a/b' });
    r.git('checkout', '-q', '--detach', c1);
    assert.deepEqual(await git.getHead(), { hash: c1, branch: '' });
  });
});

// ---------------------------------------------------------------------------

describe('getCommitDetails, getChangedFiles y diffNameStatus', () => {
  let r: TestRepo;
  let git: Git;
  const h: Record<string, string> = {};
  const big = Array.from({ length: 30 }, (_, i) => `línea ${i}`).join('\n') + '\n';
  before(() => {
    r = TestRepo.init();
    git = new Git(r.root);
    h.root = r.commit('raíz', { 'a.txt': big, 'dir/con espacio.txt': 'x\n', 'ñandú.txt': 'ñ\n' });
    r.git('mv', 'a.txt', 'b.txt');
    h.ren = r.commit('renombrar', { 'z.txt': 'z\n' });
    r.git('rm', '-q', 'ñandú.txt');
    h.del = r.commit('borrar');
    r.git('checkout', '-q', '-b', 'side');
    h.side = r.commit('lado', { 'side.txt': 's\n' });
    r.git('checkout', '-q', 'main');
    h.main2 = r.commit('main 2', { 'main.txt': 'm\n' });
    r.tick();
    r.git('merge', '-q', '--no-ff', '-m', 'merge side', 'side');
    h.merge = r.head();
  });
  after(() => rm(r.root));

  test('commit raíz: todos sus archivos como A', async () => {
    const d = await git.getCommitDetails(h.root);
    assert.equal(d.hash, h.root);
    assert.deepEqual(d.parents, []);
    assert.deepEqual(d.files.sort((a, b) => a.path.localeCompare(b.path)), [
      { status: 'A', path: 'a.txt' }, { status: 'A', path: 'dir/con espacio.txt' }, { status: 'A', path: 'ñandú.txt' },
    ]);
  });

  test('renombrado (R con oldPath) y archivo nuevo', async () => {
    const d = await git.getCommitDetails(h.ren);
    assert.deepEqual(d.files, [{ status: 'R', path: 'b.txt', oldPath: 'a.txt' }, { status: 'A', path: 'z.txt' }]);
    assert.deepEqual(d.parents, [h.root]);
  });

  test('borrado', async () => {
    assert.deepEqual((await git.getCommitDetails(h.del)).files, [{ status: 'D', path: 'ñandú.txt' }]);
  });

  test('merge: archivos respecto al primer padre', async () => {
    const d = await git.getCommitDetails(h.merge);
    assert.deepEqual(d.parents, [h.main2, h.side]);
    assert.deepEqual(d.files, [{ status: 'A', path: 'side.txt' }]);
  });

  test('autor, committer y fechas', async () => {
    const d = await git.getCommitDetails(h.ren);
    assert.deepEqual([d.author, d.email, d.committer, d.committerEmail, d.time, d.commitTime],
      ['Test User', 'test@example.com', 'Test User', 'test@example.com', T0 + 120, T0 + 120]);
  });

  test('committer distinto del autor', async () => {
    const r2 = TestRepo.init();
    try {
      r2.commit('x', { a: '1' });
      execFileSync('git', ['commit', '-q', '--amend', '--no-edit'], {
        cwd: r2.root,
        env: { ...GIT_ENV, GIT_COMMITTER_NAME: 'Bob', GIT_COMMITTER_EMAIL: 'bob@example.com', GIT_COMMITTER_DATE: `${T0 + 9999} +0000` },
      });
      const d = await new Git(r2.root).getCommitDetails('HEAD');
      assert.deepEqual([d.author, d.committer, d.committerEmail, d.time, d.commitTime],
        ['Test User', 'Bob', 'bob@example.com', T0 + 60, T0 + 9999]);
    } finally { rm(r2.root); }
  });

  test('mensaje completo: varias líneas, con \\x1f dentro y sin los espacios del final', async () => {
    const r2 = TestRepo.init();
    try {
      const msg = '  asunto con sangría\n\ncuerpo\x1fcon separador\n\x1e también\n\n';
      commitFile(r2, msg + '   \n\n');
      const d = await new Git(r2.root).getCommitDetails('HEAD');
      assert.equal(d.message, '  asunto con sangría\n\ncuerpo\x1fcon separador\n\x1e también');
    } finally { rm(r2.root); }
  });

  test('getChangedFiles sin padre usa --root', async () => {
    assert.equal((await git.getChangedFiles(null, h.root)).length, 3);
    assert.deepEqual(await git.getChangedFiles(h.root, h.ren), [{ status: 'R', path: 'b.txt', oldPath: 'a.txt' }, { status: 'A', path: 'z.txt' }]);
  });

  test('diffNameStatus entre refs, con rutas y con el árbol de trabajo', async () => {
    assert.deepEqual(await git.diffNameStatus(h.root, h.del), [
      { status: 'R', path: 'b.txt', oldPath: 'a.txt' }, { status: 'A', path: 'z.txt' }, { status: 'D', path: 'ñandú.txt' },
    ]);
    assert.deepEqual(await git.diffNameStatus(h.root, h.del, ['z.txt']), [{ status: 'A', path: 'z.txt' }]);
    r.write('dir/con espacio.txt', 'cambiado\n');
    try {
      assert.deepEqual(await git.diffNameStatus('HEAD'), [{ status: 'M', path: 'dir/con espacio.txt' }]);
      assert.deepEqual(await git.diffNameStatus('HEAD', undefined, ['dir']), [{ status: 'M', path: 'dir/con espacio.txt' }]);
    } finally { r.git('checkout', '--', 'dir/con espacio.txt'); }
  });
});

// ---------------------------------------------------------------------------

describe('getHistory', () => {
  let r: TestRepo;
  let git: Git;
  const h: Record<string, string> = {};
  const big = (tag: string) => Array.from({ length: 30 }, (_, i) => `línea ${i}`).join('\n') + `\n${tag}\n`;
  before(() => {
    r = TestRepo.init();
    git = new Git(r.root);
    h.h1 = r.commit('crear a', { 'a.txt': big('v1') });
    h.h2 = r.commit('cambiar a', { 'a.txt': big('v2') });
    r.git('mv', 'a.txt', 'b.txt');
    h.h3 = r.commit('a → b');
    h.h4 = r.commit('otro', { 'otro.txt': 'x\n' });
    mkdirSync(path.join(r.root, 'dir'));
    r.git('mv', 'b.txt', 'dir/c.txt');
    r.write('dir/c.txt', big('v3'));
    h.h5 = r.commit('b → dir/c');
    h.h6 = r.commit('cambiar c', { 'dir/c.txt': big('v4'), 'dir/d.txt': 'd\n' });
  });
  after(() => rm(r.root));

  const pick = (l: { sha: string; status: string; path: string; oldPath?: string; parent: string | null }[]) =>
    l.map(e => [e.sha, e.status, e.path, e.oldPath, e.parent]);

  test('archivo: sigue los renombrados, con la ruta y el estado de cada commit', async () => {
    assert.deepEqual(pick(await git.getHistory('dir/c.txt', false)), [
      [h.h6, 'M', 'dir/c.txt', undefined, h.h5],
      [h.h5, 'R', 'dir/c.txt', 'b.txt', h.h4],
      [h.h3, 'R', 'b.txt', 'a.txt', h.h2],
      [h.h2, 'M', 'a.txt', undefined, h.h1],
      [h.h1, 'A', 'a.txt', undefined, null],
    ]);
  });

  test('autor, fecha y asunto', async () => {
    const e = (await git.getHistory('dir/c.txt', false)).at(-1)!;
    assert.deepEqual([e.author, e.time, e.subject], ['Test User', T0 + 60, 'crear a']);
  });

  test('desde una revisión (hash): la ruta que tenía entonces', async () => {
    assert.deepEqual(pick(await git.getHistory('b.txt', false, h.h4)), [
      [h.h3, 'R', 'b.txt', 'a.txt', h.h2],
      [h.h2, 'M', 'a.txt', undefined, h.h1],
      [h.h1, 'A', 'a.txt', undefined, null],
    ]);
  });

  test('max limita los commits', async () => {
    assert.equal((await git.getHistory('dir/c.txt', false, undefined, 2)).length, 2);
  });

  test('carpeta: commits que la tocan, sin estado y con la ruta de la carpeta', async () => {
    assert.deepEqual(pick(await git.getHistory('dir', true)), [
      [h.h6, '', 'dir', undefined, h.h5],
      [h.h5, '', 'dir', undefined, h.h4],
    ]);
  });

  test('ruta que no existe: lista vacía', async () => {
    assert.deepEqual(await git.getHistory('nada.txt', false), []);
  });

  test('nombres con espacios y unicode (core.quotePath=false)', async () => {
    const r2 = TestRepo.init();
    try {
      const a = r2.commit('uno', { 'mi carpeta/ñandú €.txt': '1\n' });
      const b = r2.commit('dos', { 'mi carpeta/ñandú €.txt': '2\n' });
      assert.deepEqual(pick(await new Git(r2.root).getHistory('mi carpeta/ñandú €.txt', false)), [
        [b, 'M', 'mi carpeta/ñandú €.txt', undefined, a],
        [a, 'A', 'mi carpeta/ñandú €.txt', undefined, null],
      ]);
    } finally { rm(r2.root); }
  });

  // Sin -z, git sigue poniendo entre comillas (y escapando) las rutas con «"», «\», tabuladores
  // o saltos de línea aunque core.quotePath=false. En Windows no se pueden crear en disco, pero
  // sí llegan en repos clonados de Linux; aquí se crean solo en el índice.
  test('nombre con comillas dobles', async () => {
    const r2 = TestRepo.init();
    try {
      // Git para Windows rechaza «"» en las rutas salvo con core.protectNTFS=false
      r2.git('config', 'core.protectNTFS', 'false');
      const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: r2.root, env: GIT_ENV, input: 'x\n', encoding: 'utf8' }).trim();
      r2.git('update-index', '--add', '--cacheinfo', `100644,${blob},a"b.txt`);
      r2.git('commit', '-q', '-m', 'raro');
      const l = await new Git(r2.root).getHistory('a"b.txt', false);
      assert.deepEqual(l.map(e => [e.status, e.path]), [['A', 'a"b.txt']]);
    } finally { rm(r2.root); }
  });

  test('un asunto con \\x1e no parte el commit', async () => {
    const r2 = TestRepo.init();
    try {
      const a = commitFile(r2, 'uno\x1edos', { 'f.txt': '1\n' });
      const l = await new Git(r2.root).getHistory('f.txt', false);
      assert.deepEqual(l.map(e => [e.sha, e.subject, e.status]), [[a, 'uno\x1edos', 'A']]);
    } finally { rm(r2.root); }
  });
});

describe('getHistory con merges', () => {
  let r: TestRepo;
  after(() => rm(r.root));
  test('carpeta: el merge que cambia la carpeta sale, sin estado', async () => {
    const r2 = TestRepo.init();
    try {
      const lines = (a: string, b: string) => `${a}\n2\n3\n4\n5\n6\n7\n8\n${b}\n`;
      r2.commit('base', { 'd/f.txt': lines('1', '9') });
      r2.git('checkout', '-q', '-b', 'side');
      r2.commit('lado', { 'd/f.txt': lines('1', 'NUEVE') });
      r2.git('checkout', '-q', 'main');
      const m1 = r2.commit('main', { 'd/f.txt': lines('UNO', '9') });
      r2.tick();
      r2.git('merge', '-q', '--no-ff', '-m', 'merge', 'side');
      const l = await new Git(r2.root).getHistory('d', true);
      assert.equal(l.length, 4);
      assert.deepEqual([l[0].sha, l[0].status, l[0].path, l[0].parent, l[0].subject], [r2.head(), '', 'd', m1, 'merge']);
    } finally { rm(r2.root); }
  });
  // CLAUDE.md: «los merges se quedan con la ruta del commit más nuevo», pero con --follow git
  // nunca muestra los merges (comprobado con git 2.50), ni siquiera los que cambian el archivo
  // respecto a los dos padres (resolución de conflictos). En una carpeta (sin --follow) sí salen.
  test('un merge que cambia el archivo sale con estado M y la ruta del commit más nuevo', async () => {
    r = TestRepo.init();
    const lines = (a: string, b: string) => `${a}\n2\n3\n4\n5\n6\n7\n8\n${b}\n`;
    const c1 = r.commit('base', { 'f.txt': lines('1', '9') });
    r.git('checkout', '-q', '-b', 'side');
    const s = r.commit('lado', { 'f.txt': lines('1', 'NUEVE') });
    r.git('checkout', '-q', 'main');
    const m1 = r.commit('main', { 'f.txt': lines('UNO', '9') });
    r.tick();
    r.git('merge', '-q', '--no-ff', '-m', 'merge', 'side');
    const m = r.head();
    const l = await new Git(r.root).getHistory('f.txt', false);
    const byHash = new Map(l.map(e => [e.sha, e]));
    assert.deepEqual(new Set(l.map(e => e.sha)), new Set([m, m1, s, c1]));
    assert.equal(l[0].sha, m);
    assert.deepEqual([byHash.get(m)!.status, byHash.get(m)!.path, byHash.get(m)!.parent], ['M', 'f.txt', m1]);
    assert.equal(byHash.get(c1)!.status, 'A');
  });
});

// ---------------------------------------------------------------------------

describe('getStatus', () => {
  let r: TestRepo;
  let git: Git;
  before(() => {
    r = TestRepo.init();
    git = new Git(r.root);
    const big = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n') + '\n';
    r.commit('base', { 'm.txt': '1\n', 'mm.txt': '1\n', 'old name.txt': big, 'del.txt': 'd\n', 'ñ.txt': '1\n' });
  });
  after(() => rm(r.root));

  test('staged, unstaged, ambos, renombrado, borrado y sin seguimiento (archivos sueltos de carpetas nuevas)', async () => {
    r.write('m.txt', '2\n');                       // unstaged M
    r.write('mm.txt', '2\n'); r.git('add', 'mm.txt'); r.write('mm.txt', '3\n'); // MM
    r.git('mv', 'old name.txt', 'new name.txt');   // R
    r.git('rm', '-q', 'del.txt');                  // D staged
    r.write('ñ.txt', '2\n'); r.git('add', 'ñ.txt'); // M staged unicode
    r.write('nueva/sub/u.txt', 'u');                // untracked en carpeta nueva
    const st = await git.getStatus();
    const key = (c: { group: string; status: string; path: string; oldPath?: string }) => `${c.group}:${c.status}:${c.path}:${c.oldPath ?? ''}`;
    assert.deepEqual(st.map(key).sort(), [
      'staged:D:del.txt:',
      'staged:M:mm.txt:',
      'staged:M:ñ.txt:',
      'staged:R:new name.txt:old name.txt',
      'unstaged:M:m.txt:',
      'unstaged:M:mm.txt:',
      'untracked:?:nueva/sub/u.txt:',
    ].sort());
  });

  test('archivo añadido con intent-to-add y el original borrado (renombrado en el árbol de trabajo)', async () => {
    const r2 = TestRepo.init();
    try {
      const big = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n') + '\n';
      r2.commit('base', { 'old.txt': big });
      rmSync(path.join(r2.root, 'old.txt'));
      r2.write('new.txt', big);
      r2.git('add', '-N', 'new.txt');
      const st = await new Git(r2.root).getStatus();
      // Lo que salga, ninguna entrada puede tener una ruta inventada
      for (const c of st) { assert.ok(['old.txt', 'new.txt'].includes(c.path), `ruta inesperada: ${JSON.stringify(c)}`); }
    } finally { rm(r2.root); }
  });
});

describe('getStatus: conflictos', () => {
  let r: TestRepo;
  after(() => rm(r.root));
  test('UU, AA, DU y UD van a conflicts', async () => {
    r = TestRepo.init();
    r.commit('base', { 'uu.txt': 'base\n', 'du.txt': 'base\n', 'ud.txt': 'base\n' });
    r.git('checkout', '-q', '-b', 'other');
    r.write('uu.txt', 'other\n');
    r.write('aa.txt', 'other\n');
    r.write('ud.txt', 'other\n');
    r.git('rm', '-q', 'du.txt');
    r.commit('other');
    r.git('checkout', '-q', 'main');
    r.write('uu.txt', 'main\n');
    r.write('aa.txt', 'main\n');
    r.write('du.txt', 'main\n');
    r.git('rm', '-q', 'ud.txt');
    r.commit('main');
    assert.equal(r.tryGit('merge', 'other').ok, false);
    const st = await new Git(r.root).getStatus();
    assert.deepEqual(st.map(c => `${c.group}:${c.status}:${c.path}`).sort(),
      ['conflicts:U:aa.txt', 'conflicts:U:du.txt', 'conflicts:U:ud.txt', 'conflicts:U:uu.txt']);
  });
});

// ---------------------------------------------------------------------------

describe('getStashes y getStashFiles', () => {
  let r: TestRepo;
  let git: Git;
  let base: string;
  before(() => {
    r = TestRepo.init();
    git = new Git(r.root);
    base = r.commit('base commit', { 'a.txt': '1\n', 'b.txt': '1\n' });
    r.write('a.txt', '2\n');
    r.write('s.txt', 'staged\n'); r.git('add', 's.txt');
    r.write('dir/u.txt', 'untracked\n');
    r.git('stash', 'push', '-q', '-u', '-m', 'mi stash: con dos puntos');
    r.tick();
    r.write('b.txt', '2\n');
    r.git('stash', 'push', '-q');
  });
  after(() => rm(r.root));

  test('lista: ref, mensaje (con -m y WIP), rama', async () => {
    const st = await git.getStashes();
    assert.equal(st.length, 2);
    assert.deepEqual(st.map(s => [s.ref, s.branch]), [['stash@{0}', 'main'], ['stash@{1}', 'main']]);
    assert.equal(st[0].message, `WIP: ${base.slice(0, 7)} base commit`);
    assert.equal(st[1].message, 'mi stash: con dos puntos');
    assert.equal(st[0].hash, r.head('stash@{0}'));
    assert.ok(st.every(s => Number.isInteger(s.time) && s.time > 0));
  });

  test('archivos: cambios respecto a la base y sin seguimiento (tercer padre), ordenados', async () => {
    const st = await git.getStashes();
    assert.deepEqual(await git.getStashFiles(st[1].hash), [
      { status: 'M', path: 'a.txt' },
      { status: 'A', path: 'dir/u.txt', untracked: true },
      { status: 'A', path: 's.txt' },
    ]);
    assert.deepEqual(await git.getStashFiles(st[0].hash), [{ status: 'M', path: 'b.txt' }]);
  });

  test('stash en HEAD separado', async () => {
    const r2 = TestRepo.init();
    try {
      r2.commit('uno', { 'a': '1' });
      r2.git('checkout', '-q', '--detach');
      r2.write('a', '2');
      r2.git('stash', 'push', '-q', '-m', 'separado');
      const [s] = await new Git(r2.root).getStashes();
      assert.equal(s.message, 'separado');
      assert.equal(s.branch, '(no branch)');
    } finally { rm(r2.root); }
  });
});

describe('getLastMessage', () => {
  let r: TestRepo;
  after(() => rm(r.root));
  test('mensaje completo de varias líneas, recortado', async () => {
    r = TestRepo.init();
    r.commit('asunto\n\ncuerpo línea 1\ncuerpo línea 2\n');
    assert.equal(await new Git(r.root).getLastMessage(), 'asunto\n\ncuerpo línea 1\ncuerpo línea 2');
  });
});

// ---------------------------------------------------------------------------

/** Repo con main y feature que chocan en c.txt. Devuelve el repo en main. */
function conflictRepo(featureCommits: Record<string, string>[] = [{ 'c.txt': 'feature\n' }]): TestRepo {
  const r = TestRepo.init();
  r.commit('base', { 'c.txt': 'base\n' });
  r.git('checkout', '-q', '-b', 'feature');
  featureCommits.forEach((files, i) => r.commit(`feature ${i + 1}`, files));
  r.git('checkout', '-q', 'main');
  r.commit('main cambia c', { 'c.txt': 'main\n' });
  return r;
}

describe('getOperation', () => {
  const repos: string[] = [];
  const track = (r: TestRepo) => { repos.push(r.root); return r; };
  after(() => repos.forEach(rm));

  test('sin operación: null', async () => {
    const r = track(conflictRepo());
    assert.equal(await new Git(r.root).getOperation(), null);
  });

  test('merge con conflictos: ours = rama actual, theirs = la que se mergea', async () => {
    const r = track(conflictRepo());
    assert.equal(r.tryGit('merge', 'feature').ok, false);
    assert.deepEqual(await new Git(r.root).getOperation(), { kind: 'merge', ours: 'main', theirs: 'feature' });
    r.git('merge', '--abort');
    assert.equal(await new Git(r.root).getOperation(), null);
  });

  test('merge de una rama con barras en otra rama con barras', async () => {
    const r = track(TestRepo.init());
    r.commit('base', { 'c.txt': 'base\n' });
    r.git('checkout', '-q', '-b', 'feature/a');
    r.commit('a', { 'c.txt': 'a\n' });
    r.git('checkout', '-q', '-b', 'release/1.0', 'main');
    r.commit('b', { 'c.txt': 'b\n' });
    assert.equal(r.tryGit('merge', 'feature/a').ok, false);
    assert.deepEqual(await new Git(r.root).getOperation(), { kind: 'merge', ours: 'release/1.0', theirs: 'feature/a' });
  });

  test('merge de una rama remota', async () => {
    const r = track(conflictRepo());
    const bare = tmpDir('jbgit-bare-');
    repos.push(bare);
    execFileSync('git', ['init', '-q', '--bare', bare], { env: GIT_ENV });
    r.git('remote', 'add', 'origin', bare);
    r.git('push', '-q', 'origin', 'feature');
    r.git('fetch', '-q', 'origin');
    assert.equal(r.tryGit('merge', 'origin/feature').ok, false);
    assert.deepEqual(await new Git(r.root).getOperation(), { kind: 'merge', ours: 'main', theirs: 'origin/feature' });
  });

  test('merge sin conflictos con --no-commit también es una operación a medias', async () => {
    const r = track(TestRepo.init());
    r.commit('base', { 'a.txt': '1\n' });
    r.git('checkout', '-q', '-b', 'f');
    r.commit('f', { 'b.txt': '1\n' });
    r.git('checkout', '-q', 'main');
    r.commit('m', { 'c.txt': '1\n' });
    r.git('merge', '-q', '--no-commit', '--no-ff', 'f');
    assert.deepEqual(await new Git(r.root).getOperation(), { kind: 'merge', ours: 'main', theirs: 'f' });
  });

  // MERGE_MSG dice «Merge tag 'v1'», que la expresión no reconoce, y refName solo mira ramas:
  // sale el hash corto en lugar del nombre del tag
  test('merge de un tag: theirs es el nombre del tag', async () => {
    const r = track(conflictRepo());
    r.git('tag', 'v1', 'feature');
    r.git('branch', '-D', 'feature');
    assert.equal(r.tryGit('merge', 'v1').ok, false);
    assert.deepEqual(await new Git(r.root).getOperation(), { kind: 'merge', ours: 'main', theirs: 'v1' });
  });

  for (const backend of ['--merge', '--apply'] as const) {
    test(`rebase (${backend}): ours = destino, theirs = rama que se rebasa, paso y total`, async () => {
      const r = track(conflictRepo([{ 'x.txt': '1\n' }, { 'c.txt': 'feature\n' }, { 'y.txt': '1\n' }]));
      r.git('checkout', '-q', 'feature');
      assert.equal(r.tryGit('rebase', backend, 'main').ok, false);
      assert.deepEqual(await new Git(r.root).getOperation(), { kind: 'rebase', ours: 'main', theirs: 'feature', step: 2, total: 3 });
      r.git('rebase', '--abort');
      assert.equal(await new Git(r.root).getOperation(), null);
    });
  }

  test('rebase de una rama con barras sobre una rama con barras', async () => {
    const r = track(TestRepo.init());
    r.commit('base', { 'c.txt': 'base\n' });
    r.git('checkout', '-q', '-b', 'feature/x');
    r.commit('x', { 'c.txt': 'x\n' });
    r.git('checkout', '-q', '-b', 'release/2', 'main');
    r.commit('y', { 'c.txt': 'y\n' });
    r.git('checkout', '-q', 'feature/x');
    assert.equal(r.tryGit('rebase', 'release/2').ok, false);
    assert.deepEqual(await new Git(r.root).getOperation(), { kind: 'rebase', ours: 'release/2', theirs: 'feature/x', step: 1, total: 1 });
  });

  test('cherry-pick con conflictos: theirs = hash corto + asunto', async () => {
    const r = track(conflictRepo());
    const f = r.head('feature');
    assert.equal(r.tryGit('cherry-pick', 'feature').ok, false);
    const op = await new Git(r.root).getOperation();
    assert.equal(op?.kind, 'cherry-pick');
    assert.equal(op?.ours, 'main');
    assert.match(op!.theirs, /^[0-9a-f]{7,} feature 1$/);
    assert.ok(f.startsWith(op!.theirs.split(' ')[0]));
  });

  test('revert con conflictos', async () => {
    const r = track(TestRepo.init());
    const c1 = r.commit('pone 1', { 'c.txt': '1\n' });
    r.commit('pone 2', { 'c.txt': '2\n' });
    // Revertir c1 choca con «pone 2»
    void c1;
    assert.equal(r.tryGit('revert', '--no-edit', 'HEAD~1').ok, false);
    const op = await new Git(r.root).getOperation();
    assert.equal(op?.kind, 'revert');
    assert.equal(op?.ours, 'main');
    assert.match(op!.theirs, /^[0-9a-f]{7,} pone 1$/);
  });

  test('merge en HEAD separado: ours = HEAD', async () => {
    const r = track(conflictRepo());
    r.git('checkout', '-q', '--detach', 'main');
    assert.equal(r.tryGit('merge', 'feature').ok, false);
    const op = await new Git(r.root).getOperation();
    assert.deepEqual(op && [op.kind, op.ours], ['merge', 'HEAD']);
  });

  test('en un worktree enlazado (rutas con --git-path)', async () => {
    const r = track(conflictRepo());
    const wt = path.join(tmpDir('jbgit-wt-'), 'wt');
    repos.push(path.dirname(wt));
    r.git('worktree', 'add', '-q', '-b', 'wtb', wt, 'main');
    const w = new TestRepo(wt);
    assert.equal(w.tryGit('merge', 'feature').ok, false);
    assert.deepEqual(await new Git(wt).getOperation(), { kind: 'merge', ours: 'wtb', theirs: 'feature' });
    // El repo principal no tiene ninguna operación
    assert.equal(await new Git(r.root).getOperation(), null);
  });
});

// ---------------------------------------------------------------------------

describe('findRoot, diffFiles', () => {
  let r: TestRepo;
  let plain: string;
  before(() => {
    r = TestRepo.init();
    r.commit('x', { 'sub/dir/f.txt': '1\n' });
    plain = tmpDir();
  });
  after(() => { rm(r.root); rm(plain); });

  test('findRoot: desde la raíz y desde una subcarpeta', async () => {
    same(await Git.findRoot(r.root), r.root);
    same(await Git.findRoot(path.join(r.root, 'sub', 'dir')), r.root);
  });

  test('findRoot: fuera de un repo o carpeta inexistente → undefined', async () => {
    assert.equal(await Git.findRoot(plain), undefined);
    assert.equal(await Git.findRoot(path.join(plain, 'no-existe')), undefined);
  });

  test('diffFiles: iguales → vacío; distintos (código 1) → el diff -U0', async () => {
    const a = path.join(plain, 'a.txt'), b = path.join(plain, 'b.txt'), c = path.join(plain, 'c.txt');
    writeFileSync(a, '1\n2\n3\n');
    writeFileSync(b, '1\nX\n3\n');
    writeFileSync(c, '1\n2\n3\n');
    const git = new Git(r.root);
    assert.equal(await git.diffFiles(a, c), '');
    const d = await git.diffFiles(a, b);
    assert.match(d, /^@@ -2 \+2 @@\n-2\n\+X\n/m);
    assert.ok(!/^@@.*\n 1/m.test(d), 'sin contexto (-U0)');
  });

  // git diff --no-index sale con código 1 también cuando no puede leer un archivo («error:
  // Could not access 'x'»), y diffFiles lo toma por «hay diferencias» y devuelve '' (= iguales)
  test('diffFiles: archivo que no existe → error', async () => {
    await assert.rejects(new Git(r.root).diffFiles(path.join(plain, 'nope1'), path.join(plain, 'nope2')));
  });
});

describe('Git.gitDirs (directorios que vigilan los watchers)', () => {
  const dirs: string[] = [];
  after(() => dirs.forEach(rm));
  const real = (p: string) => require('fs').realpathSync.native(p);

  test('repo normal: dir y common son .git', async () => {
    const r = TestRepo.init(); dirs.push(r.root);
    r.commit('c1', { 'a.txt': 'a' });
    const d = await new Git(r.root).gitDirs();
    assert.equal(real(d.dir), real(path.join(r.root, '.git')));
    assert.equal(real(d.common), real(d.dir));
  });

  test('worktree: .git es un archivo, dir cuelga de common/worktrees', async () => {
    const r = TestRepo.init(); dirs.push(r.root);
    r.commit('c1', { 'a.txt': 'a' });
    const wt = tmpDir(); dirs.push(wt);
    rmSync(wt, { recursive: true, force: true });
    r.git('worktree', 'add', '-q', '-b', 'other', wt);
    const d = await new Git(wt).gitDirs();
    assert.equal(real(d.common), real(path.join(r.root, '.git')));
    assert.ok(real(d.dir).startsWith(real(path.join(r.root, '.git', 'worktrees'))));
  });

  test('submódulo: el directorio de git está en .git/modules del padre', async () => {
    const sub = TestRepo.init(); dirs.push(sub.root);
    sub.commit('s1', { 's.txt': 's' });
    const parent = TestRepo.init(); dirs.push(parent.root);
    parent.commit('p1', { 'p.txt': 'p' });
    parent.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.root, 'sub');
    const d = await new Git(path.join(parent.root, 'sub')).gitDirs();
    assert.ok(real(d.dir).startsWith(real(path.join(parent.root, '.git', 'modules'))));
    assert.equal(real(d.common), real(d.dir));
  });
});

describe('Git.searchLog (búsqueda en todo el historial)', () => {
  let r: TestRepo, git: Git;
  const h: Record<string, string> = {};
  const ANA = 'Ana García <ana@x.es>', LUIS = 'Luis Martín <luis@y.com>';
  before(() => {
    r = TestRepo.init();
    h.c1 = commitAs(r, ANA, 'Arreglar login', { 'a.txt': '1\n' });
    h.c2 = commitAs(r, LUIS, 'Add ÑANDÚ cache', { 'b.txt': '1\n' });
    h.c3 = commitAs(r, ANA, 'Refactor: parser.* [wip]', { 'a.txt': '2\n' });
    h.c4 = commitAs(r, LUIS, 'bump deps\n\nsecreto-en-el-cuerpo', { 'c.txt': '1\n' });
    h.c5 = commitAs(r, ANA, 'Merge de luis', { 'a.txt': '3\n' });
    r.git('switch', '-q', '-c', 'feature', h.c2);
    h.f1 = commitAs(r, LUIS, 'Feature unique-zzz', { 'f.txt': '1\n' });
    r.git('switch', '-q', 'main');
    // Un commit que ya no cuelga de ninguna rama (HEAD separado y se vuelve a main)
    r.git('switch', '-q', '--detach', h.c1);
    h.orphan = commitAs(r, ANA, 'huerfano-xyz', { 'o.txt': '1\n' });
    r.git('switch', '-q', 'main');
    git = new Git(r.root);
  });
  after(() => rm(r.root));

  const subjects = async (q: string, ref: string | null = null, f: Partial<LogFilters> = {}, max = 100) =>
    (await git.searchLog(ref, q, max, F(f))).commits.map(c => c.subject);

  test('por mensaje, sin distinguir mayúsculas', async () => {
    assert.deepEqual(await subjects('ARREGLAR'), ['Arreglar login']);
    assert.deepEqual(await subjects('arreglar login'), ['Arreglar login']);
  });

  test('con acentos y eñes', async () => {
    assert.deepEqual(await subjects('ñandú'), ['Add ÑANDÚ cache']);
  });

  test('también por el cuerpo del mensaje', async () => {
    assert.deepEqual(await subjects('secreto-en-el-cuerpo'), ['bump deps']);
  });

  test('como texto literal: ".*" y "[" no son expresiones regulares', async () => {
    assert.deepEqual(await subjects('.*'), ['Refactor: parser.* [wip]']);
    assert.deepEqual(await subjects('[wip]'), ['Refactor: parser.* [wip]']);
    assert.deepEqual(await subjects('('), []);
  });

  test('por autor: nombre (con acentos) y correo', async () => {
    assert.deepEqual((await subjects('garcía')).sort(), ['Arreglar login', 'Merge de luis', 'Refactor: parser.* [wip]', 'huerfano-xyz'].filter(s => s !== 'huerfano-xyz').sort());
    assert.deepEqual((await subjects('luis@y')).sort(), ['Add ÑANDÚ cache', 'Feature unique-zzz', 'bump deps']);
  });

  test('si coincide por varios criterios sale una sola vez (mensaje y autor)', async () => {
    const s = await subjects('luis');   // el autor Luis (3 commits) y el mensaje «Merge de luis» (de Ana)
    assert.equal(s.length, 4);
    assert.equal(new Set(s).size, 4);
    assert.ok(s.includes('Merge de luis'));
  });

  test('buscar cifras no coincide con la fecha del commit (git la recorta al comparar el autor)', async () => {
    assert.deepEqual(await subjects('1700'), []);       // los commits de prueba son de 1_700_000_0xx
    assert.deepEqual(await subjects('+0000'), []);
  });

  test('pero un autor o un correo con cifras sí se encuentra', async () => {
    const n = TestRepo.init();
    try {
      commitAs(n, 'Cuenta 9981 <u9981@z.org>', 'primero', { 'x.txt': '1\n' });
      commitAs(n, 'Otra Persona <otra@z.org>', 'segundo', { 'x.txt': '2\n' });
      const found = async (q: string) => (await new Git(n.root).searchLog(null, q, 10, EMPTY_FILTERS)).commits.map(c => c.subject);
      assert.deepEqual(await found('9981'), ['primero']);
      assert.deepEqual(await found('u9981@'), ['primero']);
    } finally { rm(n.root); }
  });

  test('por el principio de un hash: completo, corto y en mayúsculas', async () => {
    assert.deepEqual(await subjects(h.c2), ['Add ÑANDÚ cache']);
    assert.deepEqual(await subjects(h.c2.slice(0, 7)), ['Add ÑANDÚ cache']);
    assert.deepEqual(await subjects(h.c2.slice(0, 8).toUpperCase()), ['Add ÑANDÚ cache']);
  });

  test('un prefijo de 3 cifras o menos no se toma por hash', async () => {
    // Con 3 cifras no se busca por hash: el commit solo puede salir si ese texto está en su mensaje o su autor
    const p3 = h.c2.slice(0, 3);
    const c2 = (await git.searchLog(null, p3, 100, EMPTY_FILTERS)).commits.find(c => c.hash === h.c2);
    assert.ok(!c2 || `${c2.subject} ${c2.author} ${c2.email}`.toLowerCase().includes(p3), `salió «${c2?.subject}» solo por su hash`);
    // y con 4 sí sale por el hash
    assert.ok((await git.searchLog(null, h.c2.slice(0, 4), 100, EMPTY_FILTERS)).commits.some(c => c.hash === h.c2));
  });

  test('el hash de un árbol no sale (solo commits)', async () => {
    const tree = r.git('rev-parse', 'HEAD^{tree}').trim();
    assert.deepEqual(await subjects(tree.slice(0, 10)), []);
  });

  test('un commit que no cuelga de ninguna rama no sale, ni por mensaje ni por hash', async () => {
    assert.deepEqual(await subjects('huerfano-xyz'), []);
    assert.deepEqual(await subjects(h.orphan), []);
  });

  test('respeta la rama del log: lo de otra rama solo sale con «todas»', async () => {
    assert.deepEqual(await subjects('unique-zzz'), ['Feature unique-zzz']);
    assert.deepEqual(await subjects('unique-zzz', 'main'), []);
    assert.deepEqual(await subjects('unique-zzz', 'feature'), ['Feature unique-zzz']);
    assert.deepEqual(await subjects(h.f1.slice(0, 8), 'main'), []);
    assert.deepEqual(await subjects(h.f1.slice(0, 8), 'feature'), ['Feature unique-zzz']);
  });

  test('el filtro de usuario se une con «y»: por mensaje y por autor', async () => {
    assert.deepEqual(await subjects('ÑANDÚ', null, { authors: ['Ana'] }), []);                   // el commit es de Luis
    assert.deepEqual(await subjects('ÑANDÚ', null, { authors: ['Luis'] }), ['Add ÑANDÚ cache']);
    assert.deepEqual(await subjects('luis', null, { authors: ['Ana'] }), ['Merge de luis']);     // autor Luis no, mensaje sí (y es de Ana)
    assert.deepEqual(await subjects('luis@y', null, { authors: ['Ana'] }), []);
    assert.deepEqual((await subjects('garcía', null, { authors: ['Luis'] })), []);
  });

  test('el filtro de usuario también vale para la búsqueda por hash', async () => {
    assert.deepEqual(await subjects(h.c2.slice(0, 8), null, { authors: ['Ana'] }), []);
    assert.deepEqual(await subjects(h.c2.slice(0, 8), null, { authors: ['Luis'] }), ['Add ÑANDÚ cache']);
  });

  test('respeta los filtros de rutas y de fechas', async () => {
    assert.deepEqual(await subjects('cache', null, { paths: ['b.txt'] }), ['Add ÑANDÚ cache']);
    assert.deepEqual(await subjects('Arreglar', null, { paths: ['b.txt'] }), []);
    assert.deepEqual(await subjects('Arreglar', null, { since: '2100-01-01' }), []);
    assert.deepEqual(await subjects('Arreglar', null, { until: '2000-01-01' }), []);
  });

  test('del más nuevo al más viejo', async () => {
    const found = (await git.searchLog(null, 'a', 100, EMPTY_FILTERS)).commits;
    assert.ok(found.length >= 4);
    for (let i = 1; i < found.length; i++) { assert.ok(found[i - 1].ctime >= found[i].ctime, 'orden por fecha'); }
  });

  test('límite: devuelve los más nuevos y avisa de que hay más', async () => {
    const all = await git.searchLog(null, 'a', 100, EMPTY_FILTERS);
    const cut = await git.searchLog(null, 'a', 2, EMPTY_FILTERS);
    assert.equal(cut.commits.length, 2);
    assert.equal(cut.truncated, true);
    assert.deepEqual(cut.commits.map(c => c.hash), all.commits.slice(0, 2).map(c => c.hash));
    assert.equal(all.truncated, false);
  });

  test('devuelve lo mismo que getLog para el mismo commit', async () => {
    const [fromLog] = (await git.getLog(null, 100)).filter(c => c.hash === h.c3);
    const [fromSearch] = (await git.searchLog(null, 'parser', 100)).commits;
    assert.deepEqual(fromSearch, fromLog);
  });

  test('vacía, solo espacios, rama inexistente o repo sin commits: sin error', async () => {
    assert.deepEqual((await git.searchLog(null, '', 10)).commits, []);
    assert.deepEqual((await git.searchLog(null, '   ', 10)).commits, []);
    assert.deepEqual((await git.searchLog('no-existe', 'login', 10)).commits, []);
    const empty = TestRepo.init();
    try { assert.deepEqual((await new Git(empty.root).searchLog(null, 'x', 10)).commits, []); } finally { rm(empty.root); }
  });

  test('un texto que empieza por «-» no se toma por una opción de git', async () => {
    assert.deepEqual(await subjects('--all'), []);
    assert.deepEqual(await subjects('-n1'), []);
  });
});
