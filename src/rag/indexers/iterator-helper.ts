export async function collectAsyncIterator<T>(iterator: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of iterator) {
    results.push(item);
  }
  return results;
}
