import { DuckDBInstance, StatementType } from '@duckdb/node-api';
import { createHash } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const digest = 'ea77a4234cd01060bdf0c8c7f4a18e64dac283c8630a25de4a205936413f6a12';
const url = 'https://github.com/jump-cellpainting/datasets/releases/download/v0.13/jump_metadata.duckdb';
let instance: Promise<DuckDBInstance> | undefined;

async function openDatabase() {
  const path = process.env.JUMP_DATABASE_PATH || join(tmpdir(), 'jump-v0.13.duckdb');
  if (!process.env.JUMP_DATABASE_PATH) {
    let bytes: Buffer | undefined;
    try { bytes = await readFile(path); } catch { /* Download on first invocation. */ }
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== digest) {
      const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
      if (!response.ok) throw new Error('Could not download the JUMP release database.');
      bytes = Buffer.from(await response.arrayBuffer());
      if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('Database checksum mismatch.');
      await writeFile(path + '.partial', bytes);
      await rename(path + '.partial', path);
    }
  }
  return DuckDBInstance.create(path, {
    access_mode: 'READ_ONLY', enable_external_access: 'false',
    autoinstall_known_extensions: 'false', autoload_known_extensions: 'false',
    allow_community_extensions: 'false', memory_limit: '256MB',
    max_temp_directory_size: '0B', threads: '2', lock_configuration: 'true',
  });
}

export async function database() {
  instance ??= openDatabase().catch(error => { instance = undefined; throw error; });
  return instance;
}

export async function schema() {
  const connection = await (await database()).connect();
  try {
    const columns = await connection.runAndReadAll(`
      SELECT table_name, column_name, data_type, comment
      FROM duckdb_columns() WHERE schema_name = 'main' AND NOT internal
      ORDER BY table_name, column_index`);
    return JSON.stringify(columns.getRowObjectsJson()) + '\n' +
      'well has one row per (Metadata_Plate, Metadata_Well). Join well to plate using Metadata_Plate; ' +
      'join perturbation tables using Metadata_JCP2022. Gene comparisons across CRISPR and ORF use Metadata_NCBI_Gene_ID, not JCP2022 IDs. ' +
      'perturbation_control is the canonical control annotation. DMSO is Metadata_Name = DMSO there. ' +
      'Compound names are only available for controls; other compounds have IDs and structures. ' +
      'This database contains metadata only: no images, morphology features, profiles, phenotypic effect sizes, dose or treatment time. ' +
      'Source IDs are anonymized. Counts of wells, plates, constructs and unique genes are different quantities.';
  } finally { connection.closeSync(); }
}

export async function query(sql: string) {
  if (!sql.trim() || sql.length > 12000) throw new Error('SQL must contain 1 to 12,000 characters.');
  const connection = await (await database()).connect();
  let expired = false;
  const timer = setTimeout(() => { expired = true; connection.interrupt(); }, 8000);
  try {
    const statements = await connection.extractStatements(sql);
    if (statements.count !== 1) throw new Error('Only one SELECT query is allowed.');
    const prepared = await statements.prepare(0);
    if (prepared.statementType !== StatementType.SELECT) throw new Error('Only SELECT queries are allowed.');
    prepared.destroySync();
    const bounded = sql.trim().replace(/;\s*$/, '');
    const result = await connection.runAndReadAll(`SELECT * FROM (${bounded}\n) AS answer LIMIT 201`);
    const rows = result.getRowsJson();
    const output = { columns: result.columnNames(), rows: rows.slice(0, 200), truncated: rows.length > 200 };
    if (JSON.stringify(output).length > 1000000) throw new Error('Results exceed 1 MB. Select fewer or smaller columns.');
    return output;
  } catch (error) {
    if (expired) throw new Error('Query exceeded the 8-second execution limit.');
    throw error;
  } finally { clearTimeout(timer); connection.closeSync(); }
}
