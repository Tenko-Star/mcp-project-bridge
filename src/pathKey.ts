const windowsDrivePathPattern = /^([a-zA-Z]):([\\/].*)$/;

export function normalizeProjectPathForKey(projectPath: string): string {
  const trimmedPath = projectPath.trim();

  if (trimmedPath.length === 0) {
    throw new Error("Project path must not be empty.");
  }

  const windowsMatch = windowsDrivePathPattern.exec(trimmedPath);
  if (windowsMatch) {
    const drive = windowsMatch[1].toLowerCase();
    const rest = windowsMatch[2].replace(/\\/g, "/");
    return `/mnt/${drive}${rest.startsWith("/") ? rest : `/${rest}`}`;
  }

  return trimmedPath;
}

export function deriveProjectKey(projectPath: string): string {
  return normalizeProjectPathForKey(projectPath).replace(/[\\/]/g, "_");
}
