export function shouldRenderLoginGate(connected: boolean, authToken: string | null): boolean {
  return !connected && !authToken?.trim();
}
