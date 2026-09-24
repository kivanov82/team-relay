#!/usr/bin/env node
// Synthetic capability runner for tests and the e2e suite. Reads one JSON line on stdin,
// reports two progress lines on stderr, prints one JSON value on stdout. Fake data only.

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', async () => {
  const req = JSON.parse(input.trim().split('\n')[0]);
  const pause = () => new Promise((r) => setTimeout(r, 50));
  process.stderr.write(`${JSON.stringify({ progress: 'connecting to the fake staging database', pct: 10 })}\n`);
  await pause();
  process.stderr.write(`${JSON.stringify({ progress: 'reading rows', pct: 60 })}\n`);
  await pause();
  process.stderr.write('fake runner: done\n');

  let result;
  if (req.capability === 'staging_db_query') {
    // Three synthetic rows, narrowed by the structured field/op/value filter when one is given.
    const all = Array.from({ length: 3 }, (_, i) => ({
      id: i + 1,
      dataset: req.params.dataset,
      status: i % 2 === 0 ? 'active' : 'inactive',
    }));
    const { field, op = 'eq', value } = req.params;
    const compare = (a, b) => (typeof a === 'number' ? a - Number(b) : String(a).localeCompare(String(b)));
    const keep = (row) => {
      if (field === undefined || value === undefined || !(field in row)) return field === undefined;
      const c = compare(row[field], value);
      return op === 'eq' ? c === 0 : op === 'ne' ? c !== 0 : op === 'lt' ? c < 0 : c > 0;
    };
    const rows = all.filter(keep).slice(0, req.params.limit ?? 20);
    result = { capability: req.capability, request_id: req.request_id, dataset: req.params.dataset, rows, row_count: rows.length };
  } else if (req.capability === 'service_health') {
    result = { capability: req.capability, service: req.params.service, healthy: true, recent_errors: 0 };
  } else {
    result = { capability: req.capability, ok: true };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
});
