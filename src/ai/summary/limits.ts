const summaryWordRatio = 0.75;

export function summaryWordCount(text: string): number {
  return text.match(/\S+/gu)?.length ?? 0;
}

export function summaryWordBudget(context: { passages: readonly { text: string }[] }) {
  const sourceWords = context.passages.reduce(
    (total, passage) => total + summaryWordCount(passage.text),
    0,
  );

  return { sourceWords, maxSummaryWords: Math.floor(sourceWords * summaryWordRatio) };
}
