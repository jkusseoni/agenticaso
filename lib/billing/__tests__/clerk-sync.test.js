import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { syncClerkPaidFlag } from "../subscription.js";

describe("Clerk paid metadata synchronization", () => {
  it("updates paid flag and preserves other metadata", async () => {
    const updates = [];
    const client = {
      users: {
        getUser: async () => ({
          publicMetadata: { paid: false, role: "owner" },
        }),
        updateUserMetadata: async (id, data) => {
          updates.push({ id, data });
        },
      },
    };

    await syncClerkPaidFlag("user_1", true, { client });

    assert.deepEqual(updates, [{
      id: "user_1",
      data: {
        publicMetadata: { paid: true, role: "owner" },
      },
    }]);
  });

  it("does not update when paid flag already matches", async () => {
    let updates = 0;
    const client = {
      users: {
        getUser: async () => ({
          publicMetadata: { paid: true },
        }),
        updateUserMetadata: async () => {
          updates++;
        },
      },
    };

    await syncClerkPaidFlag("user_1", true, { client });
    assert.equal(updates, 0);
  });

  it("handles Clerk API failure without throwing", async () => {
    const originalError = console.error;
    const errors = [];

    console.error = (...args) => errors.push(args);

    try {
      const client = {
        users: {
          getUser: async () => {
            throw new Error("Mock Clerk failure");
          },
        },
      };

      await assert.doesNotReject(
        syncClerkPaidFlag("user_1", true, { client })
      );

      assert.equal(errors.length, 1);
      assert.match(String(errors[0][1]), /Mock Clerk failure/);
    } finally {
      console.error = originalError;
    }
  });

  it("skips synchronization when user ID is missing", async () => {
    let calls = 0;
    const client = {
      users: {
        getUser: async () => {
          calls++;
        },
      },
    };

    await syncClerkPaidFlag(null, true, { client });
    assert.equal(calls, 0);
  });
});