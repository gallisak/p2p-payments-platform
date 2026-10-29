import { randomUUID } from 'crypto';
import * as bcrypt from 'bcrypt';
import { User } from '../src/auth/entities/user.entity';
import { EmailNormalizer } from '../src/auth/email-normalizer';
import { IntegrationApp, createIntegrationApp } from './support/integration-app';

describe('Email letter case (integration)', () => {
  let ctx: IntegrationApp;

  beforeAll(async () => {
    ctx = await createIntegrationApp({ relay: false });
  });

  afterAll(async () => {
    await ctx.close();
  });

  const users = () => ctx.dataSource.getRepository(User);
  const register = (email: string) =>
    ctx.http().post('/auth/register').send({ email, password: 'password123' });
  const login = (email: string, password = 'password123') =>
    ctx.http().post('/auth/login').send({ email, password });

  it('stores emails in lowercase', async () => {
    const local = `Mixed.${randomUUID()}`;

    await register(`${local}@Example.COM`).expect(201);

    const stored = await users().findOneByOrFail({ email: `${local.toLowerCase()}@example.com` });
    expect(stored.email).toBe(stored.email.toLowerCase());
  });

  it('refuses to register the same email in another letter case', async () => {
    const email = `dup.${randomUUID()}@example.com`;
    await register(email).expect(201);

    await register(email.toUpperCase()).expect(409);

    expect(await users().countBy({ email })).toBe(1);
  });

  it('logs in with the email in any letter case', async () => {
    const email = `login.${randomUUID()}@example.com`;
    await register(email).expect(201);

    await login(email.toUpperCase()).expect(201);
    await login(`Login.${email.slice(6)}`).expect(201);
    await login(email.toUpperCase(), 'wrong-password').expect(401);
  });

  it('finds a recipient by the email in any letter case', async () => {
    const email = `recipient.${randomUUID()}@example.com`;
    await register(email).expect(201);
    const { id } = await users().findOneByOrFail({ email });

    const res = await ctx
      .internal('post', '/recipients', { email: email.toUpperCase(), currency: 'USD' })
      .expect(201);

    expect(res.body.ownerId).toBe(id);
  });

  it('lowercases emails stored before normalization, unless that would clash with another account', async () => {
    const passwordHash = await bcrypt.hash('password123', 4);
    const legacy = `Legacy.${randomUUID()}@Example.com`;
    const clash = `clash.${randomUUID()}@example.com`;
    await users().insert([
      { email: legacy, passwordHash },
      { email: clash, passwordHash },
      { email: clash.toUpperCase(), passwordHash },
    ]);

    await ctx.app.get(EmailNormalizer).onModuleInit();

    expect(await users().countBy({ email: legacy.toLowerCase() })).toBe(1);
    expect(await users().countBy({ email: legacy })).toBe(0);
    expect(await users().countBy({ email: clash })).toBe(1);
    expect(await users().countBy({ email: clash.toUpperCase() })).toBe(1);
    await login(legacy).expect(201);
    await login(clash.toUpperCase()).expect(201);
  });
});
