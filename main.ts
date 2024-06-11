import { parseArgs } from "node:util";
import { assert } from "@std/assert/assert";
import { compile } from "npm:json-schema-to-typescript";

// 引数のパース
const parsed = parseArgs({
  args: Deno.args,
  options: {
    url: {
      type: "string",
    },
  },
});

// deno-lint-ignore ban-types
type Object = {};

const isObject = (val: unknown): val is Object => {
  return val !== null && typeof val === "object" && !Array.isArray(val);
};

const isUrl = (val: unknown): val is string => {
  if (typeof val !== "string") return false;
  try {
    new URL(val);
    return true;
  } catch {
    return false;
  }
};

type ProfileEndpointJson = {
  _links: Record<string, {
    href: string;
  }>;
};

const isProfileEndpointJson = (val: unknown): val is ProfileEndpointJson => {
  if (
    !isObject(val) ||
    !("_links" in val) || val._links === null || !isObject(val._links)
  ) {
    return false;
  }

  // Explicitly cast `val` to `ProfileEndpointJson` to satisfy TypeScript's type checking
  const links = val._links as ProfileEndpointJson["_links"];

  for (const key in links) {
    const link = links[key]; // Now TypeScript knows `links` is a Record<string, { href: string }>
    if (typeof link.href !== "string") {
      return false;
    }
  }

  return true;
};

type JSONSchema = Parameters<typeof compile>[0];

const isEachProfileEndpointJson = (
  val: unknown,
): val is JSONSchema => {
  if (
    !isObject(val) ||
    !("title" in val) || typeof val.title !== "string" ||
    !("properties" in val) || val.properties === null ||
    !isObject(val.properties) ||
    !("definitions" in val) ||
    !("type" in val) || val.type !== "object"
  ) {
    return false;
  }

  const properties = val.properties as JSONSchema["properties"];

  for (const key in properties) {
    const property = properties[key];
    if (
      typeof property.title !== "string" ||
      typeof property.readOnly !== "boolean" ||
      (property.type !== "string" && property.type !== "integer") ||
      (property.format && property.format !== "uri" &&
        property.format !== "date-time")
    ) {
      return false;
    }
  }

  return true;
};


const compiler = (val: JSONSchema[]) => {
  return val.map((v) =>
    compile(v, v.title ?? "Default", {
      additionalProperties: false,
    })
  );
};

if (import.meta.main) {
  const { values } = parsed;
  if (!values.url) {
    console.error("Url not specified");
    Deno.exit(1);
  }
  const { url } = values;
  if (!isUrl(url)) {
    console.error("Invalid URL format");
    Deno.exit(1);
  }
  // profileエンドポイントへのfetch
  console.log(`---- fetching to ${url}/profile ----`);
  const profile = `${url}/profile`;
  try {
    const res = await fetch(profile);
    if (!res.ok) {
      console.error("Fetch request failed");
      Deno.exit(1);
    }
    const json = await res.json();
    if (!isProfileEndpointJson(json)) {
      console.error("Schema error");
      Deno.exit(1);
    }
    // schema+json形式
    const requests = Object.entries(json._links).filter(([key]) =>
      key !== "self"
    )
      .map((
        [, { href }],
      ) => href).map((link) =>
        fetch(link, {
          headers: {
            accept: "application/schema+json",
          },
        })
      );

    const result = await Promise.all(requests);

    if (result.find((v) => !v.ok)) {
      console.error("Some requests failed");
      Deno.exit(1);
    }
    const jsons = await Promise.all(result.map((r) => r.json()));
    for (const json of jsons) {
      if (!isEachProfileEndpointJson(json)) {
        console.error("Schema error in profile endpoint");
        Deno.exit(1);
      }
    }
    const eachProfileEndpointJsons = jsons as JSONSchema[];
    const compiled = await Promise.all(compiler(eachProfileEndpointJsons));
    console.log(compiled[0]);
  } catch (e: unknown) {
    console.error(e);
    Deno.exit(1);
  }
}

Deno.test("isUrl", async (t) => {
  await t.step("localhost", () => {
    assert(isUrl("http://localhost"));
  });
  await t.step("https://example.com", () => {
    assert(isUrl("https://example.com"));
  });
  await t.step("invalid url", () => {
    assert(!isUrl("invalid_url"));
  });
  await t.step("numeric input", () => {
    assert(!isUrl(12345));
  });
  await t.step("object input", () => {
    assert(!isUrl({ key: "value" }));
  });
  await t.step("function input", () => {
    assert(!isUrl(() => {}));
  });
  await t.step("null input", () => {
    assert(!isUrl(null));
  });
});

Deno.test("isProfileEndpointJson", () => {
  const validJson = {
    _links: {
      self: {
        href: "https://example.com/self",
      },
      related: {
        href: "https://example.com/related",
      },
    },
  };

  const invalidJsonNoLinks = {
    data: {},
  };

  const invalidJsonMalformedLinks = {
    _links: {
      self: {
        href: 123,
      },
    },
  };

  const invalidJsonNullLinks = {
    _links: null,
  };

  assert(isProfileEndpointJson(validJson));
  assert(!isProfileEndpointJson(invalidJsonNoLinks));
  assert(!isProfileEndpointJson(invalidJsonMalformedLinks));
  assert(!isProfileEndpointJson(invalidJsonNullLinks));
  assert(!isProfileEndpointJson("string input"));
  assert(!isProfileEndpointJson(12345));
  assert(!isProfileEndpointJson(true));
  assert(!isProfileEndpointJson(null));
  assert(!isProfileEndpointJson(undefined));
});

Deno.test("isObject", () => {
  assert(isObject({}));
  assert(isObject({ key: "value" }));
  assert(isObject(new Date()));
  assert(isObject(new RegExp("test")));
  assert(!isObject(null));
  assert(!isObject([]));
  assert(!isObject("string"));
  assert(!isObject(123));
  assert(!isObject(true));
  assert(!isObject(undefined));
  assert(!isObject(() => {}));
});

Deno.test("isEachProfileEndpointJson", () => {
  const validJson = {
    title: "Profile",
    properties: {
      name: {
        title: "Name",
        readOnly: true,
        type: "string",
        format: "uri",
      },
      age: {
        title: "Age",
        readOnly: false,
        type: "integer",
      },
    },
    definitions: {},
    type: "object",
  };

  const invalidJsonNoTitle = {
    properties: {
      name: {
        title: "Name",
        readOnly: true,
        type: "string",
        format: "uri",
      },
      age: {
        title: "Age",
        readOnly: false,
        type: "integer",
      },
    },
    definitions: {},
    type: "object",
  };

  const invalidJsonMalformedProperties = {
    title: "Profile",
    properties: {
      name: {
        title: "Name",
        readOnly: true,
        type: "str",
        format: "uri",
      },
      age: {
        title: "Age",
        readOnly: false,
        type: "integer",
      },
    },
    definitions: {},
    type: "object",
  };

  const invalidJsonNullProperties = {
    title: "Profile",
    properties: null,
    definitions: {},
    type: "object",
  };

  assert(isEachProfileEndpointJson(validJson));
  assert(!isEachProfileEndpointJson(invalidJsonNoTitle));
  assert(!isEachProfileEndpointJson(invalidJsonMalformedProperties));
  assert(!isEachProfileEndpointJson(invalidJsonNullProperties));
  assert(!isEachProfileEndpointJson("string input"));
  assert(!isEachProfileEndpointJson(12345));
  assert(!isEachProfileEndpointJson(true));
  assert(!isEachProfileEndpointJson(null));
  assert(!isEachProfileEndpointJson(undefined));
});
