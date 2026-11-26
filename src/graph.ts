/**
 * Asignación de carriles (lanes) para dibujar el grafo de commits.
 *
 * Cada fila del log se dibuja de forma independiente como un SVG de alto fijo.
 * Para cada fila se calculan:
 *  - col:   carril donde va el punto del commit
 *  - edges: segmentos a dibujar en esa fila
 *      'pass' → línea vertical completa (otra rama que pasa por aquí)
 *      'in'   → de arriba (carril from) al punto del commit (carril to)
 *      'out'  → del punto del commit (from) hacia abajo (carril to), hacia un padre
 *      'down' → arista larga que se corta aquí con una flecha hacia abajo (jump = padre)
 *      'up'   → arista larga que reaparece aquí con una flecha hacia arriba (jump = hijo)
 *
 * Aristas largas (como JetBrains): una arista que une commits a más de LONG_EDGE filas
 * de distancia solo se pinta en sus extremos, con una flecha, y entre medias no ocupa
 * carril. Así, con muchas ramas o muchos repos juntos, el grafo no se come el ancho.
 */

export interface Edge {
  kind: 'pass' | 'in' | 'out' | 'down' | 'up';
  from: number;
  to: number;
  color: GraphColor;
  jump?: string; // en 'down' y 'up': commit del otro extremo
}

/**
 * Color de un carril: un índice de la paleta del webview (PALETTE en main.js, módulo su
 * longitud) o un color #rrggbb elegido por el usuario para esa rama (jbGit.branchColors).
 */
export type GraphColor = number | string;

export interface GraphRow {
  col: number;
  color: GraphColor;
  width: number; // número de carriles usados en la fila
  edges: Edge[];
}

/** Filas a partir de las cuales una arista se considera larga (el mismo valor que JetBrains). */
export const LONG_EDGE = 30;

/**
 * Colores de la paleta del webview (PALETTE en main.js). Los carriles sin rama (p. ej. el
 * segundo padre de un merge cuya rama ya se borró) no usan MAIN_COLOR, el de main/master.
 */
const PALETTE_SIZE = 10;
/** Color automático de main y master: el 3 de la paleta (amarillo, #D4A72C). */
export const MAIN_COLOR = 3;

/**
 * colorOf(hash): color fijo del carril que empieza en ese commit (porque una rama apunta a
 * él), para que una rama tenga siempre el mismo color, en todos los repos y en cada
 * recarga. Si devuelve undefined, el carril toma el siguiente color de la paleta.
 *
 * mainTips: los commits a los que apunta main/master (uno por repo). Su línea principal (la
 * cadena de primeros padres) va siempre en el carril 0, a la izquierda del todo, aunque haya
 * ramas más nuevas que main o que salgan de ella: el carril 0 se reserva hasta el último commit
 * de esa línea, las demás ramas empiezan en el 1 y, si una espera a un commit de la línea
 * principal, su línea se une a ella en ese punto. Si hay varios repos solo la línea principal que
 * aparece primero (la punta más nueva) se queda con el carril 0; las de los demás se colocan
 * como cualquier otra rama, para que no salten de un carril a otro al terminar la primera.
 */
