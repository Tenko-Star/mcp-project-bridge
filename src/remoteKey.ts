export type ParsedGitRemote = {
  key: string;
  remote: string;
};

const scpLikeRemotePattern = /^(?:[^@\s]+@)?([^:\s/]+):(.+)$/;

export function parseGitRemote(remote: string): ParsedGitRemote {
  const trimmedRemote = remote.trim();

  if (trimmedRemote.length === 0) {
    throw new Error("Git remote is required.");
  }

  const parsed = parseUrlRemote(trimmedRemote) ?? parseScpLikeRemote(trimmedRemote);
  if (!parsed) {
    throw new Error(`Unsupported Git remote format: ${trimmedRemote}.`);
  }

  const normalizedPath = normalizeRemotePath(parsed.path);
  const parts = normalizedPath.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error("Git remote path must include a namespace and project.");
  }

  return {
    key: `${parsed.host}/${parts.join("/")}`.toLowerCase(),
    remote: trimmedRemote
  };
}

function parseUrlRemote(remote: string): { host: string; path: string } | undefined {
  try {
    const url = new URL(remote);
    if (!url.host || !url.pathname) {
      return undefined;
    }

    return {
      host: url.host,
      path: url.pathname
    };
  } catch {
    return undefined;
  }
}

function parseScpLikeRemote(remote: string): { host: string; path: string } | undefined {
  const match = scpLikeRemotePattern.exec(remote);
  if (!match) {
    return undefined;
  }

  return {
    host: match[1],
    path: match[2]
  };
}

function normalizeRemotePath(remotePath: string): string {
  let normalizedPath = remotePath.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");

  if (normalizedPath.toLowerCase().endsWith(".git")) {
    normalizedPath = normalizedPath.slice(0, -4);
  }

  return normalizedPath;
}
