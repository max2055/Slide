/** Match the password explicitly injected into qualification bootstrap. */
export function qualificationPassword(): string {
  const password = process.env.QUALIFICATION_ADMIN_PASSWORD;
  if (!password) throw new Error('QUALIFICATION_ADMIN_PASSWORD must be explicitly injected');
  return password;
}
