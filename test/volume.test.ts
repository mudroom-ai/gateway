import { describe, expect, it } from "vitest";
import { mountFsType } from "../src/server.js";

// Trimmed /proc/self/mountinfo lines: container root on overlay, a volume at /data.
const root = "1 0 0:1 / / rw,relatime - overlay overlay rw,lowerdir=/x";
const data = "2 1 8:1 /vol /data rw,relatime - ext4 /dev/sda1 rw";

describe("mountFsType", () => {
  it("sees a missing volume as the overlay root", () => {
    expect(mountFsType(root, "/data")).toBe("overlay");
  });

  it("picks the volume mounted at /data", () => {
    expect(mountFsType(`${root}\n${data}`, "/data")).toBe("ext4");
  });

  it("doesn't treat /database as inside /data", () => {
    expect(mountFsType(`${root}\n${data}`, "/database")).toBe("overlay");
  });
});
