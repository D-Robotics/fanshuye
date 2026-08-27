import {
  WorkspaceAuthenticationRequiredError,
  chooseInitialWorkspace,
  listAuthenticatedWorkspaces,
  type DesktopWorkspaceSummary,
} from './workspaces';

const first: DesktopWorkspaceSummary = {
  id: '11111111-1111-4111-8111-111111111111',
  name: '平台组',
  timezone: 'Asia/Shanghai',
  role: 'ADMIN',
  tree: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: '团队任务树' },
};
const second: DesktopWorkspaceSummary = {
  ...first,
  id: '22222222-2222-4222-8222-222222222222',
  name: '客户端组',
  role: 'MEMBER',
};

describe('desktop workspace discovery', () => {
  it('uses the sole membership and requires an explicit choice for multiple memberships', () => {
    expect(chooseInitialWorkspace([first], undefined)).toBe(first.id);
    expect(chooseInitialWorkspace([first, second], undefined)).toBeNull();
    expect(chooseInitialWorkspace([first, second], second.id)).toBe(second.id);
    expect(chooseInitialWorkspace([first, second], 'not-a-membership')).toBeNull();
    expect(chooseInitialWorkspace([], undefined)).toBeNull();
  });

  it('loads and validates the authenticated membership list without exposing the token', async () => {
    const request = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ workspaces: [first] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(
      listAuthenticatedWorkspaces(
        'https://api.fanshuye.test',
        () => Promise.resolve('access-credential-123456789'),
        request,
      ),
    ).resolves.toEqual([first]);
    expect(request).toHaveBeenCalledWith(
      new URL('https://api.fanshuye.test/v1/workspaces'),
      expect.objectContaining({
        headers: { authorization: 'Bearer access-credential-123456789' },
      }),
    );
  });

  it('turns missing and rejected credentials into a safe authentication boundary', async () => {
    const unauthorized = vi.fn(() => Promise.resolve(new Response(null, { status: 401 })));
    await expect(
      listAuthenticatedWorkspaces('https://api.fanshuye.test', () => Promise.resolve(null)),
    ).rejects.toBeInstanceOf(WorkspaceAuthenticationRequiredError);
    await expect(
      listAuthenticatedWorkspaces(
        'https://api.fanshuye.test',
        () => Promise.resolve('access-credential-123456789'),
        unauthorized,
      ),
    ).rejects.toBeInstanceOf(WorkspaceAuthenticationRequiredError);
  });
});
