import assert from "node:assert/strict";
import test from "node:test";
import { fetchRobinscanHolders } from "./robinscan.js";

test("fetchRobinscanHolders paginates until total is reached", async () => {
  const token = "0x80db362eab104ec378e19d0a3dcd5e84bafd4ba3";
  let page = 0;

  const fetchImpl = async (url) => {
    page += 1;
    return {
      ok: true,
      async json() {
        if (page === 1) {
          return {
            status: "ok",
            total: 2,
            page: 1,
            pageSize: 25,
            items: [
              { holder: "0x1111111111111111111111111111111111111111", balance: "100" },
              { holder: "0x2222222222222222222222222222222222222222", balance: "200" },
            ],
          };
        }
        return { status: "ok", total: 2, page: 2, pageSize: 25, items: [] };
      },
    };
  };

  const result = await fetchRobinscanHolders(token, fetchImpl);
  assert.equal(result.totalCount, 2);
  assert.equal(result.holders.length, 2);
  assert.equal(result.holders[0].account, "0x1111111111111111111111111111111111111111");
});
