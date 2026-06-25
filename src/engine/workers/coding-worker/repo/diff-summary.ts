export interface CodingDiffSummary {
  changedFileCount: number;
  changedFiles: string[];
  summary: string;
}

export function createCodingDiffSummary(changedFiles: string[]): CodingDiffSummary {
  const files = [...new Set(changedFiles)].sort();

  return {
    changedFileCount: files.length,
    changedFiles: files,
    summary: files.length === 0 ? 'No file changes detected.' : `${files.length} file(s) changed: ${files.join(', ')}`,
  };
}

