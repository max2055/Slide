/** The auxiliary operator runner owns ONE lifecycle for the complete reviewed
 * stage. A phase must never stop the source container or restore configuration.
 * inspect must revalidate the current allocation/head/container and discover its
 * dynamic port; do not capture an old common.ts environment in a phase closure. */
export async function runSourceStage<T>(stage: {
  inspect: () => Promise<T>;
  phases: readonly ((binding: T) => Promise<unknown>)[];
  restore: () => Promise<void>;
  close: () => Promise<void>;
  stop: () => Promise<void>;
}): Promise<void> {
  const errors: unknown[] = [];
  try {
    for (const phase of stage.phases) await phase(await stage.inspect());
  } catch (error) { errors.push(error); }
  finally {
    // Each independent cleanup is attempted even when an earlier one fails.
    for (const cleanup of [stage.restore, stage.close, stage.stop]) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
  }
  if (errors.length) throw new AggregateError(errors, 'V23_SOURCE_STAGE_REQUIRES_AUDIT_NO_REPLAY');
}
