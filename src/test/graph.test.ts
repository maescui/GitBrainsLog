/**
 * Tests de computeGraph (src/graph.ts): invariantes estructurales del grafo sobre muchas
 * historias generadas (lineales, con ramas, octopus, criss-cross, padres sin cargar,
 * orden aleatorio y un generador de DAG aleatorio con semilla fija), aristas largas y
 * colores.
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import * as path from 'path';
import { computeGraph, GraphRow, GraphColor, LONG_EDGE, MAIN_COLOR, Edge } from '../graph';

type C = { hash: string; parents: string[] };
const ROOT = path.join(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Generador pseudoaleatorio con semilla (mulberry32): los tests son reproducibles
// ---------------------------------------------------------------------------
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(xs: T[]): T => xs[Math.floor(next() * xs.length)] };
}

// ---------------------------------------------------------------------------
// Historias de ejemplo
// ---------------------------------------------------------------------------

/** Lista lineal: c0 (el más nuevo) → c1 → … → c(n-1) (raíz). */
function linear(n: number, prefix = 'c'): C[] {
  return Array.from({ length: n }, (_, i) => ({ hash: `${prefix}${i}`, parents: i < n - 1 ? [`${prefix}${i + 1}`] : [] }));
}

/**
 * Simula una historia de git: commits en ramas, ramas nuevas desde una punta y merges
 * (a veces octopus). Devuelve los commits en orden de creación (padres antes que hijos).
 */
function simulate(seed: number, steps: number, opts: { octopus?: boolean; maxBranches?: number } = {}): C[] {
  const r = rng(seed);
  const created: C[] = [{ hash: 'h0', parents: [] }];
  const tips: string[] = ['h0'];
  let id = 1;
  for (let s = 0; s < steps; s++) {
    const roll = r.next();
    const h = `h${id++}`;
    if (roll < 0.15 && tips.length < (opts.maxBranches ?? 8)) {
      // Rama nueva desde un commit cualquiera ya creado
      const from = r.pick(created).hash;
      created.push({ hash: h, parents: [from] });
      tips.push(h);
    } else if (roll < 0.3 && tips.length >= 2) {
      // Merge de dos (o más) puntas
      const k = opts.octopus && tips.length >= 3 && r.next() < 0.4 ? 3 + r.int(Math.min(3, tips.length - 2)) : 2;
      const pool = [...tips];
      const ps: string[] = [];
      for (let j = 0; j < k && pool.length; j++) { ps.push(pool.splice(r.int(pool.length), 1)[0]); }
      created.push({ hash: h, parents: ps });
      // La primera punta sigue en h; las demás desaparecen a veces (rama borrada tras el merge)
      tips[tips.indexOf(ps[0])] = h;
      for (const p of ps.slice(1)) { if (r.next() < 0.6) { tips.splice(tips.indexOf(p), 1); } }
    } else {
      const i = r.int(tips.length);
      created.push({ hash: h, parents: [tips[i]] });
      tips[i] = h;
    }
  }
  return created;
}

/** Orden topológico aleatorio (hijos antes que padres), como un log con otro orden de fechas. */
function randomTopo(created: C[], seed: number): C[] {
  const r = rng(seed);
  const children = new Map<string, number>();
  for (const c of created) { for (const p of c.parents) { children.set(p, (children.get(p) ?? 0) + 1); } }
  const byHash = new Map(created.map(c => [c.hash, c]));
  const ready = created.filter(c => !children.get(c.hash));
  const out: C[] = [];
  while (ready.length) {
    const c = ready.splice(r.int(ready.length), 1)[0];
    out.push(c);
    for (const p of c.parents) {
      const n = (children.get(p) ?? 0) - 1;
      children.set(p, n);
      if (n === 0) { ready.push(byHash.get(p)!); }
    }
  }
  return out;
}

/** Del más nuevo al más antiguo (orden inverso de creación: siempre topológico). */
const newestFirst = (created: C[]) => [...created].reverse();

/** DAG aleatorio puro: cada commit apunta a 0–3 commits posteriores de la lista. */
function randomDag(seed: number, n: number, maxSpan = 60): C[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const ps = new Set<number>();
    const k = i === n - 1 ? 0 : r.next() < 0.05 ? 0 : r.next() < 0.75 ? 1 : 2 + r.int(2);
    for (let j = 0; j < k && i + 1 < n; j++) { ps.add(i + 1 + r.int(Math.min(maxSpan, n - i - 1))); }
    return { hash: `d${i}`, parents: [...ps].map(p => `d${p}`) };
  });
}

// ---------------------------------------------------------------------------
// Comprobación de invariantes
// ---------------------------------------------------------------------------

const HEX = /^#[0-9a-fA-F]{6}$/;
function validColor(c: GraphColor): boolean {
  return typeof c === 'number' ? Number.isInteger(c) && c >= 0 : HEX.test(c);
}

interface Lane { hash: string; color: GraphColor; origin: number | 'up' }

/**
 * Recorre las filas reconstruyendo qué commit espera cada carril (por arriba y por abajo de
 * cada fila) y comprueba que todo encaja. Devuelve información para comprobaciones extra.
 */
