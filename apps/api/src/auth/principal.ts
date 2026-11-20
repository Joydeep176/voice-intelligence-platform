import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/**
 * The authenticated principal. Phase 1 has only the development principal (AUTH_MODE=dev):
 * the identity provider is OD-08b and roles/authorisation are OD-27, both Open.
 */
export interface Principal {
  id: string;
  workspaceIds: readonly string[];
  kind: 'development';
}

export const PRINCIPAL = Symbol('principal');
export type RequestWithPrincipal = Request & { [PRINCIPAL]?: Principal };

export const CurrentPrincipal = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const principal = ctx.switchToHttp().getRequest<RequestWithPrincipal>()[PRINCIPAL];
  if (!principal) throw new Error('WorkspaceAccessGuard must run before CurrentPrincipal');
  return principal;
});
