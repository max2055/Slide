/** Probe work is bounded and single-flight even when the database driver stalls. */
export class InfrastructureReadiness {
  private pending?: Promise<boolean>;
  constructor(private readonly roleReady: () => boolean, private readonly check: () => Promise<boolean>, private readonly timeoutMs = 3_000) {}

  async ready(): Promise<boolean> {
    if (!this.roleReady()) return false;
    this.pending ??= Promise.resolve().then(this.check).catch(() => false).finally(() => { this.pending = undefined; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const available = await Promise.race([this.pending, new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), this.timeoutMs); })]);
      return available && this.roleReady();
    } finally { if (timer) clearTimeout(timer); }
  }
}