function checkGraph(list: C[], rows: GraphRow[], showLong: boolean, colorOf?: (h: string) => GraphColor | undefined) {
  const where = (i: number, msg: string) => `fila ${i} (${list[i]?.hash}): ${msg}`;
  assert.equal(rows.length, list.length, 'una fila por commit');
  const rowOf = new Map(list.map((c, i) => [c.hash, i]));
  const n = list.length;
  let bottom = new Map<number, Lane>(); // carril → lo que baja por él al final de la fila anterior
  const ups: { row: number; parent: string; child: string; color: GraphColor }[] = [];
  const downs: { row: number; parent: string; color: GraphColor }[] = [];
  const colorsOfCuts = new Map<string, GraphColor[]>();

  for (let i = 0; i < n; i++) {
    const c = list[i], r = rows[i];
    assert.ok(Number.isInteger(r.col) && r.col >= 0, where(i, 'col válido'));
    assert.ok(validColor(r.color), where(i, `color de fila inválido ${r.color}`));
    for (const e of r.edges) {
      assert.ok(['pass', 'in', 'out', 'down', 'up'].includes(e.kind), where(i, `tipo ${e.kind}`));
      assert.ok(validColor(e.color), where(i, `color de arista inválido ${String(e.color)}`));
      assert.ok(e.from >= 0 && e.to >= 0, where(i, 'carriles no negativos'));
      // width cubre todos los carriles usados
      assert.ok(r.width > Math.max(e.from, e.to), where(i, `width ${r.width} no cubre la arista ${e.kind} ${e.from}→${e.to}`));
      if (e.kind === 'pass' || e.kind === 'down' || e.kind === 'up') { assert.equal(e.from, e.to, where(i, `${e.kind} debe ser vertical`)); }
      if (e.kind === 'out') { assert.equal(e.from, r.col, where(i, 'out sale del punto')); }
      if (e.kind === 'in') { assert.equal(e.to, r.col, where(i, 'in llega al punto')); }
      if (e.kind === 'down' || e.kind === 'up') { assert.equal(typeof e.jump, 'string', where(i, `${e.kind} sin jump`)); }
    }
    assert.ok(r.width > r.col, where(i, 'width cubre el punto'));

    // --- parte de arriba: lo que entra debe ser exactamente lo que bajaba de la fila anterior
    const topEdges = r.edges.filter(e => e.kind === 'in' || e.kind === 'pass' || e.kind === 'down');
    const topLanes = new Map<number, Edge>();
    for (const e of topEdges) {
      assert.ok(!topLanes.has(e.from), where(i, `dos aristas entran por el carril ${e.from}`));
      topLanes.set(e.from, e);
    }
    assert.deepEqual([...topLanes.keys()].sort((a, b) => a - b), [...bottom.keys()].sort((a, b) => a - b),
      where(i, 'los carriles que entran por arriba no coinciden con los que salían de la fila anterior'));
    for (const [lane, e] of topLanes) {
      const l = bottom.get(lane)!;
      assert.equal(e.color, l.color, where(i, `el color del carril ${lane} cambia entre filas`));
      if (e.kind === 'in') {
        assert.equal(l.hash, c.hash, where(i, `entra por ${lane} una línea de ${l.hash}, no de este commit`));
      } else {
        assert.notEqual(l.hash, c.hash, where(i, `una línea hacia este commit pasa de largo (${e.kind}) por ${lane}`));
        // Un carril no puede seguir esperando un commit que ya se pintó más arriba
        const t = rowOf.get(l.hash);
        assert.ok(t === undefined || t > i, where(i, `el carril ${lane} sigue esperando a ${l.hash}, que está en la fila ${t}`));
      }
      if (e.kind === 'down') {
        assert.equal(e.jump, l.hash, where(i, 'jump de down = padre'));
        downs.push({ row: i, parent: l.hash, color: e.color });
        if (!colorsOfCuts.has(l.hash)) { colorsOfCuts.set(l.hash, []); }
        colorsOfCuts.get(l.hash)!.push(e.color);
      }
    }
    // El punto: si llega algo por su carril, es una línea hacia él
    if (topLanes.has(r.col)) { assert.equal(topLanes.get(r.col)!.kind, 'in', where(i, 'por el carril del punto entra otra cosa')); }
    const inCol = r.edges.find(e => e.kind === 'in' && e.from === r.col);
    if (inCol) { assert.equal(inCol.color, r.color, where(i, 'el punto tiene el color de su carril')); }

    // --- parte de abajo
    const next = new Map<number, Lane>();
    const put = (lane: number, l: Lane, what: string) => {
      const prev = next.get(lane);
      if (prev) {
        // Solo pueden compartir carril dos líneas hacia el mismo commit (convergen en él)
        assert.equal(prev.hash, l.hash, where(i, `el carril ${lane} lo reclaman ${prev.hash} y ${l.hash} (${what})`));
        assert.equal(prev.color, l.color, where(i, `el carril ${lane} tiene dos colores`));
        return;
      }
      next.set(lane, l);
    };
    const outs = r.edges.filter(e => e.kind === 'out');
    assert.equal(outs.length, c.parents.length, where(i, 'una arista out por padre'));
    outs.forEach((e, k) => {
      const p = c.parents[k];
      const t = rowOf.get(p);
      if (t !== undefined) { assert.ok(t > i, where(i, `padre ${p} por encima del hijo (fila ${t})`)); }
      put(e.to, { hash: p, color: e.color, origin: i }, 'out');
    });
    // El primer padre sigue por el carril del commit con su color, salvo que converja en otro
    if (outs.length && outs[0].to === r.col) { assert.equal(outs[0].color, r.color, where(i, 'el primer padre hereda el color')); }
    for (const e of r.edges) {
      if (e.kind === 'pass') { put(e.from, bottom.get(e.from)!, 'pass'); }
      if (e.kind === 'up') {
        assert.ok(i + 1 < n, where(i, 'up en la última fila'));
        const parent = list[i + 1].hash;
        // jump = un hijo de ese padre, bastante más arriba
        const cr = rowOf.get(e.jump!);
        assert.ok(cr !== undefined && list[cr].parents.includes(parent), where(i, `jump de up (${e.jump}) no es hijo de ${parent}`));
        assert.ok(i + 1 - cr! > LONG_EDGE, where(i, 'up de una arista que no era larga'));
        ups.push({ row: i, parent, child: e.jump!, color: e.color });
        put(e.from, { hash: parent, color: e.color, origin: 'up' }, 'up');
      }
    }

    // --- aristas largas
    if (showLong) {
      assert.ok(!r.edges.some(e => e.kind === 'down' || e.kind === 'up'), where(i, 'con Show Long Edges no se corta nada'));
    } else {
      for (const [lane, l] of next) {
        if (l.origin === 'up') { continue; }
        const target = rowOf.get(l.hash) ?? n;
        // Una línea larga solo puede llegar a la fila siguiente al hijo (donde se corta)
        if (target - l.origin > LONG_EDGE && i > l.origin) {
          assert.fail(where(i, `la arista larga ${list[l.origin].hash}→${l.hash} (carril ${lane}) sigue después de la fila de corte`));
        }
      }
    }
    if (colorOf) {
      // Cabeza de rama (nada entra por arriba): color fijo de colorOf
      const fixed = colorOf(c.hash);
      if (!topLanes.has(r.col) && fixed !== undefined) { assert.equal(r.color, fixed, where(i, 'colorOf de la cabeza')); }
      // Segundo padre y siguientes que abren carril nuevo
      outs.slice(1).forEach((e, k) => {
        const p = c.parents[k + 1];
        // (si ya lo espera un carril que pasa, o el que reaparece con up, se reutiliza ese)
        const waiting = [...topLanes].some(([, te]) => te.kind === 'pass' && bottom.get(te.from)!.hash === p)
          || (r.edges.some(e => e.kind === 'up') && list[i + 1]?.hash === p);
        const fp = colorOf(p);
        if (!waiting && fp !== undefined) { assert.equal(e.color, fp, where(i, `colorOf del padre ${p}`)); }
      });
    }
    bottom = next;
  }
  // Lo que queda abajo del todo solo puede ir hacia padres que no están en la lista
  for (const [lane, l] of bottom) {
    assert.ok(!rowOf.has(l.hash), `al final, el carril ${lane} sigue esperando a ${l.hash}, que está en la lista`);
  }

  // Cada arista larga: flecha hacia abajo en la fila siguiente al hijo, y una sola flecha
  // hacia arriba (aparcada) en la fila anterior al padre si está cargado
  if (!showLong) {
    for (let i = 0; i < n; i++) {
      list[i].parents.forEach((p, k) => {
        const target = rowOf.get(p) ?? n;
        if (target - i <= LONG_EDGE) { return; }
        const out = rows[i].edges.filter(e => e.kind === 'out')[k];
        const d = rows[i + 1]?.edges.find(e => e.kind === 'down' && e.from === out.to);
        assert.ok(d, `arista larga ${list[i].hash}→${p}: falta la flecha hacia abajo en la fila ${i + 1}`);
        assert.equal(d.jump, p);
      });
    }
    for (const d of downs) {
      // La flecha baja justo en la fila siguiente a un hijo con arista larga
      const child = list[d.row - 1];
      assert.ok(child && child.parents.includes(d.parent), `down en la fila ${d.row} sin hijo de ${d.parent} encima`);
    }
    const cutParents = new Set(downs.map(d => d.parent));
    for (const p of cutParents) {
      const mine = ups.filter(u => u.parent === p);
      if (rowOf.has(p)) {
        assert.equal(mine.length, 1, `el padre ${p} debe reaparecer con una sola flecha hacia arriba (hay ${mine.length})`);
        assert.equal(mine[0].row, rowOf.get(p)! - 1, `la flecha hacia arriba de ${p} va en la fila anterior al padre`);
        assert.ok(colorsOfCuts.get(p)!.includes(mine[0].color), 'la flecha hacia arriba conserva el color de una de las cortadas');
      } else {
        assert.equal(mine.length, 0, `${p} no está cargado: se queda en la flecha`);
      }
    }
    for (const u of ups) { assert.ok(cutParents.has(u.parent), `up hacia ${u.parent} sin ninguna arista cortada`); }
  }
  return { ups, downs, maxWidth: Math.max(0, ...rows.map(r => r.width)) };
}

