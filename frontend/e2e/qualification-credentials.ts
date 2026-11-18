/** Match the password explicitly injected into qualification bootstrap. */
export function qualificationPassword(): string {
  const password = process.env.QUALIFICATION_ADMIN_PASSWORD;
  if (!password) throw new Error('QUALIFICATION_ADMIN_PASSWORD must be explicitly injected');
  return password;
}

/** Caller must verify target ownership before running; presence is not authorization. */
export function qualificationMysqlTarget() {
  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} must be explicitly injected`);
    return value;
  };
  const host = required('QUALIFICATION_MYSQL_HOST');
  const rawPort = required('QUALIFICATION_MYSQL_PORT');
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
    throw new Error('QUALIFICATION_MYSQL_PORT must be an integer from 1 to 65535');
  }
  const username = required('QUALIFICATION_MYSQL_USER');
  const database_name = required('QUALIFICATION_MYSQL_DATABASE');
  const password = process.env.QUALIFICATION_MYSQL_PASSWORD;
  // Explicit empty passwords support owned passwordless fixtures; absent is refused.
  if (password === undefined) throw new Error('QUALIFICATION_MYSQL_PASSWORD must be explicitly injected');
  return { host, port: Number(rawPort), username, database_name, password };
}
