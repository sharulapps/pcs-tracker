import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
require('../public/plan-parser.js');
const { PlanParser } = globalThis;

// Same layout as "9.1 SEPTEMBER 26 PRODUCTION PLAN SUMMARY - M1 REV 1.xlsx"
function workbook() {
  const serial = d => (Date.UTC(2026, 8, d) / 86400000) + 25569;
  const rows = [
    ['SEPTEMBER 2026 PRODUCTION PLAN - M1'],
    ['DATE :', serial(-6)], ['REVISION :', 1], ['DOC NO :', 'FR-PROD-001'], [],
    ['MACHINE', 'MODEL', 'OUTPUT / HOURS', 'OPERATOR', serial(1), serial(2), serial(3)],
    [null, null, null, null, 'TUE', 'WED', 'THU'],
    ['P11', 'SAGA MC3 LO', 35, 'ZIARUL, KHOKAN', null, 'D-350\nN-350', 420],
    [null, 'SAGA MC3 HI', '22 (20)', null, 'D-120\nN-200', 'N-200', 'D-xx'],
    [null, 'IDLE MODEL', 30, null, null, null, null],
    ['HP 2', 'D63D FUC RH', 40, 'AZIZUL', 120, 400, 0],
    [null, 'NO OF MOLD CHANGE DAILY', null, null, 3, 2],
    [null, 'INCOMING', null, null, 999, 999, 999],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!merges'] = [{ s: { r: 7, c: 0 }, e: { r: 9, c: 0 } }, { s: { r: 7, c: 3 }, e: { r: 9, c: 3 } }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['MACHINE', 'MODEL']]), 'SEPTEMBER REV 0');
  XLSX.utils.book_append_sheet(wb, ws, 'SEPTEMBER REV 1');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x']]), 'NOTES');
  // round-trip so merges/dates look like a real file
  return XLSX.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
}

test('cell parsing: D / N marks and plain numbers', () => {
  assert.deepEqual(PlanParser.parseQtyCell('D-120\nN-200').parts, [{ shift: 'Day', qty: 120 }, { shift: 'Night', qty: 200 }]);
  assert.deepEqual(PlanParser.parseQtyCell('N-350').parts, [{ shift: 'Night', qty: 350 }]);
  assert.deepEqual(PlanParser.parseQtyCell(210).parts, [{ shift: 'Day', qty: 210 }]);
  assert.deepEqual(PlanParser.parseQtyCell(0).parts, []);
  assert.ok(PlanParser.parseQtyCell('D-xx').warning);
});

test('picks the highest REV sheet and extracts entries', () => {
  const wb = workbook();
  const p = PlanParser.parseWorkbook(XLSX, wb);
  assert.equal(p.sheet, 'SEPTEMBER REV 1');
  assert.equal(p.month, '2026-09');
  assert.equal(p.info.revision, '1'); assert.equal(p.info.docNo, 'FR-PROD-001'); assert.equal(p.info.issued, '2026-08-25');
  assert.deepEqual(p.dates, ['2026-09-01', '2026-09-02', '2026-09-03']);
  const hi = p.entries.filter(e => e.model === 'SAGA MC3 HI');
  assert.deepEqual(hi.map(e => [e.date, e.shift, e.qty]), [['2026-09-01', 'Day', 120], ['2026-09-01', 'Night', 200], ['2026-09-02', 'Night', 200]]);
  assert.equal(hi[0].machine, 'P11', 'merged machine cell fills down');
  assert.equal(hi[0].operator, undefined, 'operator comes from the PCS form, not the plan');
  assert.equal(hi[0].ratePerHour, 22);
  assert.equal(p.models.find(m => m.model === 'SAGA MC3 HI').ratePerHour, 22, 'bracket ignored');
  assert.equal(p.entries.filter(e => e.machine === 'HP 2').reduce((s, e) => s + e.qty, 0), 520);
  assert.ok(!p.entries.some(e => e.model === 'INCOMING'), 'stops at NO OF MOLD CHANGE');
  assert.equal(p.warnings.length, 1);
  assert.equal(p.entries.reduce((s, e) => s + e.qty, 0), 350 + 350 + 420 + 120 + 200 + 200 + 120 + 400);
});
