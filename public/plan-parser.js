/*
 * Parses the monthly PRODUCTION PLAN SUMMARY workbook (doc FR-PROD-001).
 *
 * Layout it expects (one sheet per revision, e.g. "SEPTEMBER REV 1"):
 *   A1            title, e.g. "SEPTEMBER 2026 PRODUCTION PLAN - M1"
 *   A3/B3         "REVISION :" / 1
 *   header row    MACHINE | MODEL | OUTPUT / HOURS | OPERATOR | <date> <date> ... | TOTAL
 *   data rows     machine (merged down its group), model, rate, daily qty
 *                 OUTPUT / HOURS "70 (55)" is read as 70 (bracket ignored).
 *                 OPERATOR is not imported; the operator comes from the PCS form.
 *   end           "NO OF MOLD CHANGE DAILY" row or the first fully blank row
 *
 * Daily cells:
 *   210                  -> Day shift 210 pcs (no shift marked)
 *   "D-120\nN-200"       -> Day 120 + Night 200
 *   "N-350"              -> Night 350
 *
 * Works in the browser (window.PlanParser) and in Node (globalThis.PlanParser).
 */
(function (root) {
  'use strict';

  const norm = v => String(v ?? '').replace(/\s+/g, ' ').trim();
  const up = v => norm(v).toUpperCase();

  function serialToISO(n) {
    // Excel 1900 date system; 25569 = 1970-01-01
    const d = new Date(Math.round((n - 25569) * 86400000));
    return d.toISOString().slice(0, 10);
  }
  function cellISO(c) {
    if (!c) return null;
    if (c.t === 'n' && c.v > 30000 && c.v < 80000) return serialToISO(c.v);
    if (c.t === 'd' && c.v instanceof Date) return c.v.toISOString().slice(0, 10);
    return null;
  }

  /** Parse one daily cell into [{shift, qty}] plus an optional warning. */
  function parseQtyCell(v) {
    if (v === null || v === undefined || v === '') return { parts: [] };
    if (typeof v === 'number') return { parts: v > 0 ? [{ shift: 'Day', qty: Math.round(v) }] : [] };
    const s = String(v).trim();
    if (!s) return { parts: [] };
    if (/^\d+(\.\d+)?$/.test(s)) return parseQtyCell(Number(s));
    const parts = [];
    const re = /\b([DN])\s*[-–:=]?\s*(\d+)/gi;
    let m;
    while ((m = re.exec(s))) {
      const qty = Number(m[2]);
      if (qty > 0) parts.push({ shift: m[1].toUpperCase() === 'N' ? 'Night' : 'Day', qty });
    }
    if (!parts.length) return { parts: [], warning: `Unreadable plan cell "${s.replace(/\n/g, ' / ')}"` };
    return { parts };
  }

  function sheetGrid(XLSX, ws) {
    const ref = ws['!ref'];
    if (!ref) return null;
    const range = XLSX.utils.decode_range(ref);
    const get = (r, c) => ws[XLSX.utils.encode_cell({ r, c })];
    // Fill merged ranges with their top-left cell (the machine column is merged).
    const merged = new Map();
    (ws['!merges'] || []).forEach(m => {
      const tl = get(m.s.r, m.s.c);
      if (!tl) return;
      for (let r = m.s.r; r <= m.e.r; r++) for (let c = m.s.c; c <= m.e.c; c++) if (r !== m.s.r || c !== m.s.c) merged.set(r + ':' + c, tl);
    });
    return { range, cell: (r, c) => get(r, c) || merged.get(r + ':' + c) };
  }

  function findHeader(XLSX, ws) {
    const g = sheetGrid(XLSX, ws);
    if (!g) return null;
    for (let r = g.range.s.r; r <= Math.min(g.range.e.r, 40); r++) {
      for (let c = g.range.s.c; c <= Math.min(g.range.e.c, 10); c++) {
        if (up(g.cell(r, c)?.v) === 'MACHINE') return { g, r, c };
      }
    }
    return null;
  }

  /** Pick the sheet to import: visible plan sheets, highest "REV n" wins, else the last one. */
  function pickSheet(XLSX, wb) {
    const sheets = (wb.Workbook && wb.Workbook.Sheets) || [];
    const candidates = wb.SheetNames.filter((name, i) => !(sheets[i] && sheets[i].Hidden) && findHeader(XLSX, wb.Sheets[name]));
    if (!candidates.length) return null;
    const rev = n => { const m = n.match(/REV\s*(\d+)/i); return m ? Number(m[1]) : -1; };
    return candidates.slice().sort((a, b) => rev(a) - rev(b) || candidates.indexOf(a) - candidates.indexOf(b)).pop();
  }

  function parseSheet(XLSX, wb, sheetName) {
    const ws = wb.Sheets[sheetName];
    const h = findHeader(XLSX, ws);
    if (!h) throw new Error(`Sheet "${sheetName}" has no MACHINE header row.`);
    const { g, r: hr } = h;
    const col = {};
    const dateCols = [];
    for (let c = g.range.s.c; c <= g.range.e.c; c++) {
      const cell = g.cell(hr, c);
      const t = up(cell?.v);
      if (t === 'MACHINE') col.machine = c;
      else if (t === 'MODEL') col.model = c;
      else if (t.startsWith('OUTPUT')) col.rate = c;
      else { const iso = cellISO(cell); if (iso) dateCols.push({ c, date: iso }); }
    }
    if (col.model === undefined || !dateCols.length) throw new Error(`Sheet "${sheetName}" is missing the MODEL column or date columns.`);

    // Header info above the table
    const info = { title: '', revision: '', docNo: '', issued: '' };
    for (let r = g.range.s.r; r < hr; r++) {
      const k = up(g.cell(r, 0)?.v), v = g.cell(r, 1);
      if (r === g.range.s.r && k) info.title = norm(g.cell(r, 0).v);
      if (k.startsWith('REVISION')) info.revision = norm(v?.v);
      else if (k.startsWith('DOC NO')) info.docNo = norm(v?.v);
      else if (k === 'DATE :' || k === 'DATE:' || k === 'DATE') info.issued = cellISO(v) || norm(v?.v);
    }

    const entries = [];
    const warnings = [];
    const models = [];
    for (let r = hr + 1; r <= g.range.e.r; r++) {
      const machine = norm(g.cell(r, col.machine ?? 0)?.v);
      const model = norm(g.cell(r, col.model)?.v);
      if (/MOLD CHANGE/i.test(model) || /MOLD CHANGE/i.test(machine)) break;
      if (!machine && !model) {
        if (models.length) break; // first blank row after the table
        continue;
      }
      if (!model) continue;
      const rateRaw = norm(g.cell(r, col.rate)?.v);
      const rate = Number((rateRaw.match(/\d+(\.\d+)?/) || [0])[0]);
      const row = { machine: machine || '(no machine)', model, ratePerHour: rate, total: 0 };
      models.push(row);
      for (const { c, date } of dateCols) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        const { parts, warning } = parseQtyCell(cell?.v);
        if (warning) warnings.push(`${XLSX.utils.encode_cell({ r, c })} ${row.machine} / ${model}, ${date}: ${warning}`);
        parts.forEach(p => {
          row.total += p.qty;
          entries.push({
            date, shift: p.shift, machine: row.machine, model, ratePerHour: rate, qty: p.qty,
            planHours: rate > 0 ? Math.round((p.qty / rate) * 10) / 10 : null,
          });
        });
      }
    }
    const months = [...new Set(entries.map(e => e.date.slice(0, 7)))];
    const month = months.sort((a, b) => entries.filter(e => e.date.startsWith(b)).length - entries.filter(e => e.date.startsWith(a)).length)[0]
      || dateCols[0].date.slice(0, 7);
    return { sheet: sheetName, month, info, dates: dateCols.map(d => d.date), models, entries, warnings };
  }

  function parseWorkbook(XLSX, wb, sheetName) {
    const name = sheetName || pickSheet(XLSX, wb);
    if (!name) throw new Error('No sheet with a MACHINE / MODEL / OUTPUT / HOURS header was found.');
    return parseSheet(XLSX, wb, name);
  }

  root.PlanParser = { parseWorkbook, pickSheet, parseQtyCell, serialToISO };
})(typeof window !== 'undefined' ? window : globalThis);
