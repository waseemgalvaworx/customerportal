// The shared backend uses camelCase column names (e.g. `updatedAt`, `jobNumber`)
// but this portal's UI was written expecting snake_case (e.g. `updated_at`, `job_number`).
// This helper converts a row's camelCase keys to snake_case while keeping the
// originals intact, so both shapes work everywhere.

const camelToSnake = (s: string) =>
  s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());

export function normalizeRow<T extends Record<string, any>>(row: T | null | undefined): T {
  if (!row || typeof row !== 'object') return row as T;
  const out: Record<string, any> = { ...row };
  for (const key of Object.keys(row)) {
    if (/[A-Z]/.test(key)) {
      const snake = camelToSnake(key);
      if (!(snake in out)) out[snake] = (row as any)[key];
    }
  }
  return out as T;
}

export function normalizeRows<T extends Record<string, any>>(rows: T[] | null | undefined): T[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => normalizeRow(r));
}