export function computeGraph(commits: { hash: string; parents: string[] }[], showLongEdges = false,
  colorOf: (hash: string) => GraphColor | undefined = () => undefined, mainTips: string[] = []): GraphRow[] {
  const n = commits.length;
  const rowOf = new Map(commits.map((c, i) => [c.hash, i]));
  // La línea principal: de la punta de main que sale primero, sus primeros padres (los mismos que
  // seguirá el bucle). Solo una: el carril 0 no se puede repartir entre varias
  const mainLine = new Set<string>();
  let lastMain = -1;
  const tipRows = mainTips.map(t => rowOf.get(t)).filter((r): r is number => r !== undefined);
  let row: number | undefined = tipRows.length ? Math.min(...tipRows) : undefined;
  while (row !== undefined && !mainLine.has(commits[row].hash)) {
    mainLine.add(commits[row].hash);
    lastMain = Math.max(lastMain, row);
    const next: string | undefined = commits[row].parents.filter(p => (rowOf.get(p) ?? n) > row!)[0];
    row = next === undefined ? undefined : rowOf.get(next);
  }
  let cur = 0;                            // fila que se está procesando
  const lanes: (string | null)[] = [];
  const laneColor: GraphColor[] = [];
  const laneCut: number[] = [];      // fila en la que el carril se corta con flecha (-1 = nunca)
  const laneChild: string[] = [];    // commit que abrió el carril (destino de la flecha de subida)
  const pending = new Map<number, { hash: string; color: GraphColor; child: string }[]>(); // fila → aristas que reaparecen
  const parked = new Set<string>();  // padres con una arista ya aparcada (las demás convergen en ella)
  let nextColor = 1;
  const anonColor = (): number => {
    if (nextColor % PALETTE_SIZE === MAIN_COLOR) { nextColor++; }
    return nextColor++;
  };
  const rows: GraphRow[] = [];

  // Primer carril libre; el 0 se reserva para la línea principal mientras le quede algún commit
  const freeSlot = (): number => {
    const from = cur <= lastMain ? 1 : 0;
    for (let k = from; k < lanes.length; k++) { if (lanes[k] === null) { return k; } }
    while (lanes.length < from) { lanes.push(null); }
    lanes.push(null);
    return lanes.length - 1;
  };

  for (let i = 0; i < n; i++) {
    const c = commits[i];
    cur = i;

    // Aristas largas que reaparecen en esta fila (su padre está en la siguiente)
    const upLanes = new Map<number, string>();
    for (const p of pending.get(i) ?? []) {
      // La línea principal vuelve al carril 0
      const j = mainLine.has(p.hash) && (lanes[0] ?? null) === null ? 0 : freeSlot();
      lanes[j] = p.hash;
      laneColor[j] = p.color;
      laneCut[j] = -1;
      upLanes.set(j, p.child);
    }
    pending.delete(i);

    // Carril que espera a h (sin contar los que se cortan en esta fila: se van a liberar)
    const laneOf = (h: string): number => {
      for (let k = 0; k < lanes.length; k++) {
        if (lanes[k] === h && laneCut[k] !== i) { return k; }
      }
      return -1;
    };
    // Al abrir un carril hacia un padre, si está lejos se marca para cortarlo en la fila siguiente
    const open = (k: number, parent: string) => {
      const target = rowOf.get(parent) ?? n;
      laneCut[k] = !showLongEdges && target - i > LONG_EDGE ? i + 1 : -1;
      laneChild[k] = c.hash;
    };

    let col = lanes.indexOf(c.hash);
    if (mainLine.has(c.hash) && col !== 0 && (lanes[0] ?? null) === null) {
      // La línea principal va en el carril 0, aunque una rama la esperara en otro (esa rama se une
      // aquí) o sea una cabeza de rama que abriría un carril a la derecha
      laneColor[0] = colorOf(c.hash) ?? (col >= 0 ? laneColor[col] : anonColor());
      col = 0;
    } else if (col === -1) {
      // Commit sin hijos cargados: cabeza de rama, abre un carril nuevo
      col = freeSlot();
      laneColor[col] = colorOf(c.hash) ?? anonColor();
    }
    const color = laneColor[col];
    const before = lanes.slice();
    const edges: Edge[] = [];

    // Todas las líneas que llegan a este commit desde arriba
    for (let k = 0; k < before.length; k++) {
      if (before[k] === c.hash) {
        edges.push({ kind: 'in', from: k, to: col, color: laneColor[k] });
        lanes[k] = null;
      }
    }

    // Primer padre: continúa en el mismo carril (si nadie lo está esperando ya)
    // Un padre que ya salió más arriba (orden incorrecto) no se puede unir hacia abajo: se
    // ignora, en vez de dejar un carril abierto hasta el final del log. Los que no están
    // cargados sí siguen (bajan hasta el final o se cortan en flecha).
    const [first, ...rest] = c.parents.filter(p => (rowOf.get(p) ?? n) > i);
    if (first !== undefined) {
      // Si otro carril a la derecha ya espera a este padre, nos quedamos con el carril
      // de la izquierda y ambos convergen al llegar al padre (como en JetBrains).
      const existing = laneOf(first);
      if (existing === -1 || existing > col) {
        lanes[col] = first;
        laneColor[col] = color;
        open(col, first);
        edges.push({ kind: 'out', from: col, to: col, color });
      } else {
        edges.push({ kind: 'out', from: col, to: existing, color: laneColor[existing] });
      }
    }

    // Padres adicionales (merges): cada uno a su carril
    for (const p of rest) {
      let j = laneOf(p);
      if (j === -1) {
        j = freeSlot();
        lanes[j] = p;
        laneColor[j] = colorOf(p) ?? anonColor();
        open(j, p);
      }
      edges.push({ kind: 'out', from: col, to: j, color: laneColor[j] });
    }

    // Carriles que simplemente atraviesan la fila (o que aparecen o se cortan en ella)
    for (let k = 0; k < before.length; k++) {
      const h = before[k];
      if (h === null || h === c.hash || lanes[k] !== h) { continue; }
      if (upLanes.has(k)) {
        edges.push({ kind: 'up', from: k, to: k, color: laneColor[k], jump: upLanes.get(k) });
      } else if (laneCut[k] === i) {
        edges.push({ kind: 'down', from: k, to: k, color: laneColor[k], jump: h });
        lanes[k] = null;
        laneCut[k] = -1;
        const target = rowOf.get(h);
        // Si el padre no está cargado, la arista se queda en la flecha de bajada
        if (target !== undefined && !parked.has(h)) {
          parked.add(h);
          const list = pending.get(target - 1) ?? [];
          list.push({ hash: h, color: laneColor[k], child: laneChild[k] });
          pending.set(target - 1, list);
        }
      } else {
        edges.push({ kind: 'pass', from: k, to: k, color: laneColor[k] });
      }
    }

    while (lanes.length && lanes[lanes.length - 1] === null) {
      lanes.pop();
    }

    rows.push({ col, color, width: Math.max(before.length, lanes.length, col + 1), edges });
  }

  return rows;
}
