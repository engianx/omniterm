import type { Session } from '../../plugins/terminal/lib/sessions.js';

interface JsonStatusResponse {
  status(code: number): JsonStatusResponse;
  json(value: unknown): unknown;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sendWorktreeSessionReadinessError(
  res: JsonStatusResponse,
  session: Pick<Session, 'id'>,
  error: unknown,
  deleteSession: (id: string) => boolean,
): void {
  deleteSession(session.id);
  res.status(503).json({ error: errorMessage(error) });
}
