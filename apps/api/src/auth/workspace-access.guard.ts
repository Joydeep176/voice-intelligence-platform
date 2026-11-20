import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { AppException } from '../common/app-exception';
import { PRINCIPAL, type RequestWithPrincipal } from './principal';

const uuid = z.uuid();

/**
 * Workspace scoping for every `/workspaces/:workspaceId` route (ADR-0003, SEC-2).
 * Non-members and malformed IDs get 404, so workspace existence is not disclosed.
 *
 * NOT production authentication: in AUTH_MODE=dev every request is the local development
 * principal, a member of DEV_WORKSPACE_ID only. The API refuses to start in production.
 */
@Injectable()
export class WorkspaceAccessGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const workspaceId = req.params.workspaceId;
    const principal = {
      id: this.config.auth.devPrincipalId,
      workspaceIds: [this.config.auth.devWorkspaceId],
      kind: 'development' as const,
    };
    if (
      typeof workspaceId !== 'string' ||
      !uuid.safeParse(workspaceId).success ||
      !principal.workspaceIds.includes(workspaceId)
    ) {
      throw AppException.notFound('Workspace');
    }
    req[PRINCIPAL] = principal;
    return true;
  }
}
