export interface CodingGitState {
  branch: string;
  isDirty: boolean;
  changedFiles: string[];
}

export function parseGitStatusShort(output: string, branch = 'unknown'): CodingGitState {
  const changedFiles = output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && !line.startsWith('##'))
    .map((line) => (line.length >= 3 ? line.slice(3).trim() : ''))
    .map((path) => {
      const renameIndex = path.indexOf(' -> ');
      return renameIndex >= 0 ? path.slice(renameIndex + 4).trim() : path;
    })
    .filter(Boolean);

  return {
    branch,
    isDirty: changedFiles.length > 0,
    changedFiles,
  };
}
