import { z } from 'zod';
import { DesktopAuthenticationError } from './client';

const WorkspaceSummarySchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(120),
  timezone: z.string().min(1).max(80),
  role: z.enum(['ADMIN', 'MEMBER']),
  tree: z.object({
    id: z.uuid(),
    name: z.string().min(1).max(120),
  }),
});

const WorkspaceListResponseSchema = z.object({
  workspaces: z.array(WorkspaceSummarySchema).max(1_000),
});

export type DesktopWorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>;

export class WorkspaceAuthenticationRequiredError extends Error {
  constructor() {
    super('登录会话已失效，请重新登录。');
    this.name = 'WorkspaceAuthenticationRequiredError';
  }
}

export class WorkspaceDiscoveryError extends Error {
  constructor(message = '无法读取团队空间，请稍后重试。') {
    super(message);
    this.name = 'WorkspaceDiscoveryError';
  }
}

type RequestImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function listAuthenticatedWorkspaces(
  apiUrl: string,
  getAccessCredential: () => Promise<string | null>,
  request: RequestImplementation = fetch,
): Promise<DesktopWorkspaceSummary[]> {
  let credential: string | undefined;
  try {
    credential = (await getAccessCredential())?.trim();
  } catch (error) {
    if (error instanceof DesktopAuthenticationError && error.code === 'AUTHENTICATION_REQUIRED') {
      throw new WorkspaceAuthenticationRequiredError();
    }
    throw new WorkspaceDiscoveryError(error instanceof Error ? error.message : undefined);
  }
  if (!credential) throw new WorkspaceAuthenticationRequiredError();

  let response: Response;
  try {
    response = await request(new URL('/v1/workspaces', apiUrl), {
      method: 'GET',
      headers: { authorization: `Bearer ${credential}` },
    });
  } catch {
    throw new WorkspaceDiscoveryError();
  }
  if (response.status === 401 || response.status === 403) {
    throw new WorkspaceAuthenticationRequiredError();
  }
  if (!response.ok) throw new WorkspaceDiscoveryError();

  try {
    return WorkspaceListResponseSchema.parse(await response.json()).workspaces;
  } catch {
    throw new WorkspaceDiscoveryError('团队空间响应格式无效，请联系管理员。');
  }
}

export function chooseInitialWorkspace(
  workspaces: readonly DesktopWorkspaceSummary[],
  preferredWorkspaceId: string | undefined,
): string | null {
  if (
    preferredWorkspaceId !== undefined &&
    workspaces.some((workspace) => workspace.id === preferredWorkspaceId)
  ) {
    return preferredWorkspaceId;
  }
  return workspaces.length === 1 ? workspaces[0]!.id : null;
}
