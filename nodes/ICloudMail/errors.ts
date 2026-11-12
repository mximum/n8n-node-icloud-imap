/** Native Error with item context; deliberately no runtime import from n8n-workflow. */
export function executionError(cause: unknown, itemIndex?: number): Error {
  const original = cause instanceof Error ? cause : new Error(String(cause));
  return Object.assign(new Error(original.message, { cause: original }), {
    context: itemIndex === undefined ? {} : { itemIndex },
  });
}