const run = (list: C[], showLong = false, colorOf?: (h: string) => GraphColor | undefined) => {
  const rows = computeGraph(list, showLong, colorOf);
  return { rows, info: checkGraph(list, rows, showLong, colorOf) };
};

// ---------------------------------------------------------------------------

describe('computeGraph: casos básicos', () => {
  test('lista vacía', () => assert.deepEqual(computeGraph([]), []));

  test('historia lineal: todo en el carril 0', () => {
    const { rows } = run(linear(10));
    for (const r of rows) { assert.equal(r.col, 0); assert.equal(r.width, 1); }
    assert.deepEqual(rows[0].edges, [{ kind: 'out', from: 0, to: 0, color: rows[0].color }]);
    assert.deepEqual(rows[9].edges.map(e => e.kind), ['in']);
  });

  test('un solo commit raíz', () => {
    const { rows } = run([{ hash: 'a', parents: [] }]);
    assert.deepEqual(rows, [{ col: 0, color: rows[0].color, width: 1, edges: [] }]);
  });

  test('merge simple: el segundo padre abre un carril a la derecha', () => {
    const list: C[] = [
      { hash: 'm', parents: ['a', 'b'] },
      { hash: 'b', parents: ['a'] },
      { hash: 'a', parents: [] },
    ];
    const { rows } = run(list);
    assert.equal(rows[0].col, 0);
    assert.deepEqual(rows[0].edges.filter(e => e.kind === 'out').map(e => e.to), [0, 1]);
    assert.equal(rows[1].col, 1);
    // b vuelve al carril 0, que ya espera a «a» (a la izquierda): converge en la fila de b
    assert.deepEqual(rows[1].edges.filter(e => e.kind === 'out').map(e => [e.from, e.to]), [[1, 0]]);
    assert.equal(rows[2].col, 0);
    assert.deepEqual(rows[2].edges.filter(e => e.kind === 'in').map(e => e.from), [0]);
  });

  test('regla de JetBrains: si un carril a la derecha ya espera al primer padre, el commit conserva su carril y convergen en el padre', () => {
    // A (merge B, P): carril 0 → B, carril 1 → P. B → P: B sigue en el carril 0 aunque el 1 ya espera a P
    const list: C[] = [
      { hash: 'A', parents: ['B', 'P'] },
      { hash: 'B', parents: ['P'] },
      { hash: 'P', parents: [] },
    ];
    const { rows } = run(list);
    assert.equal(rows[1].col, 0);
    assert.deepEqual(rows[1].edges.filter(e => e.kind === 'out'), [{ kind: 'out', from: 0, to: 0, color: rows[1].color }]);
    assert.ok(rows[1].edges.some(e => e.kind === 'pass' && e.from === 1), 'el carril 1 sigue hasta P');
    assert.equal(rows[2].col, 0);
    assert.deepEqual(rows[2].edges.filter(e => e.kind === 'in').map(e => [e.from, e.to]).sort(), [[0, 0], [1, 0]]);
  });

  test('si el carril que espera al primer padre está a la izquierda, el commit converge en él', () => {
    // X (carril 0) → P; Y es otra cabeza (carril 1) con el mismo padre: su out va al carril 0
    const list: C[] = [
      { hash: 'X', parents: ['P'] },
      { hash: 'Y', parents: ['P'] },
      { hash: 'P', parents: [] },
    ];
    const { rows } = run(list);
    assert.equal(rows[1].col, 1);
    assert.deepEqual(rows[1].edges.filter(e => e.kind === 'out').map(e => [e.from, e.to]), [[1, 0]]);
    assert.equal(rows[2].col, 0);
    // Y deja su carril libre: P solo recibe por el carril 0
    assert.deepEqual(rows[2].edges.filter(e => e.kind === 'in').map(e => e.from), [0]);
  });

  test('octopus: un out por padre, cada uno en su carril', () => {
    const list: C[] = [
      { hash: 'o', parents: ['a', 'b', 'c', 'd'] },
      { hash: 'd', parents: ['r'] },
      { hash: 'c', parents: ['r'] },
      { hash: 'b', parents: ['r'] },
      { hash: 'a', parents: ['r'] },
      { hash: 'r', parents: [] },
    ];
    const { rows } = run(list);
    assert.deepEqual(rows[0].edges.filter(e => e.kind === 'out').map(e => e.to), [0, 1, 2, 3]);
    assert.equal(rows[0].width, 4);
  });

  test('criss-cross: dos merges cruzados entre las mismas ramas', () => {
    const list: C[] = [
      { hash: 'top', parents: ['m1', 'm2'] },
      { hash: 'm1', parents: ['b1', 'b2'] },
      { hash: 'm2', parents: ['b2', 'b1'] },
      { hash: 'b1', parents: ['base'] },
      { hash: 'b2', parents: ['base'] },
      { hash: 'base', parents: [] },
    ];
    run(list);
    run(list, true);
  });

  test('padres sin cargar (log cortado o filtrado): las líneas siguen hasta abajo', () => {
    const list: C[] = [
      { hash: 'a', parents: ['b', 'x'] },
      { hash: 'b', parents: ['y'] },
    ];
    const { rows } = run(list);
    // x e y no están: sus carriles llegan al final
    assert.equal(rows[1].edges.filter(e => e.kind === 'pass').length, 1);
  });

  test('varias raíces y cabezas independientes (varios repos juntos)', () => {
    const a = linear(5, 'a'), b = linear(5, 'b');
    const list = [a[0], b[0], a[1], b[1], a[2], b[2], a[3], b[3], a[4], b[4]];
    const { rows } = run(list);
    assert.ok(rows.every(r => r.width <= 2));
  });

  test('padres repetidos en distinto orden respecto al log (el segundo padre aparece antes que el primero)', () => {
    const list: C[] = [
      { hash: 'm', parents: ['a', 'b'] },
      { hash: 'a', parents: ['r'] },
      { hash: 'b', parents: ['r'] },
      { hash: 'r', parents: [] },
    ];
    run(list);
  });
});

