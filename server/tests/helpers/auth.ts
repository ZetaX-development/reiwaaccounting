import { SignJWT } from 'jose';

const TEST_AUTH_USER_ID = 'test-user-id';
const TEST_SUPABASE_URL =
  process.env.SUPABASE_URL ?? 'https://test.supabase.co';
const TEST_JWT_SECRET =
  process.env.SUPABASE_JWT_SECRET ?? 'test-secret-32-chars-minimum-len!!';

export async function signTestToken(opts: {
  authUserId: string;
  email?: string;
}): Promise<string> {
  const secret = new TextEncoder().encode(TEST_JWT_SECRET);
  return new SignJWT({ sub: opts.authUserId, email: opts.email ?? 'test@example.com' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(`${TEST_SUPABASE_URL}/auth/v1`)
    .setAudience('authenticated')
    .setExpirationTime('1h')
    .sign(secret);
}

export async function authHeaders(
  authUserId: string = TEST_AUTH_USER_ID,
): Promise<{ Authorization: string }> {
  const token = await signTestToken({ authUserId });
  return { Authorization: `Bearer ${token}` };
}
