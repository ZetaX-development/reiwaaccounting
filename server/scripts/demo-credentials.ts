/** Read explicitly supplied credentials without logging their values. */
export function readDemoCredentials(source: Record<string, string | undefined>) {
  const email = source.DEMO_EMAIL?.trim();
  const password = source.DEMO_PASSWORD;
  if (!email || !password?.trim()) {
    throw new Error('DEMO_EMAIL and DEMO_PASSWORD must both be explicitly set');
  }
  return { email, password };
}
