import { describe, expect, it } from "vitest";
import { deriveProjectKey } from "../src/pathKey.js";

describe("deriveProjectKey", () => {
  it("converts a Windows path to a WSL-style key with a lower-case drive", () => {
    expect(deriveProjectKey("D:\\mcp\\api")).toBe("_mnt_d_mcp_api");
  });

  it("normalizes mixed slashes in a Windows path", () => {
    expect(deriveProjectKey("C:/work\\front-end")).toBe("_mnt_c_work_front-end");
  });

  it("converts a POSIX path by replacing separators", () => {
    expect(deriveProjectKey("/home/user/projects/web")).toBe("_home_user_projects_web");
  });

  it("preserves non-separator characters", () => {
    expect(deriveProjectKey("D:\\My Projects\\api.v1")).toBe("_mnt_d_My Projects_api.v1");
  });
});
