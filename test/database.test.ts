import assert from 'node:assert/strict';
import { test } from 'node:test';
import { query } from '../lib/database.ts';

test('queries the real release and bounds results', async () => {
  assert.deepEqual((await query('SELECT count(*) AS wells FROM well')).rows, [['1151808']]);
  const rows = await query('SELECT * FROM well');
  assert.equal(rows.rows.length, 200);
  assert.equal(rows.truncated, true);
  const controls = await query("SELECT count(*) AS n FROM well JOIN perturbation_control USING (Metadata_JCP2022) WHERE Metadata_Name = 'DMSO'");
  assert.ok(Number(controls.rows[0][0]) > 0);
});

test('rejects writes, multiple statements, file reads and configuration changes', async () => {
  for (const sql of [
    'SELECT 1; SELECT 2',
    'DELETE FROM well',
    'CREATE TABLE stolen AS SELECT 1',
    "COPY (SELECT 1) TO '/tmp/ask-jump-test.csv'",
    "SELECT * FROM read_csv('/etc/passwd')",
    "SELECT * FROM read_csv('https://example.com/data.csv')",
    'SET enable_external_access = true',
    'INSTALL httpfs',
  ]) await assert.rejects(query(sql), undefined, sql);
  assert.deepEqual((await query('SELECT count(*) AS wells FROM well')).rows, [['1151808']]);
});

test('interrupts an expensive query and leaves subsequent queries usable', async () => {
  await assert.rejects(
    query('SELECT sum(sin(a.i * b.i)) FROM range(100000000) a(i), range(100000000) b(i)'),
    /8-second execution limit/,
  );
  assert.deepEqual((await query('SELECT 1 AS ok')).rows, [[1]]);
});
