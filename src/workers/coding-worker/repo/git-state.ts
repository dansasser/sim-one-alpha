export interface CodingGitState {
  branch: string;
  isDirty: boolean;
  changedFiles: string[];
}

export function parseGitStatusShort(output: string, branch = 'unknown'): CodingGitState {
  const changedFiles = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('##'))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);

  return {
    branch,
    isDirty: changedFiles.length > 0,
    changedFiles,
  };
}