describe('computeGraph: historias generadas (invariantes)', () => {
  test('simulaciones de git con ramas y merges (orden de creación inverso)', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const list = newestFirst(simulate(seed, 150));
      run(list);
      run(list, true);
    }
  });

  test('con octopus', () => {
    for (let seed = 100; seed <= 140; seed++) {
      const list = newestFirst(simulate(seed, 150, { octopus: true }));
      run(list);
      run(list, true);
    }
  });

  test('órdenes topológicos aleatorios (otro orden de fechas)', () => {
    for (let seed = 200; seed <= 240; seed++) {
      const created = simulate(seed, 120, { maxBranches: 12 });
      const list = randomTopo(created, seed * 7);
      run(list);
      run(list, true);
    }
  });

  test('DAG aleatorio con aristas largas y cortas', () => {
    for (let seed = 300; seed <= 360; seed++) {
      const list = randomDag(seed, 200, seed % 2 ? 80 : 40);
      run(list);
      run(list, true);
    }
  });

  test('DAG aleatorio grande con muchas aristas muy largas (varias hacia el mismo padre)', () => {
    for (let seed = 370; seed <= 380; seed++) {
      const list = randomDag(seed, 400, 250);
      run(list);
      run(list, true);
    }
  });

  test('el comprobador detecta grafos rotos (no es vacuo)', () => {
    const list = newestFirst(simulate(42, 80));
    const rows = computeGraph(list);
    const k = rows.findIndex(r => r.edges.some(e => e.kind === 'pass'));
    assert.ok(k >= 0);
    const broken1 = structuredClone(rows);
    broken1[k].edges = broken1[k].edges.filter(e => e.kind !== 'pass');
    assert.throws(() => checkGraph(list, broken1, false));
    const broken2 = structuredClone(rows);
    const e = broken2[k].edges.find(x => x.kind === 'pass')!;
    e.from = e.to = e.from + 5;
    assert.throws(() => checkGraph(list, broken2, false));
    const broken3 = structuredClone(rows);
    broken3[k].width = 0;
    assert.throws(() => checkGraph(list, broken3, false));
  });

  test('log truncado: solo los primeros N commits (padres sin cargar)', () => {
    for (let seed = 400; seed <= 430; seed++) {
      const full = newestFirst(simulate(seed, 200));
      const list = full.slice(0, 50 + (seed % 60));
      run(list);
      run(list, true);
    }
  });

  test('log filtrado: faltan commits intermedios y sus padres se quitan (como hace la extensión con filtros)', () => {
    for (let seed = 500; seed <= 530; seed++) {
      const r = rng(seed);
      const full = newestFirst(simulate(seed, 200));
      const kept = full.filter(() => r.next() < 0.5);
      const known = new Set(kept.map(c => c.hash));
      run(kept.map(c => ({ hash: c.hash, parents: c.parents.filter(p => known.has(p)) })));
      // y sin quitar los padres (padres sin cargar en medio)
      run(kept);
    }
  });

  test('con colorOf: los colores fijos se respetan', () => {
    for (let seed = 600; seed <= 630; seed++) {
      const list = newestFirst(simulate(seed, 150));
      const r = rng(seed);
      const fixed = new Map<string, GraphColor>();
      for (const c of list) {
        const x = r.next();
        if (x < 0.1) { fixed.set(c.hash, '#a1b2c3'); } else if (x < 0.2) { fixed.set(c.hash, r.int(10)); }
      }
      run(list, false, h => fixed.get(h));
    }
  });
});

