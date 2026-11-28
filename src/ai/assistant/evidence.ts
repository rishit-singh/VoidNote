/**
 * Tool services retain complete source lineage for publication. The model needs
 * that same lineage only once, alongside the evidence, not at every nesting level.
 * Preserve IDs/revisions/audio anchors so later tool arguments remain lossless.
 */
export function assistantModelEvidence(output: unknown): unknown {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return output;
  }

  const envelope = output as Record<string, unknown>;

  if (!Array.isArray(envelope.sources)) {
    return output;
  }

  const sourceKeys = new Set(envelope.sources.map((source) => JSON.stringify(source)));

  const withoutNestedSources = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(withoutNestedSources);
    }

    if (!value || typeof value !== "object") {
      return value;
    }

    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key, child]) =>
            key !== "sources" ||
            !Array.isArray(child) ||
            !child.every((source) => sourceKeys.has(JSON.stringify(source))),
        )
        .map(([key, child]) => [key, withoutNestedSources(child)]),
    );
  };

  return {
    ...envelope,
    data: withoutNestedSources(envelope.data),
  };
}
