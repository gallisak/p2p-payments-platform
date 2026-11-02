import WalletsPage from '@/app/wallets/page';

jest.mock('next/headers', () => ({
  cookies: () => ({
    get: (name: string) => (name === 'accessToken' ? { value: 'session-token' } : undefined),
  }),
}));

describe('Wallets page', () => {
  it('sends the access token from the session cookie to the ledger', async () => {
    const fetchMock = jest.fn(async (_url: string, _init: RequestInit) => new Response('[]'));
    global.fetch = fetchMock as unknown as typeof fetch;

    await WalletsPage();

    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer session-token');
  });
});
