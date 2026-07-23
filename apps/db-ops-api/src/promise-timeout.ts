export function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
  onLateResult?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error(message));
    }, timeoutMs);

    operation.then(
      (value) => {
        if (settled) {
          onLateResult?.(value);
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
