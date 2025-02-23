import type {
  AffectedRowsResult,
  DatabaseColumn,
  MutationOrQueryBaseOptions,
  QueryError,
  QueryResult,
} from '@/types/data-browser';
import normalizeQueryError from '@/utils/dataBrowser/normalizeQueryError';
import prepareCreateColumnQuery from './prepareCreateColumnQuery';

export interface CreateColumnVariables {
  /**
   * The column to create.
   */
  column: DatabaseColumn;
}

export interface CreateColumnOptions extends MutationOrQueryBaseOptions {}

export default async function createColumn({
  dataSource,
  schema,
  table,
  appUrl,
  adminSecret,
  column,
}: CreateColumnOptions & CreateColumnVariables) {
  const args = prepareCreateColumnQuery({
    dataSource,
    schema,
    table,
    column,
  });

  const response = await fetch(`${appUrl}/v2/query`, {
    method: 'POST',
    headers: {
      'x-hasura-admin-secret': adminSecret,
    },
    body: JSON.stringify({
      args,
      type: 'bulk',
      version: 1,
    }),
  });

  const responseData: [AffectedRowsResult, QueryResult<string[]>] | QueryError =
    await response.json();

  if (response.ok) {
    return;
  }

  const normalizedError = normalizeQueryError(responseData);

  throw new Error(normalizedError);
}
