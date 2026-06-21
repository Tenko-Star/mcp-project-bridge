import { describe, expect, it } from "vitest";
import { parseGitRemote } from "../src/remoteKey.js";

describe("parseGitRemote", () => {
  it("normalizes HTTPS remotes to lower-case canonical keys", () => {
    expect(parseGitRemote("https://github.com/Org/Repo.git")).toEqual({
      key: "github.com/org/repo",
      remote: "https://github.com/Org/Repo.git"
    });
  });

  it("normalizes SSH URL remotes", () => {
    expect(parseGitRemote("ssh://git@GitLab.EXAMPLE.com/Platform/API.git").key).toBe("gitlab.example.com/platform/api");
  });

  it("normalizes scp-like SSH remotes", () => {
    expect(parseGitRemote("git@github.com:OpenAI/Codex.git").key).toBe("github.com/openai/codex");
  });

  it("preserves multi-level namespaces", () => {
    expect(parseGitRemote("https://git.example.com/Team/SubTeam/Service.git").key).toBe("git.example.com/team/subteam/service");
  });

  it("rejects remotes without a namespace and project", () => {
    expect(() => parseGitRemote("https://github.com/openai")).toThrowError(/namespace and project/);
  });
});
