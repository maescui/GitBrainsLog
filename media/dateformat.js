// @ts-check
// Fecha con un patrón personalizado (jbGit.dateFormat = «custom», jbGit.dateFormatPattern), con las
// letras de JetBrains / Java: yyyy-MM-dd HH:mm, dd MMM yyyy, EEE h:mm a… El texto entre comillas
// simples sale tal cual ('at' → at; '' → '); cualquier otro carácter, también. Los nombres de mes
// y de día salen en el idioma de VS Code. Lo cargan el panel principal, Push y Compare.
(function () {
  const TOKEN = /'(?:[^']|'')*'|yyyy|yy|MMMM|MMM|MM|M|dd|d|EEEE|EEE|HH|H|hh|h|mm|m|ss|s|a/g;
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  /** @type {Record<string, Intl.DateTimeFormat>} */
  const names = {};
  /** Nombre de mes o de día de la semana en el idioma actual (con el formateador guardado). */
  const name = (/** @type {Date} */ d, /** @type {'month' | 'weekday'} */ part, /** @type {'long' | 'short'} */ style) =>
    (names[part + style] ||= new Intl.DateTimeFormat(undefined, { [part]: style })).format(d);

  /**
   * La fecha con el patrón: yyyy / yy (año), MMMM / MMM / MM / M (mes: nombre, abreviado, con dos
   * cifras o sin cero), dd / d (día), EEEE / EEE (día de la semana), HH / H (hora 0–23), hh / h
   * (hora 1–12), mm / m (minutos), ss / s (segundos), a (AM / PM).
   * @param {string} pattern
   * @param {Date} d
   */
  function format(pattern, d) {
    return String(pattern).replace(TOKEN, t => {
      switch (t) {
        case 'yyyy': return String(d.getFullYear()).padStart(4, '0');
        case 'yy': return pad(d.getFullYear() % 100);
        case 'MMMM': return name(d, 'month', 'long');
        case 'MMM': return name(d, 'month', 'short');
        case 'MM': return pad(d.getMonth() + 1);
        case 'M': return String(d.getMonth() + 1);
        case 'dd': return pad(d.getDate());
        case 'd': return String(d.getDate());
        case 'EEEE': return name(d, 'weekday', 'long');
        case 'EEE': return name(d, 'weekday', 'short');
        case 'HH': return pad(d.getHours());
        case 'H': return String(d.getHours());
        case 'hh': return pad(d.getHours() % 12 || 12);
        case 'h': return String(d.getHours() % 12 || 12);
        case 'mm': return pad(d.getMinutes());
        case 'm': return String(d.getMinutes());
        case 'ss': return pad(d.getSeconds());
        case 's': return String(d.getSeconds());
        case 'a': return d.getHours() < 12 ? 'AM' : 'PM';
        // Texto entre comillas: tal cual, con '' como comilla
        default: return t === "''" ? "'" : t.slice(1, -1).replace(/''/g, "'");
      }
    });
  }

  /**
   * La fecha absoluta: siempre dd/MM/yyyy, HH:mm (día primero y 24 horas), sea cual sea el idioma
   * de VS Code. La misma en el Log, Push y Compare / Show History.
   * @param {Date} d
   */
  const absolute = d => format('dd/MM/yyyy, HH:mm', d);

  /** @type {any} */ (window).jbDateFormat = { format, absolute };
})();
