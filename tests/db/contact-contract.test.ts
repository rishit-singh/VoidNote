import assert from "node:assert/strict";
import { test } from "node:test";

import { contactFieldsSchema } from "../../src/contracts/contacts";

void test("contact links reject executable URLs and embedded credentials", () => {
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,x",
    "https://user:secret@example.com",
  ]) {
    assert.equal(
      contactFieldsSchema.safeParse({
        organization: "",
        role: "",
        links: [{ label: "Profile", url }],
      }).success,
      false,
    );
  }

  assert.equal(
    contactFieldsSchema.safeParse({
      organization: "Example",
      role: "Engineer",
      links: [{ label: "Website", url: "https://example.com/profile" }],
    }).success,
    true,
  );
});