describe('computeGraph: colores', () => {
  test('los carriles anónimos nunca usan MAIN_COLOR (módulo la paleta)', () => {
    for (let seed = 700; seed <= 720; seed++) {
      const list = newestFirst(simulate(seed, 200, { maxBranches: 20 }));
      for (const r of computeGraph(list)) {
        for (const c of [r.color, ...r.edges.map(e => e.color)]) {
          assert.equal(typeof c, 'number');
          assert.notEqual((c as number) % 10, MAIN_COLOR, `color anónimo ${c}`);
        }
      }
    }
  });

  test('colorOf de la cabeza se hereda por la cadena de primeros padres', () => {
    const list = linear(6);
    const rows = computeGraph(list, false, h => (h === 'c0' ? MAIN_COLOR : undefined));
    for (const r of rows) { assert.equal(r.color, MAIN_COLOR); }
  });

  test('colorOf del segundo padre de un merge', () => {
    const list: C[] = [
      { hash: 'm', parents: ['a', 'f'] },
      { hash: 'f', parents: ['a'] },
      { hash: 'a', parents: [] },
    ];
    const rows = computeGraph(list, false, h => (h === 'f' ? '#123456' : h === 'm' ? 3 : undefined));
    assert.equal(rows[0].color, 3);
    assert.equal(rows[0].edges.find(e => e.kind === 'out' && e.to === 1)!.color, '#123456');
    assert.equal(rows[1].color, '#123456');
  });

  test('PALETTE_SIZE de graph.ts coincide con PALETTE de media/main.js', () => {
    const ts = readFileSync(path.join(ROOT, 'src', 'graph.ts'), 'utf8');
    const js = readFileSync(path.join(ROOT, 'media', 'main.js'), 'utf8');
    const size = Number(/const PALETTE_SIZE = (\d+);/.exec(ts)![1]);
    const pal = /const PALETTE = (\[[^\]]*\]);/.exec(js)!;
    assert.equal(JSON.parse(pal[1].replace(/'/g, '"')).length, size);
  });
});

describe('computeGraph: aristas largas', () => {
  /** Rama larga: main lineal de n commits y un merge arriba cuyo segundo padre está a dist filas. */
  function longMerge(n: number, dist: number): C[] {
    const main = linear(n, 'm');
    main[0] = { hash: 'm0', parents: ['m1', `m${dist}`] };
    return main;
  }

  test(`una arista de más de LONG_EDGE (${LONG_EDGE}) filas se corta en down / up con los jump correctos`, () => {
    const list = longMerge(60, 45);
    const { rows, info } = run(list);
    const down = rows[1].edges.find(e => e.kind === 'down');
    assert.ok(down);
    assert.equal(down.jump, 'm45');
    const up = rows[44].edges.find(e => e.kind === 'up');
    assert.ok(up);
    assert.equal(up.jump, 'm0');
    // Entre medias el carril queda libre: ancho 1
    for (let i = 2; i < 44; i++) { assert.equal(rows[i].width, 1, `fila ${i}`); }
    assert.equal(info.ups.length, 1);
  });

  test('una arista de exactamente LONG_EDGE filas no se corta', () => {
    const { rows } = run(longMerge(60, LONG_EDGE));
    assert.ok(!rows.some(r => r.edges.some(e => e.kind === 'down' || e.kind === 'up')));
    // y una de LONG_EDGE + 1 sí
    const { rows: r2 } = run(longMerge(60, LONG_EDGE + 1));
    assert.ok(r2[1].edges.some(e => e.kind === 'down'));
  });

  test('con showLongEdges = true no se corta nada', () => {
    const { rows } = run(longMerge(60, 45), true);
    for (let i = 1; i < 45; i++) { assert.ok(rows[i].edges.some(e => e.kind === 'pass' && e.from === 1), `fila ${i}`); }
  });

  test('varias aristas cortadas hacia el mismo padre reaparecen en una sola (parked)', () => {
    // m0..m4 son merges cuyo segundo padre es m50
    const list = linear(80, 'm');
    for (let i = 0; i < 5; i++) { list[i] = { hash: `m${i}`, parents: [`m${i + 1}`, 'm50'] }; }
    const { rows, info } = run(list);
    assert.equal(info.downs.filter(d => d.parent === 'm50').length, 5);
    const ups = rows[49].edges.filter(e => e.kind === 'up');
    assert.equal(ups.length, 1);
    assert.equal(ups[0].jump, 'm0', 'jump = el hijo que abrió la primera arista');
  });

  test('padre sin cargar a más de LONG_EDGE filas: solo la flecha hacia abajo', () => {
    const list = linear(50, 'm');
    list[0] = { hash: 'm0', parents: ['m1', 'fuera'] };
    const { rows, info } = run(list);
    assert.ok(rows[1].edges.some(e => e.kind === 'down' && e.jump === 'fuera'));
    assert.equal(info.ups.length, 0);
  });

  test('padre sin cargar a menos de LONG_EDGE filas del final: la línea llega hasta abajo', () => {
    const list = linear(10, 'm');
    list[0] = { hash: 'm0', parents: ['m1', 'fuera'] };
    const { rows } = run(list);
    assert.ok(rows[9].edges.some(e => e.kind === 'pass'));
  });

  test('el corte reduce mucho el ancho con muchas ramas largas', () => {
    // 15 merges seguidos cuyos segundos padres están muy abajo
    const list = linear(120, 'm');
    for (let i = 0; i < 15; i++) { list[i] = { hash: `m${i}`, parents: [`m${i + 1}`, `m${60 + i * 3}`] }; }
    const cut = run(list).info.maxWidth;
    const full = run(list, true).info.maxWidth;
    assert.ok(full >= 15, `sin cortar ${full}`);
    assert.ok(cut <= 3, `cortado ${cut}`);
  });

  test('el primer padre lejano también se corta (rama que nace muy abajo)', () => {
    // c0 → p (a 40 filas), y en medio otra rama lineal
    const other = linear(40, 'o');
    other[39] = { hash: 'o39', parents: [] };
    const list: C[] = [{ hash: 'c0', parents: ['p'] }, ...other, { hash: 'p', parents: [] }];
    const { rows } = run(list);
    assert.ok(rows[1].edges.some(e => e.kind === 'down' && e.jump === 'p'));
    assert.ok(rows[40].edges.some(e => e.kind === 'up' && e.jump === 'c0'));
  });
});

describe('computeGraph: orden incorrecto', () => {
  test('un padre que aparece por encima de su hijo no deja un carril colgando hasta el final', () => {
    // P aparece antes que su hijo C (p. ej. relojes desajustados al ordenar por fecha)
    const list: C[] = [
      { hash: 'P', parents: [] },
      { hash: 'C', parents: ['P'] },
      ...linear(5, 'z'),
    ];
    const rows = computeGraph(list);
    // Lo razonable: la línea C→P no se puede pintar hacia abajo; no debe atravesar z0..z4
    for (let i = 2; i < rows.length; i++) {
      assert.equal(rows[i].width, 1, `fila ${i}: carril colgando hacia ${'P'}`);
    }
  });

  test('mergeLogs (core.ts) con varios repos no pone un padre por encima de su hijo', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { mergeLogs } = require('../core') as typeof import('../core');
    // Repo 0: git log --date-order da c2 → c1 → c0, pero c2 se rebasó y conserva su fecha de autor antigua
    const r0 = { idx: 0 }, r1 = { idx: 1 };
    const repo0 = [
      { hash: 'c2', parents: ['c1'], time: 100 },
      { hash: 'c1', parents: ['c0'], time: 200 },
      { hash: 'c0', parents: [], time: 50 },
    ];
    const repo1 = [{ hash: 'x0', parents: [], time: 150 }];
    const merged = mergeLogs([{ repo: r0, commits: repo0, limited: false }, { repo: r1, commits: repo1, limited: false }], 100)
      .commits.map(x => x.c);
    const pos = new Map(merged.map((c, i) => [c.hash, i]));
    for (const c of merged) {
      for (const p of c.parents) { assert.ok(pos.get(p)! > pos.get(c.hash)!, `${p} (padre) sale antes que ${c.hash}`); }
    }
  });
});

describe('computeGraph: la línea principal (main/master) en el carril 0', () => {
  const runMain = (list: C[], mainTips: string[], showLong = false, colorOf?: (h: string) => GraphColor | undefined) => {
    const rows = computeGraph(list, showLong, colorOf, mainTips);
    checkGraph(list, rows, showLong, colorOf);
    return rows;
  };
  const colOf = (list: C[], rows: GraphRow[]) => Object.fromEntries(list.map((c, i) => [c.hash, rows[i].col]));
  /** La cadena de primeros padres desde la punta (la misma definición que usa computeGraph). */
  const mainLineOf = (list: C[], tip: string): string[] => {
    const rowOf = new Map(list.map((c, i) => [c.hash, i]));
    const out: string[] = [];
    let row = rowOf.get(tip);
    while (row !== undefined && !out.includes(list[row].hash)) {
      out.push(list[row].hash);
      const r0 = row;
      const next = list[row].parents.filter(p => (rowOf.get(p) ?? list.length) > r0)[0];
      row = next === undefined ? undefined : rowOf.get(next);
    }
    return out;
  };

  test('una rama más nueva que main ya no la desplaza: main en el 0 y la rama a su derecha', () => {
    //  F1 (rama, parte de C1)   M (main)   C1 (raíz)
    const list: C[] = [{ hash: 'F1', parents: ['C1'] }, { hash: 'M', parents: ['C1'] }, { hash: 'C1', parents: [] }];
    // Antes: la rama más nueva tomaba el carril 0 y main se quedaba en el 1
    assert.deepEqual(colOf(list, computeGraph(list)), { F1: 0, M: 1, C1: 0 });
    const rows = runMain(list, ['M']);
    assert.deepEqual(colOf(list, rows), { F1: 1, M: 0, C1: 0 });
    // La línea de la rama se une a main en C1, curvándose hacia la izquierda
    assert.ok(rows[2].edges.some(e => e.kind === 'in' && e.from === 1 && e.to === 0));
  });

  test('main detrás de una rama (la rama tiene commits encima de la punta de main)', () => {
    const list: C[] = [{ hash: 'F2', parents: ['F1'] }, { hash: 'F1', parents: ['M'] }, { hash: 'M', parents: ['C1'] }, { hash: 'C1', parents: [] }];
    assert.deepEqual(colOf(list, computeGraph(list)), { F2: 0, F1: 0, M: 0, C1: 0 });   // sin reservar, ya salía a la izquierda
    const rows = runMain(list, ['M']);
    assert.deepEqual(colOf(list, rows), { F2: 1, F1: 1, M: 0, C1: 0 });                  // ahora main siempre en el 0
    assert.ok(rows[2].edges.some(e => e.kind === 'in' && e.from === 1 && e.to === 0), 'la rama se une a main en su punta');
  });

  test('main que mergea una rama: la rama a la derecha, main en el 0', () => {
    const list: C[] = [
      { hash: 'M2', parents: ['M1', 'B1'] }, { hash: 'B1', parents: ['M0'] }, { hash: 'M1', parents: ['M0'] }, { hash: 'M0', parents: [] },
    ];
    const c = colOf(list, runMain(list, ['M2']));
    assert.deepEqual([c.M2, c.M1, c.M0], [0, 0, 0]);
    assert.ok(c.B1 >= 1);
  });

  test('muchas ramas por encima: main sigue en el 0 y nada se solapa con él', () => {
    // 5 ramas con commits más nuevos que main, todas salidas de C1
    const feats: C[] = Array.from({ length: 5 }, (_, i) => ({ hash: `F${i}`, parents: ['C1'] }));
    const list: C[] = [...feats, { hash: 'M', parents: ['C1'] }, { hash: 'C1', parents: [] }];
    const c = colOf(list, runMain(list, ['M']));
    assert.equal(c.M, 0);
    assert.equal(c.C1, 0);
    for (const f of feats) { assert.ok(c[f.hash] >= 1, `${f.hash} no puede ir en el carril de main`); }
  });

  test('sin la punta de main en la lista, el resultado es idéntico al de siempre', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const list = newestFirst(simulate(seed, 80));
      assert.deepEqual(computeGraph(list, false, undefined, ['no-esta']), computeGraph(list));
      assert.deepEqual(computeGraph(list, false, undefined, []), computeGraph(list));
    }
  });

  test('el carril 0 solo se reserva hasta el último commit de main: después lo usa cualquiera', () => {
    // main (M1 → M0, raíz) termina antes que otra historia independiente (G2 → G1 → G0)
    const list: C[] = [{ hash: 'M1', parents: ['M0'] }, { hash: 'M0', parents: [] },
      { hash: 'G2', parents: ['G1'] }, { hash: 'G1', parents: ['G0'] }, { hash: 'G0', parents: [] }];
    const c = colOf(list, runMain(list, ['M1']));
    assert.deepEqual([c.M1, c.M0], [0, 0]);
    assert.deepEqual([c.G2, c.G1, c.G0], [0, 0, 0], 'sin hueco a la izquierda para siempre');
  });

  test('con la rama principal sin ramas encima el grafo no cambia', () => {
    const list = linear(8);
    assert.deepEqual(runMain(list, ['c0']), computeGraph(list));
  });

  test('dos repos: la primera línea principal se queda con el carril 0 y la otra no choca', () => {
    const list: C[] = [{ hash: 'A2', parents: ['A1'] }, { hash: 'B2', parents: ['B1'] }, { hash: 'A1', parents: ['A0'] },
      { hash: 'B1', parents: ['B0'] }, { hash: 'A0', parents: [] }, { hash: 'B0', parents: [] }];
    const c = colOf(list, runMain(list, ['A2', 'B2']));
    assert.deepEqual([c.A2, c.A1, c.A0], [0, 0, 0]);
    assert.ok([c.B2, c.B1, c.B0].every(x => x >= 1));
  });

  test('arista larga en la línea principal: tras la flecha vuelve al carril 0', () => {
    // M1 → M0 queda a más de LONG_EDGE filas (una rama larga entre medias)
    const filler: C[] = Array.from({ length: 40 }, (_, i) => ({ hash: `F${i}`, parents: i < 39 ? [`F${i + 1}`] : ['M0'] }));
    const list: C[] = [{ hash: 'M1', parents: ['M0'] }, ...filler, { hash: 'M0', parents: [] }];
    const rows = runMain(list, ['M1']);
    const c = colOf(list, rows);
    assert.deepEqual([c.M1, c.M0], [0, 0]);
    assert.ok(rows.some(r => r.edges.some(e => e.kind === 'down' && e.from === 0)), 'se corta con flecha en el carril 0');
    assert.ok(rows.some(r => r.edges.some(e => e.kind === 'up' && e.from === 0)), 'reaparece en el carril 0');
    for (let i = 1; i <= 40; i++) { assert.ok(rows[i].col >= 1, `${list[i].hash} no usa el carril de main`); }
  });

  test('el color de la línea principal se conserva al unirse una rama', () => {
    const list: C[] = [{ hash: 'F1', parents: ['C1'] }, { hash: 'M', parents: ['C1'] }, { hash: 'C1', parents: [] }];
    const colorOf = (h: string): GraphColor | undefined => (h === 'M' ? MAIN_COLOR : h === 'F1' ? 5 : undefined);
    const rows = runMain(list, ['M'], false, colorOf);
    assert.equal(rows[1].color, MAIN_COLOR);
    assert.equal(rows[2].color, MAIN_COLOR, 'C1 sigue siendo de main aunque la rama lo esperara');
    assert.equal(rows[0].color, 5);
  });

  test('historias generadas: la línea principal siempre en el 0 y el grafo sigue siendo válido', () => {
    for (let seed = 1; seed <= 120; seed++) {
      const list = newestFirst(simulate(seed, 150, { octopus: seed % 3 === 0 }));
      // Una cabeza de rama cualquiera hace de main
      const hasChild = new Set(list.flatMap(c => c.parents));
      const heads = list.filter(c => !hasChild.has(c.hash));
      const tip = rng(seed).pick(heads).hash;
      for (const showLong of [false, true]) {
        const rows = runMain(list, [tip], showLong);
        const rowOf = new Map(list.map((c, i) => [c.hash, i]));
        for (const h of mainLineOf(list, tip)) {
          assert.equal(rows[rowOf.get(h)!].col, 0, `seed ${seed}: ${h} de la línea principal fuera del carril 0`);
        }
      }
    }
  });

  test('DAG aleatorio y órdenes topológicos aleatorios: sigue siendo válido', () => {
    for (let seed = 400; seed <= 440; seed++) {
      const dag = randomDag(seed, 150, seed % 2 ? 60 : 30);
      runMain(dag, [dag[rng(seed).int(Math.min(10, dag.length))].hash]);
      const topo = randomTopo(simulate(seed, 100, { maxBranches: 10 }), seed * 5);
      runMain(topo, [topo[rng(seed + 1).int(Math.min(6, topo.length))].hash], true);
    }
  });
});
